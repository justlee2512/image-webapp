const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const sharp = require('sharp');
const { ensureAdminBootstrap } = require('../src/admin');
const { ensureRateLimitSchema, PgRateLimiter } = require('../src/limits');
const { settleAll, trackPoolShutdown } = require('../test-support/async-cleanup');

test('security integration with PostgreSQL', { skip: !process.env.TEST_DATABASE_URL }, async (t) => {
  // Only a freshly created disposable database is modified; never use DATABASE_URL.
  const maintenance = new Pool({ connectionString: process.env.TEST_DATABASE_URL });
  const closeMaintenance = trackPoolShutdown(maintenance);
  const databaseName = `image_drive_test_${crypto.randomBytes(8).toString('hex')}`;
  let databaseCreated = false;
  let closePool;
  t.after(async () => {
    try {
      if (closePool) await closePool();
    } finally {
      try {
        // Never kill leftover connections: expose a cleanup bug instead.
        if (databaseCreated) await maintenance.query(`DROP DATABASE "${databaseName}"`);
      } finally { await closeMaintenance(); }
    }
  });
  await maintenance.query(`CREATE DATABASE "${databaseName}"`);
  databaseCreated = true;
  const databaseUrl = new URL(process.env.TEST_DATABASE_URL);
  databaseUrl.pathname = `/${databaseName}`;
  const pool = new Pool({ connectionString: databaseUrl.toString(), max: 10 });
  closePool = trackPoolShutdown(pool);
  await pool.query(await fs.readFile(require.resolve('../db/init.sql'), 'utf8'));
  const config = { ADMIN_USERNAME: 'owner', ADMIN_EMAIL: 'owner@example.com', ADMIN_PASSWORD: 'UniqueAdminPassword123!' };
  const oldDefaultHash = await bcrypt.hash('Admin@123456', 4);
  const secureHash = await bcrypt.hash(config.ADMIN_PASSWORD, 4);

  async function reset() {
    await pool.query('TRUNCATE image_drive.users, image_drive.account_requests, image_drive.sessions, image_drive.rate_limits CASCADE');
  }
  async function createUser(username = 'guest', passwordHash = secureHash) {
    return (await pool.query('INSERT INTO image_drive.users (username, email, password_hash) VALUES ($1, $2, $3) RETURNING *', [username, `${username}@example.com`, passwordHash])).rows[0];
  }

  await t.test('migrates a legacy admin, rotates the known default and revokes sessions', async () => {
    await pool.query('ALTER TABLE image_drive.users DROP COLUMN is_admin');
    const user = await createUser('owner', oldDefaultHash);
    await pool.query("INSERT INTO image_drive.sessions (sid, sess, expire) VALUES ('legacy', $1, CURRENT_TIMESTAMP + INTERVAL '1 hour')", [JSON.stringify({ user: { id: user.id, is_admin: true } })]);
    const admin = await ensureAdminBootstrap(pool, config);
    const stored = (await pool.query('SELECT * FROM image_drive.users WHERE id = $1', [user.id])).rows[0];
    assert.equal(admin.is_admin, true);
    assert.equal(stored.is_admin, true);
    assert.equal(await bcrypt.compare(config.ADMIN_PASSWORD, stored.password_hash), true);
    assert.equal(await bcrypt.compare('Admin@123456', stored.password_hash), false);
    assert.equal((await pool.query('SELECT * FROM image_drive.sessions')).rowCount, 0);
    assert.equal('password' in admin, false);
    assert.equal('password_hash' in admin, false);
  });

  await t.test('does not promote a matching name without verifying the existing password', async () => {
    await reset();
    const user = await createUser('owner', await bcrypt.hash('OtherSecurePassword123!', 4));
    await assert.rejects(ensureAdminBootstrap(pool, config), /mật khẩu hiện tại/);
    assert.equal((await pool.query('SELECT is_admin FROM image_drive.users WHERE id = $1', [user.id])).rows[0].is_admin, false);
    await assert.rejects(ensureAdminBootstrap(pool, { ...config, ADMIN_EMAIL: 'other@example.com' }), /định danh/);
  });

  await t.test('concurrent bootstrap creates one admin and preserves a changed secure password', async () => {
    await reset();
    const admins = await settleAll([ensureAdminBootstrap(pool, config), ensureAdminBootstrap(pool, config)]);
    assert.equal(admins[0].id, admins[1].id);
    const changedHash = await bcrypt.hash('ChangedSecurePassword123!', 4);
    await pool.query('UPDATE image_drive.users SET password_hash = $1 WHERE id = $2', [changedHash, admins[0].id]);
    await ensureAdminBootstrap(pool, config);
    assert.equal((await pool.query('SELECT password_hash FROM image_drive.users')).rows[0].password_hash, changedHash);
  });

  await t.test('rate limits concurrent requests across instances, IPs and rotated identities', async () => {
    await reset();
    await settleAll([ensureRateLimitSchema(pool), ensureRateLimitSchema(pool)]);
    const options = { pool, scope: 'test', windowMs: 60000, maxAttempts: 2, ipMaxAttempts: 3 };
    const a = new PgRateLimiter(options);
    const b = new PgRateLimiter(options);
    const results = await settleAll(Array.from({ length: 8 }, (_, index) => (index % 2 ? a : b).consume({ ip: `127.0.0.${index}` }, 'Guest')));
    assert.equal(results.filter((r) => r.allowed).length, 2);
    assert.ok(results.filter((r) => !r.allowed).every((r) => r.retryAfterSeconds > 0));
    await pool.query('DELETE FROM image_drive.rate_limits');
    const rotating = await settleAll(Array.from({ length: 8 }, (_, index) => a.consume({ ip: '127.0.0.1' }, `user${index}`)));
    assert.equal(rotating.filter((r) => r.allowed).length, 3);
    assert.equal((await pool.query('SELECT * FROM image_drive.rate_limits')).rowCount, 4);
  });

  await t.test('rate limit storage stays bounded and expired entries free capacity', async () => {
    await reset();
    const limiter = new PgRateLimiter({ pool, scope: 'bounded', windowMs: 60000, maxAttempts: 10, maxEntries: 4 });
    assert.equal((await limiter.consume({ ip: '1' }, 'one')).allowed, true);
    assert.equal((await limiter.consume({ ip: '2' }, 'two')).allowed, true);
    assert.equal((await limiter.consume({ ip: '3' }, 'three')).allowed, false);
    assert.equal((await pool.query('SELECT * FROM image_drive.rate_limits')).rowCount, 4);
    await pool.query("UPDATE image_drive.rate_limits SET reset_at = CURRENT_TIMESTAMP - INTERVAL '1 second'");
    assert.equal((await limiter.consume({ ip: '3' }, 'three')).allowed, true);
    assert.equal((await pool.query('SELECT * FROM image_drive.rate_limits')).rowCount, 2);
  });

  await t.test('HTTP registration, approval, stale sessions, CSRF and image upload', async (t) => {
    await reset();
    Object.assign(process.env, config, {
      NODE_ENV: 'test', DATABASE_URL: databaseUrl.toString(), SESSION_SECRET: 'integration-test-session-secret-32-characters',
      COOKIE_SECURE: 'false', TRUST_PROXY: 'false', MAX_ACCOUNTS: '3', MAX_PENDING_REQUESTS: '10',
      // Legacy quota settings must no longer restrict uploads.
      MAX_UPLOAD_FILES: '1', MAX_UPLOAD_TOTAL_MB: '1', REGISTER_RATE_LIMIT_MAX_ATTEMPTS: '5',
      REGISTER_RATE_LIMIT_WINDOW_MS: '3600000', LOGIN_RATE_LIMIT_MAX_ATTEMPTS: '10', LOGIN_RATE_LIMIT_IP_MAX_ATTEMPTS: '100'
    });
    const admin = await ensureAdminBootstrap(pool, config);
    const { app } = require('../src/server');
    const appPool = require('../src/db');
    const closeAppPool = trackPoolShutdown(appPool);
    const server = app.listen(0, '127.0.0.1');
    t.after(async () => {
      try {
        if (server.listening) await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      } finally { await closeAppPool(); }
    });
    await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
    const base = `http://127.0.0.1:${server.address().port}`;
    function browser() {
      let cookie = '';
      let csrf = '';
      return {
        async request(path, options = {}) {
          const headers = { ...options.headers };
          if (cookie) headers.Cookie = cookie;
          if (options.form) {
            options.body = new URLSearchParams({ _csrf: csrf, ...options.form });
            headers['Content-Type'] = 'application/x-www-form-urlencoded';
          }
          const response = await fetch(`${base}${path}`, { ...options, headers, redirect: 'manual' });
          const setCookie = response.headers.get('set-cookie');
          if (setCookie) cookie = setCookie.split(';')[0];
          const body = await response.text();
          const token = body.match(/name="_csrf" value="([^"]+)"/);
          if (token) csrf = token[1];
          return { status: response.status, body, headers: response.headers };
        },
        async upload(data) {
          const form = new FormData();
          form.append('folderId', '');
          form.append('_csrf', csrf);
          form.append('image', new Blob([data], { type: 'image/png' }), 'test.png');
          return this.request('/images', { method: 'POST', body: form, headers: { 'X-CSRF-Token': csrf, 'X-Upload-Queue': 'sequential' } });
        }
      };
    }
    const publicUser = browser();
    assert.equal((await publicUser.request('/register')).status, 200);
    // More pending requests than available accounts must still be accepted.
    for (const username of ['admin', 'guestone', 'guesttwo', 'guestthree', 'guestfour']) {
      const result = await publicUser.request('/register', { method: 'POST', form: { username, email: `${username}@example.com`, password: config.ADMIN_PASSWORD, passwordConfirm: config.ADMIN_PASSWORD } });
      assert.equal(result.status, 200, result.body);
    }
    const blocked = await publicUser.request('/register', { method: 'POST', form: { username: 'guestsix', email: 'six@example.com', password: config.ADMIN_PASSWORD, passwordConfirm: config.ADMIN_PASSWORD } });
    assert.equal(blocked.status, 429);
    assert.ok(Number(blocked.headers.get('retry-after')) > 0);
    await pool.query("UPDATE image_drive.account_requests SET created_at = CURRENT_TIMESTAMP - INTERVAL '2 days' WHERE username = 'guestfour'");
    const expired = (await pool.query("SELECT id FROM image_drive.account_requests WHERE username = 'guestfour'")).rows[0];
    const owner = browser();
    await owner.request('/login');
    assert.equal((await owner.request('/login', { method: 'POST', form: { identity: 'owner', password: config.ADMIN_PASSWORD } })).status, 302);
    const adminPage = await owner.request('/admin/users');
    assert.equal(adminPage.status, 200);
    assert.equal(adminPage.body.includes('guestfour'), false);
    await owner.request(`/admin/account-requests/${expired.id}/approve`, { method: 'POST', form: {} });
    assert.equal((await pool.query("SELECT id FROM image_drive.users WHERE username = 'guestfour'")).rowCount, 0);
    const request = (await pool.query("SELECT id FROM image_drive.account_requests WHERE username = 'admin'")).rows[0];
    assert.equal((await owner.request(`/admin/account-requests/${request.id}/approve`, { method: 'POST', form: {} })).status, 302);
    const ordinary = (await pool.query("SELECT * FROM image_drive.users WHERE username = 'admin'")).rows[0];
    assert.equal(ordinary.is_admin, false);
    const guest = browser();
    await guest.request('/login');
    assert.equal((await guest.request('/login', { method: 'POST', form: { identity: 'admin', password: config.ADMIN_PASSWORD } })).status, 302);
    assert.equal((await guest.request('/drive')).status, 200);
    assert.equal((await guest.request('/admin/users')).status, 403);
    await pool.query("UPDATE image_drive.sessions SET sess = jsonb_set(sess, '{user,is_admin}', 'true') WHERE sess #>> '{user,id}' = $1", [ordinary.id]);
    assert.equal((await guest.request('/admin/users')).status, 403);
    assert.equal((await guest.request('/folders', { method: 'POST', form: { _csrf: 'é'.repeat(43), name: 'invalid' } })).status, 403);
    // Model an existing library above both former quotas without allocating 1 GB in tests.
    await pool.query(
      `INSERT INTO image_drive.images (id, user_id, original_name, mime_type, size_bytes, image_data, thumbnail_data)
       SELECT gen_random_uuid(), $1, 'existing.png', 'image/png', $2, $3, $3 FROM generate_series(1, 51)`,
      [ordinary.id, 30 * 1024 * 1024, Buffer.from([0])]
    );
    const png = await sharp({ create: { width: 16, height: 16, channels: 3, background: '#ffffff' } }).png().toBuffer();
    const uploaded = await guest.upload(png);
    assert.equal(uploaded.status, 200, uploaded.body);
    const secondUpload = await guest.upload(png);
    assert.equal(secondUpload.status, 200, secondUpload.body);
    assert.equal((await pool.query('SELECT COUNT(*)::int AS total FROM image_drive.images WHERE user_id = $1', [ordinary.id])).rows[0].total, 53);
    const stored = (await pool.query("SELECT * FROM image_drive.images WHERE user_id = $1 AND original_name = 'test.png'", [ordinary.id])).rows[0];
    assert.ok(stored.image_data.equals(png));
    assert.equal((await sharp(stored.thumbnail_data).metadata()).format, 'webp');
    // Fill the separate pending queue, then verify expiration releases its capacity.
    for (let i = 0; i < 7; i += 1) {
      await pool.query('INSERT INTO image_drive.account_requests (id, username, email, password_hash) VALUES ($1, $2, $3, $4)', [crypto.randomUUID(), `queued${i}`, `queued${i}@example.com`, secureHash]);
    }
    await pool.query('DELETE FROM image_drive.rate_limits');
    const registration = { username: 'guestfour', email: 'guestfour@example.com', password: config.ADMIN_PASSWORD, passwordConfirm: config.ADMIN_PASSWORD };
    const queueFull = await publicUser.request('/register', { method: 'POST', form: registration });
    assert.equal(queueFull.status, 429);
    assert.match(queueFull.body, /Danh sách chờ/);
    await pool.query("UPDATE image_drive.account_requests SET created_at = CURRENT_TIMESTAMP - INTERVAL '2 days'");
    assert.equal((await publicUser.request('/register', { method: 'POST', form: registration })).status, 200);
    const remaining = await pool.query('SELECT * FROM image_drive.account_requests');
    assert.equal(remaining.rowCount, 1);
    await owner.request(`/admin/account-requests/${remaining.rows[0].id}/approve`, { method: 'POST', form: {} });
    assert.equal((await pool.query('SELECT * FROM image_drive.users')).rowCount, 3);
    assert.equal((await publicUser.request('/register', { method: 'POST', form: { ...registration, username: 'another', email: 'another@example.com' } })).status, 403);
    // A database outage in the limiter must never fall through to authentication.
    await pool.query('ALTER TABLE image_drive.rate_limits RENAME TO unavailable_rate_limits');
    const log = t.mock.method(console, 'error', () => {});
    try {
      const result = await owner.request('/login', { method: 'POST', form: { identity: 'owner', password: config.ADMIN_PASSWORD } });
      assert.equal(result.status, 503);
    } finally {
      log.mock.restore();
      await pool.query('ALTER TABLE image_drive.unavailable_rate_limits RENAME TO rate_limits');
    }
    const beforePoll = (await pool.query("SELECT expire::text FROM image_drive.sessions WHERE sess #>> '{user,id}' = $1", [ordinary.id])).rows[0].expire;
    const status = await guest.request('/session-status');
    assert.equal(status.status, 200);
    assert.equal(JSON.parse(status.body).active, true);
    assert.equal(status.headers.get('set-cookie'), null);
    const afterPoll = (await pool.query("SELECT expire::text FROM image_drive.sessions WHERE sess #>> '{user,id}' = $1", [ordinary.id])).rows[0].expire;
    assert.equal(afterPoll, beforePoll, 'background polling must not extend session lifetime');
    await pool.query("UPDATE image_drive.sessions SET expire = CURRENT_TIMESTAMP - INTERVAL '1 second' WHERE sess #>> '{user,id}' = $1", [ordinary.id]);
    assert.equal((await guest.request('/session-status')).status, 401);
    const expiredDownload = await guest.request(`/images/${stored.id}/download`, { headers: { 'X-Requested-With': 'XMLHttpRequest' } });
    assert.equal(expiredDownload.status, 401);
    assert.equal(JSON.parse(expiredDownload.body).redirectTo, '/login');
    const expiredPage = await guest.request('/drive');
    assert.equal(expiredPage.status, 401);
    assert.match(expiredPage.body, /Continue/);
    assert.equal(expiredPage.headers.get('location'), null);
    const expiredPost = await guest.request('/folders', { method: 'POST', form: { name: 'expired-folder' } });
    assert.equal(expiredPost.status, 401);
    assert.match(expiredPost.body, /Continue/);
    assert.equal((await pool.query("SELECT id FROM image_drive.folders WHERE name = 'expired-folder'")).rowCount, 0);
    assert.equal((await guest.request('/login')).status, 200);
    await pool.query('UPDATE image_drive.users SET is_admin = FALSE WHERE id = $1', [admin.id]);
    assert.equal((await owner.request('/admin/users')).status, 403);
  });
});
