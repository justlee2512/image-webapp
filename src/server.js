require('dotenv').config();

const crypto = require('crypto');
const path = require('path');
const express = require('express');
const session = require('express-session');
const helmet = require('helmet');
const multer = require('multer');
const bcrypt = require('bcryptjs');
const archiver = require('archiver');
const sharp = require('sharp');
const pool = require('./db');
const PgSessionStore = require('./pg-session-store');
const { ensureAdminBootstrap, isAdminUser, validateAccountInput, validatePasswordChangeInput } = require('./admin');
const { getAssetVersion, applyCacheHeaders } = require('./cache');
const { setFlash, clearFlash } = require('./flash');
const { ensureCsrfToken, csrfProtection, sendSessionExpired } = require('./security');
const { positiveInteger, ensureRateLimitSchema, PgRateLimiter } = require('./limits');

sharp.cache(false);
sharp.concurrency(1);

const app = express();
const port = Number(process.env.PORT || 3000);
const maxAccounts = positiveInteger(process.env.MAX_ACCOUNTS, 5, 'MAX_ACCOUNTS');
const maxPendingRequests = positiveInteger(process.env.MAX_PENDING_REQUESTS, 100, 'MAX_PENDING_REQUESTS');
const accountRequestTtlMs = positiveInteger(process.env.ACCOUNT_REQUEST_TTL_MS, 86400000, 'ACCOUNT_REQUEST_TTL_MS');
const maxFileSizeMb = positiveInteger(process.env.MAX_FILE_SIZE_MB, 30, 'MAX_FILE_SIZE_MB');
const sessionTtlMs = Number(process.env.SESSION_IDLE_TIMEOUT_MS || process.env.SESSION_TTL_MS || 1000 * 60 * 15);

if (process.env.NODE_ENV === 'production' && (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 32)) {
  throw new Error('SESSION_SECRET phải được cấu hình giống nhau trên tất cả pod và dài ít nhất 32 ký tự.');
}
class Semaphore {
  constructor(limit) { this.limit = limit; this.active = 0; this.waiters = []; }
  acquire() {
    return new Promise((resolve) => {
      const enter = () => {
        this.active += 1;
        let released = false;
        resolve(() => {
          if (released) return;
          released = true;
          this.active -= 1;
          const next = this.waiters.shift();
          if (next) next();
        });
      };
      if (this.active < this.limit) enter(); else this.waiters.push(enter);
    });
  }
}

const uploadQueue = new Semaphore(Number(process.env.MAX_CONCURRENT_UPLOADS || 1));
const downloadQueue = new Semaphore(Number(process.env.MAX_CONCURRENT_DOWNLOADS || 2));

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '..', 'views'));
app.locals.assetVersion = getAssetVersion(process.env);
if (process.env.TRUST_PROXY === 'true') app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      scriptSrcAttr: ["'unsafe-inline'"],
      styleSrc: ["'self'"],
      imgSrc: ["'self'", 'blob:', 'data:'],
      connectSrc: ["'self'"],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      frameAncestors: ["'none'"],
      formAction: ["'self'"]
    }
  },
  crossOriginResourcePolicy: { policy: 'same-origin' }
}));
app.use(express.urlencoded({ extended: false }));
app.use(applyCacheHeaders);
app.use(express.static(path.join(__dirname, '..', 'public'), { etag: true, maxAge: 0 }));
const sessionStore = new PgSessionStore({ pool, ttlMs: sessionTtlMs });
app.use(session({
  secret: process.env.SESSION_SECRET || 'development-only-secret',
  store: sessionStore,
  resave: false,
  saveUninitialized: false,
  rolling: true,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.COOKIE_SECURE === 'true',
    maxAge: sessionTtlMs
  }
}));
// Reading status must not roll the cookie or touch/extend the server-side session.
app.get('/session-status', async (req, res) => {
  const user = req.session?.user;
  const sid = req.sessionID;
  req.session = undefined;
  if (!user) return res.status(401).json({ active: false });
  try {
    const result = await pool.query(
      `SELECT EXTRACT(EPOCH FROM (expire - clock_timestamp())) * 1000 AS remaining_ms
         FROM image_drive.sessions WHERE sid = $1 AND expire > clock_timestamp()`, [sid]
    );
    if (!result.rowCount) return res.status(401).json({ active: false });
    return res.json({ active: true, remainingMs: Math.max(0, Number(result.rows[0].remaining_ms)) });
  } catch (error) {
    console.error(error);
    return res.status(503).json({ message: 'Không thể kiểm tra phiên đăng nhập.' });
  }
});
app.use(ensureCsrfToken);
app.use(csrfProtection);

const loginLimiter = new PgRateLimiter({
  pool, scope: 'login',
  windowMs: process.env.LOGIN_RATE_LIMIT_WINDOW_MS ?? 15 * 60 * 1000,
  maxAttempts: process.env.LOGIN_RATE_LIMIT_MAX_ATTEMPTS ?? 10,
  ipMaxAttempts: process.env.LOGIN_RATE_LIMIT_IP_MAX_ATTEMPTS ?? 100
});
const registrationLimiter = new PgRateLimiter({
  pool, scope: 'register',
  windowMs: process.env.REGISTER_RATE_LIMIT_WINDOW_MS ?? 60 * 60 * 1000,
  maxAttempts: process.env.REGISTER_RATE_LIMIT_MAX_ATTEMPTS ?? 5
});

function limitAuthRequests(limiter, view) {
  return async (req, res, next) => {
    try {
      const limit = await limiter.consume(req, view === 'login' ? req.body?.identity || '' : undefined);
      if (limit.allowed) return next();
      res.set('Retry-After', String(limit.retryAfterSeconds));
      return renderAuth(res, view, { status: 429, error: 'Bạn đã gửi quá nhiều yêu cầu. Vui lòng thử lại sau.' });
    } catch (error) {
      console.error(error);
      return renderAuth(res, view, { status: 503, error: 'Không thể xử lý yêu cầu lúc này.' });
    }
  };
}

function establishSession(req, user) {
  return new Promise((resolve, reject) => {
    req.session.regenerate((error) => {
      if (error) return reject(error);
      req.session.user = user;
      req.session.csrfToken = crypto.randomBytes(32).toString('base64url');
      req.session.save((saveError) => saveError ? reject(saveError) : resolve());
    });
  });
}

const upload = multer({
  storage: multer.memoryStorage(),
  // Busboy emits partsLimit at the threshold; three valid parts need a threshold of four.
  limits: { fileSize: maxFileSizeMb * 1024 * 1024, files: 1, fields: 2, parts: 4, fieldSize: 1024 },
  fileFilter: (_req, file, done) => {
    const allowed = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
    done(allowed.includes(file.mimetype) ? null : new Error('Chỉ hỗ trợ JPG, PNG, GIF và WebP.'), allowed.includes(file.mimetype));
  }
});

async function authRequired(req, res, next) {
  if (!req.session.user) return sendSessionExpired(req, res);
  try {
    // Never trust an old session's role; upgrades and role revocations apply immediately.
    const result = await pool.query('SELECT id, username, email, is_admin FROM image_drive.users WHERE id = $1', [req.session.user.id]);
    if (!result.rowCount) return req.session.destroy(() => sendSessionExpired(req, res));
    req.session.user = result.rows[0];
    next();
  } catch (error) { next(error); }
}

function renderAuth(res, view, values = {}) {
  const assetVersion = res.app.locals.assetVersion || getAssetVersion(process.env);
  res.status(values.status || 200).render(view, { error: values.error || null, success: values.success || null, form: values.form || {}, maxAccounts, assetVersion });
}

async function ensureAccountRequestsSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS image_drive.account_requests (
      id UUID PRIMARY KEY,
      username VARCHAR(30) NOT NULL UNIQUE,
      email VARCHAR(255) NOT NULL UNIQUE,
      password_hash VARCHAR(255) NOT NULL,
      created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
}

function driveUrl(folderId) {
  return folderId ? `/drive?folder=${encodeURIComponent(folderId)}` : '/drive';
}

function sendActionResponse(req, res, ok, message, redirectTo = '/drive') {
  if (req.get('X-Requested-With') === 'XMLHttpRequest') {
    return res.status(ok ? 200 : 400).json({ ok, message });
  }
  setFlash(req, ok ? 'success' : 'error', message);
  return res.redirect(redirectTo);
}

async function getFolderAccess(folderId, userId, isAdmin = false) {
  if (!folderId) return { isOwner: true, folder: null };
  const result = await pool.query(
    `SELECT f.id, f.name, f.owner_id, u.username AS owner_name,
            (f.owner_id = $2 OR $3) AS is_owner
       FROM image_drive.folders f
       JOIN image_drive.users u ON u.id = f.owner_id
      WHERE f.id = $1
        AND ($3 OR f.owner_id = $2 OR EXISTS (
          SELECT 1 FROM image_drive.folder_shares s WHERE s.folder_id = f.id AND s.user_id = $2
        ))`,
    [folderId, userId, isAdmin]
  );
  const folder = result.rows[0];
  return folder ? { isOwner: folder.is_owner, folder } : null;
}

app.get('/', (req, res) => res.redirect(req.session.user ? '/drive' : '/login'));
// Liveness chỉ kiểm tra tiến trình Node.js, không phụ thuộc PostgreSQL.
app.get('/live', (_req, res) => res.json({ status: 'ok' }));
app.get('/health', async (_req, res) => {
  try { await sessionStore.ready; await pool.query('SELECT 1'); res.json({ status: 'ok' }); }
  catch { res.status(503).json({ status: 'unavailable' }); }
});

app.get('/register', (_req, res) => renderAuth(res, 'register'));
app.post('/register', limitAuthRequests(registrationLimiter, 'register'), async (req, res) => {
  const username = String(req.body.username || '').trim();
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const passwordConfirm = String(req.body.passwordConfirm || '');
  const form = { username, email };
  const validation = validateAccountInput({ username, email, password, passwordConfirm });
  if (!validation.ok) return renderAuth(res, 'register', { status: 400, error: validation.error, form });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(hashtext('image_drive_account_limit'))");
    await client.query("DELETE FROM image_drive.account_requests WHERE created_at <= CURRENT_TIMESTAMP - $1 * INTERVAL '1 millisecond'", [accountRequestTtlMs]);
    const capacity = await client.query(`
      SELECT
        (SELECT COUNT(*) FROM image_drive.users)::int AS users,
        (SELECT COUNT(*) FROM image_drive.account_requests)::int AS requests
    `);
    if (capacity.rows[0].users >= maxAccounts) {
      await client.query('ROLLBACK');
      return renderAuth(res, 'register', { status: 403, error: `Hệ thống đã đủ ${maxAccounts} tài khoản.`, form });
    }
    if (capacity.rows[0].requests >= maxPendingRequests) {
      await client.query('COMMIT');
      return renderAuth(res, 'register', { status: 429, error: 'Danh sách chờ đang đầy. Vui lòng thử lại sau.', form });
    }
    const conflict = await client.query(
      `SELECT 1 FROM image_drive.users WHERE lower(username) = lower($1) OR lower(email) = lower($2)
       UNION ALL
       SELECT 1 FROM image_drive.account_requests WHERE lower(username) = lower($1) OR lower(email) = lower($2)
       LIMIT 1`,
      [username, email]
    );
    if (conflict.rowCount) {
      await client.query('ROLLBACK');
      return renderAuth(res, 'register', { status: 409, error: 'Tên tài khoản hoặc email đã được sử dụng hoặc đang chờ duyệt.', form });
    }
    const passwordHash = await bcrypt.hash(password, 12);
    await client.query(
      'INSERT INTO image_drive.account_requests (id, username, email, password_hash) VALUES ($1, $2, $3, $4)',
      [crypto.randomUUID(), username, email, passwordHash]
    );
    await client.query('COMMIT');
    return renderAuth(res, 'register', { success: 'Yêu cầu tạo tài khoản đã được gửi. Bạn có thể đăng nhập sau khi admin chấp thuận.' });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    if (error.code === '23505') return renderAuth(res, 'register', { status: 409, error: 'Tên tài khoản hoặc email đã được sử dụng hoặc đang chờ duyệt.', form });
    console.error(error);
    return renderAuth(res, 'register', { status: 500, error: 'Không thể gửi yêu cầu tạo tài khoản lúc này.', form });
  } finally { client.release(); }
});

app.get('/login', (_req, res) => renderAuth(res, 'login'));
app.post('/login', limitAuthRequests(loginLimiter, 'login'), async (req, res) => {
  const identity = String(req.body.identity || '').trim();
  const password = String(req.body.password || '');
  try {
    const result = await pool.query('SELECT id, username, email, password_hash, is_admin FROM image_drive.users WHERE lower(email) = lower($1) OR lower(username) = lower($1)', [identity]);
    const user = result.rows[0];
    if (!user || !(await bcrypt.compare(password, user.password_hash))) {
      return renderAuth(res, 'login', { status: 401, error: 'Thông tin đăng nhập không đúng.', form: { identity } });
    }
    await establishSession(req, { id: user.id, username: user.username, email: user.email, is_admin: isAdminUser(user) });
    res.redirect('/drive');
  } catch (error) { console.error(error); renderAuth(res, 'login', { status: 500, error: 'Không thể đăng nhập lúc này.' }); }
});

app.post('/logout', (req, res) => req.session.destroy(() => res.redirect('/login')));

app.get('/admin/users', authRequired, async (req, res) => {
  if (!isAdminUser(req.session.user)) return res.status(403).send('Bạn không có quyền quản trị.');
  try {
    const [usersResult, requestsResult] = await Promise.all([
      pool.query('SELECT id, username, email, created_at FROM image_drive.users ORDER BY username'),
      pool.query("SELECT id, username, email, created_at FROM image_drive.account_requests WHERE created_at > CURRENT_TIMESTAMP - $1 * INTERVAL '1 millisecond' ORDER BY created_at", [accountRequestTtlMs])
    ]);
    res.render('admin-users', { user: req.session.user, users: usersResult.rows, accountRequests: requestsResult.rows, error: req.session.error || null, success: req.session.success || null, maxAccounts });
    clearFlash(req);
  } catch (error) {
    console.error(error);
    res.status(500).send('Không thể tải danh sách tài khoản.');
  }
});

app.post('/admin/users', authRequired, async (req, res) => {
  if (!isAdminUser(req.session.user)) return res.status(403).send('Bạn không có quyền quản trị.');

  const validation = validateAccountInput(req.body, { maxAccounts, currentCount: await pool.query('SELECT COUNT(*)::int AS total FROM image_drive.users').then((r) => r.rows[0].total), isAdmin: true });
  if (!validation.ok) {
    setFlash(req, 'error', validation.error);
    return res.redirect('/admin/users');
  }

  const username = String(req.body.username || '').trim();
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  try {
    const passwordHash = await bcrypt.hash(password, 12);
    await pool.query('INSERT INTO image_drive.users (username, email, password_hash) VALUES ($1, $2, $3)', [username, email, passwordHash]);
    setFlash(req, 'success', `Đã tạo tài khoản ${username}.`);
  } catch (error) {
    setFlash(req, 'error', error.code === '23505' ? 'Tên tài khoản hoặc email đã được sử dụng.' : 'Không thể tạo tài khoản.');
  }
  res.redirect('/admin/users');
});

app.post('/admin/account-requests/:id/approve', authRequired, async (req, res) => {
  if (!isAdminUser(req.session.user)) return res.status(403).send('Bạn không có quyền quản trị.');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(hashtext('image_drive_account_limit'))");
    const count = await client.query('SELECT COUNT(*)::int AS total FROM image_drive.users');
    if (count.rows[0].total >= maxAccounts) {
      await client.query('ROLLBACK');
      setFlash(req, 'error', `Hệ thống đã đủ ${maxAccounts} tài khoản.`);
      return res.redirect('/admin/users');
    }
    const requestResult = await client.query(
      "SELECT id, username, email, password_hash FROM image_drive.account_requests WHERE id = $1 AND created_at > CURRENT_TIMESTAMP - $2 * INTERVAL '1 millisecond' FOR UPDATE",
      [req.params.id, accountRequestTtlMs]
    );
    const accountRequest = requestResult.rows[0];
    if (!accountRequest) {
      await client.query('ROLLBACK');
      setFlash(req, 'error', 'Không tìm thấy yêu cầu đăng ký.');
      return res.redirect('/admin/users');
    }
    const existingAccount = await client.query(
      'SELECT 1 FROM image_drive.users WHERE lower(username) = lower($1) OR lower(email) = lower($2) LIMIT 1',
      [accountRequest.username, accountRequest.email]
    );
    if (existingAccount.rowCount) {
      await client.query('ROLLBACK');
      setFlash(req, 'error', 'Tên tài khoản hoặc email đã tồn tại. Hãy từ chối yêu cầu trùng lặp này.');
      return res.redirect('/admin/users');
    }
    await client.query(
      'INSERT INTO image_drive.users (username, email, password_hash) VALUES ($1, $2, $3)',
      [accountRequest.username, accountRequest.email, accountRequest.password_hash]
    );
    await client.query('DELETE FROM image_drive.account_requests WHERE id = $1', [accountRequest.id]);
    await client.query('COMMIT');
    setFlash(req, 'success', `Đã chấp thuận tài khoản ${accountRequest.username}.`);
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    console.error(error);
    setFlash(req, 'error', error.code === '23505' ? 'Tên tài khoản hoặc email đã tồn tại.' : 'Không thể chấp thuận yêu cầu.');
  } finally {
    client.release();
  }
  return res.redirect('/admin/users');
});

app.post('/admin/account-requests/:id/reject', authRequired, async (req, res) => {
  if (!isAdminUser(req.session.user)) return res.status(403).send('Bạn không có quyền quản trị.');
  try {
    const result = await pool.query('DELETE FROM image_drive.account_requests WHERE id = $1 RETURNING username', [req.params.id]);
    setFlash(req, result.rowCount ? 'success' : 'error', result.rowCount ? `Đã từ chối yêu cầu của ${result.rows[0].username}.` : 'Không tìm thấy yêu cầu đăng ký.');
  } catch (error) {
    console.error(error);
    setFlash(req, 'error', 'Không thể từ chối yêu cầu.');
  }
  return res.redirect('/admin/users');
});

app.post('/admin/users/:id/delete', authRequired, async (req, res) => {
  if (!isAdminUser(req.session.user)) return res.status(403).send('Bạn không có quyền quản trị.');
  if (String(req.params.id) === String(req.session.user.id)) {
    setFlash(req, 'error', 'Bạn không thể tự xóa tài khoản của chính mình.');
    return res.redirect('/admin/users');
  }
  try {
    const result = await pool.query('DELETE FROM image_drive.users WHERE id = $1 RETURNING id', [req.params.id]);
    if (result.rowCount) await pool.query("DELETE FROM image_drive.sessions WHERE sess #>> '{user,id}' = $1", [String(req.params.id)]);
    setFlash(req, result.rowCount ? 'success' : 'error', result.rowCount ? 'Đã xóa tài khoản.' : 'Không tìm thấy tài khoản.');
  } catch (error) {
    console.error(error);
    setFlash(req, 'error', 'Không thể xóa tài khoản.');
  }
  res.redirect('/admin/users');
});

app.post('/admin/users/:id/reset-password', authRequired, async (req, res) => {
  if (!isAdminUser(req.session.user)) return res.status(403).send('Bạn không có quyền quản trị.');
  const newPassword = String(req.body.newPassword || '');
  const newPasswordConfirm = String(req.body.newPasswordConfirm || '');
  const validation = validatePasswordChangeInput({ newPassword, newPasswordConfirm });
  if (!validation.ok) {
    req.session.error = validation.error;
    return res.redirect('/admin/users');
  }
  try {
    const passwordHash = await bcrypt.hash(newPassword, 12);
    await pool.query('UPDATE image_drive.users SET password_hash = $1 WHERE id = $2', [passwordHash, req.params.id]);
    await pool.query("DELETE FROM image_drive.sessions WHERE sess #>> '{user,id}' = $1 AND sid <> $2", [String(req.params.id), req.sessionID]);
    setFlash(req, 'success', 'Đã đổi mật khẩu cho tài khoản.');
  } catch (error) {
    console.error(error);
    setFlash(req, 'error', 'Không thể đổi mật khẩu.');
  }
  res.redirect('/admin/users');
});

app.get('/drive', authRequired, async (req, res) => {
  try {
    const isAdmin = isAdminUser(req.session.user);
    const folderId = req.query.folder ? String(req.query.folder) : null;
    const access = await getFolderAccess(folderId, req.session.user.id, isAdmin);
    if (!access) return res.status(404).send('Folder không tồn tại hoặc chưa được chia sẻ cho bạn.');
    const [imagesResult, foldersResult, sharesResult] = await Promise.all([
      folderId
        ? pool.query('SELECT id, original_name, mime_type, size_bytes, created_at, user_id FROM image_drive.images WHERE folder_id = $1 ORDER BY created_at DESC', [folderId])
        : pool.query(
            isAdmin
              ? 'SELECT id, original_name, mime_type, size_bytes, created_at, user_id FROM image_drive.images WHERE folder_id IS NULL ORDER BY created_at DESC'
              : 'SELECT id, original_name, mime_type, size_bytes, created_at, user_id FROM image_drive.images WHERE user_id = $1 AND folder_id IS NULL ORDER BY created_at DESC',
            isAdmin ? [] : [req.session.user.id]
          ),
      pool.query(
        isAdmin
          ? `SELECT f.id, f.name, f.owner_id, u.username AS owner_name,
                    TRUE AS is_owner,
                    COUNT(i.id)::int AS image_count
               FROM image_drive.folders f
               JOIN image_drive.users u ON u.id = f.owner_id
               LEFT JOIN image_drive.images i ON i.folder_id = f.id
              GROUP BY f.id, u.username ORDER BY f.name`
          : `SELECT f.id, f.name, f.owner_id, u.username AS owner_name,
                    (f.owner_id = $1) AS is_owner,
                    COUNT(i.id)::int AS image_count
               FROM image_drive.folders f
               JOIN image_drive.users u ON u.id = f.owner_id
               LEFT JOIN image_drive.images i ON i.folder_id = f.id
              WHERE f.owner_id = $1 OR EXISTS (
                SELECT 1 FROM image_drive.folder_shares s WHERE s.folder_id = f.id AND s.user_id = $1
              )
              GROUP BY f.id, u.username ORDER BY is_owner DESC, f.name`,
        isAdmin ? [] : [req.session.user.id]
      ),
      folderId && access.isOwner
        ? pool.query('SELECT u.id, u.username, u.email FROM image_drive.folder_shares s JOIN image_drive.users u ON u.id = s.user_id WHERE s.folder_id = $1 ORDER BY u.username', [folderId])
        : Promise.resolve({ rows: [] })
    ]);
    res.render('drive', {
      user: req.session.user, images: imagesResult.rows, folders: foldersResult.rows,
      currentFolder: access.folder, isOwner: access.isOwner, sharedUsers: sharesResult.rows,
      error: req.session.error || null, success: req.session.success || null,
      maxFileSizeMb, isAdmin
    });
    clearFlash(req);
  } catch (error) { console.error(error); res.status(500).send('Không thể tải thư viện ảnh.'); }
});

app.post('/folders', authRequired, async (req, res) => {
  const name = String(req.body.name || '').trim();
  if (!name || name.length > 100) return sendActionResponse(req, res, false, 'Tên folder cần từ 1 đến 100 ký tự.');
  try {
    await pool.query('INSERT INTO image_drive.folders (id, owner_id, name) VALUES ($1, $2, $3)', [crypto.randomUUID(), req.session.user.id, name]);
    return sendActionResponse(req, res, true, 'Đã tạo folder mới.');
  } catch (error) {
    return sendActionResponse(req, res, false, error.code === '23505' ? 'Bạn đã có folder với tên này.' : 'Không thể tạo folder.');
  }
});

app.post('/folders/:id/delete', authRequired, async (req, res) => {
  const isAdmin = isAdminUser(req.session.user);
  const result = await pool.query('DELETE FROM image_drive.folders WHERE id = $1 AND ($2 OR owner_id = $3) RETURNING id', [req.params.id, isAdmin, req.session.user.id]);
  return sendActionResponse(req, res, result.rowCount > 0, result.rowCount ? 'Đã xóa folder và toàn bộ ảnh bên trong.' : 'Bạn không có quyền xóa folder này.');
});

app.post('/folders/:id/share', authRequired, async (req, res) => {
  const identity = String(req.body.identity || '').trim();
  const isAdmin = isAdminUser(req.session.user);
  try {
    const folder = await pool.query('SELECT id FROM image_drive.folders WHERE id = $1 AND ($2 OR owner_id = $3)', [req.params.id, isAdmin, req.session.user.id]);
    if (!folder.rowCount) throw new Error('NO_PERMISSION');
    const target = await pool.query('SELECT id FROM image_drive.users WHERE (lower(username) = lower($1) OR lower(email) = lower($1)) AND id <> $2', [identity, req.session.user.id]);
    if (!target.rowCount) return sendActionResponse(req, res, false, 'Không tìm thấy tài khoản để chia sẻ.', driveUrl(req.params.id));
    await pool.query('INSERT INTO image_drive.folder_shares (folder_id, user_id, shared_by) VALUES ($1, $2, $3) ON CONFLICT (folder_id, user_id) DO NOTHING', [req.params.id, target.rows[0].id, req.session.user.id]);
    return sendActionResponse(req, res, true, 'Đã chia sẻ folder.', driveUrl(req.params.id));
  } catch (error) { return sendActionResponse(req, res, false, error.message === 'NO_PERMISSION' ? 'Bạn không có quyền chia sẻ folder này.' : 'Không thể chia sẻ folder.', driveUrl(req.params.id)); }
});

app.post('/folders/:id/unshare', authRequired, async (req, res) => {
  const isAdmin = isAdminUser(req.session.user);
  await pool.query(
    'DELETE FROM image_drive.folder_shares s USING image_drive.folders f WHERE s.folder_id = f.id AND s.folder_id = $1 AND s.user_id = $2 AND ($3 OR f.owner_id = $4)',
    [req.params.id, req.body.userId, isAdmin, req.session.user.id]
  );
  return sendActionResponse(req, res, true, 'Đã thu hồi quyền chia sẻ.', driveUrl(req.params.id));
});

app.post('/images/move', authRequired, async (req, res) => {
  const ids = Array.isArray(req.body.imageIds) ? req.body.imageIds : req.body.imageIds ? [req.body.imageIds] : [];
  const targetFolderId = req.body.targetFolderId ? String(req.body.targetFolderId) : null;
  const currentFolderId = req.body.currentFolderId ? String(req.body.currentFolderId) : null;
  const wantsJson = req.get('X-Requested-With') === 'XMLHttpRequest';
  const isAdmin = isAdminUser(req.session.user);
  const finish = (ok, message) => wantsJson
    ? res.status(ok ? 200 : 400).json({ ok, message })
    : (() => { req.session[ok ? 'success' : 'error'] = message; return res.redirect(driveUrl(currentFolderId)); })();
  if (!ids.length || ids.length > 1000) return finish(false, 'Vui lòng chọn ảnh cần di chuyển.');
  try {
    if (targetFolderId) {
      const folder = await pool.query('SELECT id FROM image_drive.folders WHERE id = $1 AND ($2 OR owner_id = $3)', [targetFolderId, isAdmin, req.session.user.id]);
      if (!folder.rowCount) return finish(false, 'Bạn không có quyền chuyển ảnh vào folder này.');
    }
    const result = await pool.query('UPDATE image_drive.images SET folder_id = $1 WHERE id = ANY($2::uuid[]) AND ($3 OR user_id = $4) RETURNING id', [targetFolderId, ids, isAdmin, req.session.user.id]);
    return finish(true, `Đã chuyển ${result.rowCount} ảnh.`);
  } catch (error) { console.error(error); return finish(false, 'Không thể di chuyển ảnh.'); }
});

app.post('/images', authRequired, (req, res) => {
  uploadQueue.acquire().then((releaseUpload) => upload.fields([{ name: 'image', maxCount: 1 }, { name: 'images', maxCount: 1 }])(req, res, async (error) => {
    const isAdmin = isAdminUser(req.session.user);
    const folderId = req.body && req.body.folderId ? String(req.body.folderId) : null;
    const redirectTo = driveUrl(folderId);
    const uploadedFile = req.files && ((req.files.image && req.files.image[0]) || (req.files.images && req.files.images[0]));
    const isQueueUpload = req.get('X-Upload-Queue') === 'sequential';
    const finish = (ok, message) => {
      releaseUpload();
      if (isQueueUpload) return res.status(ok ? 200 : 400).json({ ok, message });
      req.session[ok ? 'success' : 'error'] = message;
      return res.redirect(redirectTo);
    };
    if (error) return finish(false, error.code === 'LIMIT_FILE_SIZE' ? `Mỗi ảnh không được lớn hơn ${maxFileSizeMb} MB.` : error.message);
    if (!uploadedFile) return finish(false, 'Server không nhận được dữ liệu ảnh. Vui lòng tải lại trang và chọn ảnh lần nữa.');
    try {
      const access = await getFolderAccess(folderId, req.session.user.id, isAdmin);
      if (!access || (!access.isOwner && !isAdmin)) return finish(false, 'Bạn không có quyền tải ảnh vào folder này.');
      const thumbnail = await sharp(uploadedFile.buffer, { failOn: 'none', animated: false })
        .rotate().resize({ width: 520, height: 390, fit: 'cover', withoutEnlargement: true })
        .webp({ quality: 72 }).toBuffer();
      await pool.query(
        'INSERT INTO image_drive.images (id, user_id, folder_id, original_name, mime_type, size_bytes, image_data, thumbnail_data) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
        [crypto.randomUUID(), req.session.user.id, folderId, uploadedFile.originalname.slice(0, 255), uploadedFile.mimetype, uploadedFile.size, uploadedFile.buffer, thumbnail]
      );
      return finish(true, 'Đã tải lên 1 ảnh.');
    } catch (dbError) {
      console.error(dbError); return finish(false, 'Không thể lưu ảnh.');
    }
  }));
});

app.get('/images/:id/thumbnail', authRequired, async (req, res) => {
  const release = await downloadQueue.acquire();
  const isAdmin = isAdminUser(req.session.user);
  try {
    let result = await pool.query(`SELECT i.thumbnail_data FROM image_drive.images i WHERE i.id = $1 AND ($3 OR i.user_id = $2 OR EXISTS (SELECT 1 FROM image_drive.folder_shares s WHERE s.folder_id = i.folder_id AND s.user_id = $2))`, [req.params.id, req.session.user.id, isAdmin]);
    if (!result.rows[0]) return res.sendStatus(404);
    let thumbnail = result.rows[0].thumbnail_data;
    if (!thumbnail) {
      result = await pool.query(`SELECT i.image_data FROM image_drive.images i WHERE i.id = $1 AND ($3 OR i.user_id = $2 OR EXISTS (SELECT 1 FROM image_drive.folder_shares s WHERE s.folder_id = i.folder_id AND s.user_id = $2))`, [req.params.id, req.session.user.id, isAdmin]);
      thumbnail = await sharp(result.rows[0].image_data, { failOn: 'none', animated: false }).rotate().resize({ width: 520, height: 390, fit: 'cover', withoutEnlargement: true }).webp({ quality: 72 }).toBuffer();
      await pool.query('UPDATE image_drive.images SET thumbnail_data = $1 WHERE id = $2 AND thumbnail_data IS NULL', [thumbnail, req.params.id]);
    }
    res.set({ 'Content-Type': 'image/webp', 'Cache-Control': 'private, max-age=86400' });
    res.send(thumbnail);
  } catch (error) { console.error(error); if (!res.headersSent) res.sendStatus(500); }
  finally { release(); }
});

app.get('/images/:id', authRequired, async (req, res) => {
  const release = await downloadQueue.acquire();
  const isAdmin = isAdminUser(req.session.user);
  res.once('finish', release);
  res.once('close', release);
  try {
    const result = await pool.query(`SELECT i.original_name, i.mime_type, i.image_data FROM image_drive.images i WHERE i.id = $1 AND ($3 OR i.user_id = $2 OR EXISTS (SELECT 1 FROM image_drive.folder_shares s WHERE s.folder_id = i.folder_id AND s.user_id = $2))`, [req.params.id, req.session.user.id, isAdmin]);
    if (!result.rows[0]) return res.sendStatus(404);
    res.set({ 'Content-Type': result.rows[0].mime_type, 'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(result.rows[0].original_name)}`, 'Cache-Control': 'private, max-age=3600' });
    res.send(result.rows[0].image_data);
  } catch (error) { console.error(error); if (!res.headersSent) res.sendStatus(500); }
});

app.get('/images/:id/download', authRequired, async (req, res) => {
  const release = await downloadQueue.acquire();
  const isAdmin = isAdminUser(req.session.user);
  res.once('finish', release);
  res.once('close', release);
  try {
    const result = await pool.query(
      `SELECT i.original_name, i.mime_type, i.size_bytes, i.image_data FROM image_drive.images i WHERE i.id = $1 AND ($3 OR i.user_id = $2 OR EXISTS (SELECT 1 FROM image_drive.folder_shares s WHERE s.folder_id = i.folder_id AND s.user_id = $2))`,
      [req.params.id, req.session.user.id, isAdmin]
    );
    const image = result.rows[0];
    if (!image) return res.sendStatus(404);
    res.set({
      'Content-Type': image.mime_type,
      'Content-Length': image.size_bytes,
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(image.original_name)}`,
      'Cache-Control': 'private, no-store'
    });
    res.send(image.image_data);
  } catch (error) {
    console.error(error);
    res.status(500).send('Không thể tải ảnh xuống.');
  }
});

app.post('/images/download-batch', authRequired, async (req, res) => {
  const ids = Array.isArray(req.body.imageIds) ? req.body.imageIds : req.body.imageIds ? [req.body.imageIds] : [];
  if (!ids.length || ids.length > 100) return res.status(400).send('Vui lòng chọn từ 1 đến 100 ảnh.');
  const isAdmin = isAdminUser(req.session.user);
  const release = await downloadQueue.acquire();
  res.once('finish', release);
  res.once('close', release);
  try {
    const result = await pool.query(
      `SELECT i.id, i.original_name FROM image_drive.images i
        WHERE i.id = ANY($1::uuid[]) AND ($3 OR i.user_id = $2 OR EXISTS (
          SELECT 1 FROM image_drive.folder_shares s WHERE s.folder_id = i.folder_id AND s.user_id = $2
        ))`,
      [ids, req.session.user.id, isAdmin]
    );
    if (!result.rowCount) return res.status(404).send('Không tìm thấy ảnh có quyền tải.');
    res.attachment(`richard-le-images-${Date.now()}.zip`);
    const archive = archiver('zip', { zlib: { level: 6 } });
    archive.on('error', (error) => res.destroy(error));
    archive.pipe(res);
    const usedNames = new Map();
    for (const image of result.rows) {
      const safeName = path.basename(image.original_name).replace(/[\\/\0]/g, '_');
      const count = usedNames.get(safeName) || 0;
      usedNames.set(safeName, count + 1);
      const name = count ? `${count}-${safeName}` : safeName;
      const blob = await pool.query('SELECT image_data FROM image_drive.images WHERE id = $1', [image.id]);
      if (blob.rows[0]) {
        await new Promise((resolve, reject) => {
          const onEntry = () => { archive.off('error', onError); resolve(); };
          const onError = (error) => { archive.off('entry', onEntry); reject(error); };
          archive.once('entry', onEntry);
          archive.once('error', onError);
          archive.append(blob.rows[0].image_data, { name });
        });
      }
    }
    await archive.finalize();
  } catch (error) { console.error(error); if (!res.headersSent) res.status(500).send('Không thể tạo file ZIP.'); }
});

app.post('/images/delete-batch', authRequired, async (req, res) => {
  const ids = Array.isArray(req.body.imageIds) ? req.body.imageIds : req.body.imageIds ? [req.body.imageIds] : [];
  const folderId = req.body.folderId ? String(req.body.folderId) : null;
  const isAdmin = isAdminUser(req.session.user);
  if (!ids.length || ids.length > 1000) return sendActionResponse(req, res, false, 'Vui lòng chọn ít nhất một ảnh để xóa.', driveUrl(folderId));
  try {
    const result = await pool.query(
      'DELETE FROM image_drive.images WHERE id = ANY($1::uuid[]) AND ($3 OR user_id = $2) RETURNING id',
      [ids, req.session.user.id, isAdmin]
    );
    return sendActionResponse(req, res, true, `Đã xóa ${result.rowCount} ảnh.`, driveUrl(folderId));
  } catch (error) {
    console.error(error);
    return sendActionResponse(req, res, false, 'Không thể xóa các ảnh đã chọn.', driveUrl(folderId));
  }
});

app.post('/images/delete-all', authRequired, async (req, res) => {
  const folderId = req.body.folderId ? String(req.body.folderId) : null;
  const isAdmin = isAdminUser(req.session.user);
  try {
    if (folderId) {
      const access = await getFolderAccess(folderId, req.session.user.id, isAdmin);
      if (!access || (!access.isOwner && !isAdmin)) {
        return sendActionResponse(req, res, false, 'Bạn không có quyền xóa ảnh trong folder này.', driveUrl(folderId));
      }
    }
    const result = folderId
      ? await pool.query('DELETE FROM image_drive.images WHERE ($2 OR user_id = $1) AND folder_id = $3 RETURNING id', [req.session.user.id, isAdmin, folderId])
      : await pool.query('DELETE FROM image_drive.images WHERE ($2 OR user_id = $1) AND folder_id IS NULL RETURNING id', [req.session.user.id, isAdmin]);
    return sendActionResponse(req, res, true, `Đã xóa toàn bộ ${result.rowCount} ảnh trong thư mục hiện tại.`, driveUrl(folderId));
  } catch (error) {
    console.error(error);
    return sendActionResponse(req, res, false, 'Không thể xóa toàn bộ ảnh.', driveUrl(folderId));
  }
});

app.post('/images/:id/delete', authRequired, async (req, res) => {
  const isAdmin = isAdminUser(req.session.user);
  const result = await pool.query('DELETE FROM image_drive.images WHERE id = $1 AND ($3 OR user_id = $2) RETURNING folder_id', [req.params.id, req.session.user.id, isAdmin]);
  return sendActionResponse(req, res, true, 'Ảnh đã được xóa.', driveUrl(result.rows[0] && result.rows[0].folder_id));
});

app.use((_req, res) => res.status(404).send('Không tìm thấy trang.'));

async function start() {
  try {
    await sessionStore.ready;
    await ensureAccountRequestsSchema();
    await ensureRateLimitSchema(pool);
    const admin = await ensureAdminBootstrap(pool);
    console.log(`Admin bootstrap ready: ${admin.username} (${admin.email})`);
    app.listen(port, '0.0.0.0', () => console.log(`Image Drive running at http://localhost:${port}`));
  } catch (error) {
    console.error('Không thể khởi tạo database/session store:', error);
    process.exitCode = 1;
  }
}

if (require.main === module) start();

module.exports = { app, start };
