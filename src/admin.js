const bcrypt = require('bcryptjs');

function normalizeIdentity(value = '') {
  return String(value || '').trim().toLowerCase();
}

function getAdminBootstrapConfig(env = process.env) {
  const username = String(env.ADMIN_USERNAME || 'admin').trim() || 'admin';
  const email = String(env.ADMIN_EMAIL || 'admin@example.com').trim() || 'admin@example.com';
  const password = String(env.ADMIN_PASSWORD || 'Admin@123456');
  return { username, email, password };
}

function isAdminUser(user = null, env = process.env) {
  if (!user) return false;
  if (typeof user.is_admin === 'boolean') return user.is_admin;
  if (typeof user.role === 'string') return user.role.toLowerCase() === 'admin';

  const config = getAdminBootstrapConfig(env);
  const candidates = [normalizeIdentity(user.username), normalizeIdentity(user.email)];
  const allowed = [normalizeIdentity(config.username), normalizeIdentity(config.email), 'admin'];
  return candidates.some((value) => allowed.includes(value));
}

async function ensureAdminBootstrap(pool, env = process.env) {
  const config = getAdminBootstrapConfig(env);
  const existing = await pool.query(
    `SELECT id, username, email, password_hash
       FROM image_drive.users
      WHERE lower(username) = lower($1) OR lower(email) = lower($2)
      ORDER BY id
      LIMIT 1`,
    [config.username, config.email]
  );

  if (existing.rowCount) {
    const user = existing.rows[0];
    const shouldUpdatePassword = [normalizeIdentity(user.username), normalizeIdentity(user.email)].includes(normalizeIdentity(config.username))
      || [normalizeIdentity(user.username), normalizeIdentity(user.email)].includes(normalizeIdentity(config.email));
    if (shouldUpdatePassword) {
      const passwordHash = await bcrypt.hash(config.password, 12);
      await pool.query('UPDATE image_drive.users SET password_hash = $1 WHERE id = $2', [passwordHash, user.id]);
    }
    return { ...user, ...config, is_admin: true };
  }

  const passwordHash = await bcrypt.hash(config.password, 12);
  const result = await pool.query(
    `INSERT INTO image_drive.users (username, email, password_hash)
     VALUES ($1, $2, $3)
     RETURNING id, username, email`,
    [config.username, config.email, passwordHash]
  );
  return { ...result.rows[0], ...config, is_admin: true };
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
  if (!/^\S+@\S+\.\S+$/.test(email)) {
    return { ok: false, error: 'Email không hợp lệ.' };
  }
  if (password.length < 8) {
    return { ok: false, error: 'Mật khẩu cần ít nhất 8 ký tự.' };
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
  if (newPassword.length < 8) {
    return { ok: false, error: 'Mật khẩu mới cần ít nhất 8 ký tự.' };
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
