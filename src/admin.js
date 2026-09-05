function normalizeIdentity(value = '') {
  return String(value || '').trim().toLowerCase();
}

function getAdminBootstrapConfig(env = process.env) {
  const username = String(env.ADMIN_USERNAME || 'admin').trim() || 'admin';
  const email = String(env.ADMIN_EMAIL || 'admin@example.com').trim().toLowerCase() || 'admin@example.com';
  return { username, email };
}

function isAdminUser(user = null) {
  return user?.is_admin === true;
}

async function ensureAdminBootstrap(pool, env = process.env) {
  const config = getAdminBootstrapConfig(env);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Serialize schema migration and bootstrap across replicas.
    await client.query("SELECT pg_advisory_xact_lock(hashtext('image_drive_admin_bootstrap'))");
    await client.query('ALTER TABLE image_drive.users ADD COLUMN IF NOT EXISTS is_admin BOOLEAN NOT NULL DEFAULT FALSE');
    const admins = await client.query(
      'SELECT id, username, email FROM image_drive.users WHERE is_admin = TRUE ORDER BY id'
    );
    if (admins.rowCount) {
      const configuredAdmin = admins.rows.find((user) => normalizeIdentity(user.username) === normalizeIdentity(config.username)
        && normalizeIdentity(user.email) === normalizeIdentity(config.email));
      if (!configuredAdmin) {
        throw new Error('Admin bootstrap: ADMIN_USERNAME và ADMIN_EMAIL không khớp tài khoản admin trong database.');
      }
      await client.query('COMMIT');
      return { ...configuredAdmin, is_admin: true };
    }

    const existing = await client.query(
      `SELECT id, username, email, password_hash, is_admin
         FROM image_drive.users
        WHERE lower(username) = lower($1) AND lower(email) = lower($2)
         FOR UPDATE`,
      [config.username, config.email]
    );
    if (existing.rowCount !== 1) {
      throw new Error('Admin bootstrap: database chưa có admin; ADMIN_USERNAME và ADMIN_EMAIL phải khớp chính xác một tài khoản hiện có.');
    }
    const user = existing.rows[0];
    await client.query('UPDATE image_drive.users SET is_admin = TRUE WHERE id = $1', [user.id]);
    await client.query("DELETE FROM image_drive.sessions WHERE sess #>> '{user,id}' = $1", [String(user.id)]);
    await client.query('COMMIT');
    return { id: user.id, username: user.username, email: user.email, is_admin: true };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally { client.release(); }
}

function withAdminFlag(user) {
  return user ? { ...user, is_admin: isAdminUser(user) } : user;
}

function validateAccountInput(values = {}, options = {}) {
  const username = String(values.username || '').trim();
  const email = String(values.email || '').trim().toLowerCase();
  const password = String(values.password || '');
  const passwordConfirm = String(values.passwordConfirm || '');

  if (!/^[a-zA-Z0-9_]{3,30}$/.test(username)) {
    return { ok: false, error: 'Tên tài khoản cần 3–30 ký tự, chỉ gồm chữ, số và dấu gạch dưới.' };
  }
  if (email.length > 255 || !/^\S+@\S+\.\S+$/.test(email)) {
    return { ok: false, error: 'Email không hợp lệ.' };
  }
  if (password.length < 8 || Buffer.byteLength(password) > 72) {
    return { ok: false, error: 'Mật khẩu cần ít nhất 8 ký tự và tối đa 72 byte.' };
  }
  if (password !== passwordConfirm) {
    return { ok: false, error: 'Hai mật khẩu không trùng khớp.' };
  }
  const { maxAccounts = Number.MAX_SAFE_INTEGER, currentCount = 0, isAdmin = false } = options;
  if (!isAdmin && currentCount >= maxAccounts) {
    return { ok: false, error: `Hệ thống đã đủ ${maxAccounts} tài khoản.` };
  }
  return { ok: true, error: null };
}

function validatePasswordChangeInput(values = {}) {
  const newPassword = String(values.newPassword || '');
  const newPasswordConfirm = String(values.newPasswordConfirm || '');
  if (newPassword.length < 8 || Buffer.byteLength(newPassword) > 72) {
    return { ok: false, error: 'Mật khẩu mới cần ít nhất 8 ký tự và tối đa 72 byte.' };
  }
  if (newPassword !== newPasswordConfirm) {
    return { ok: false, error: 'Mật khẩu mới không trùng khớp.' };
  }
  return { ok: true, error: null };
}

module.exports = {
  isAdminUser,
  getAdminBootstrapConfig,
  ensureAdminBootstrap,
  withAdminFlag,
  validateAccountInput,
  validatePasswordChangeInput
};
