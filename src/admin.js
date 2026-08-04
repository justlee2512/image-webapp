const bcrypt = require('bcryptjs');

const DEFAULT_DEV_ADMIN_PASSWORD = 'ChangeMe-Strong-Password-123!';

function normalizeIdentity(value = '') {
  return String(value || '').trim().toLowerCase();
}

function getAdminBootstrapConfig(env = process.env) {
  const username = String(env.ADMIN_USERNAME || 'admin').trim() || 'admin';
  const email = normalizeIdentity(env.ADMIN_EMAIL || 'admin@example.com') || 'admin@example.com';
  const password = String(env.ADMIN_PASSWORD || (env.NODE_ENV === 'production' ? '' : DEFAULT_DEV_ADMIN_PASSWORD));
  return { username, email, password };
}

function validatePassword(password = '') {
  const value = String(password);
  if (value.length < 10 || value.length > 128) {
    return { ok: false, error: 'Mật khẩu cần từ 10 đến 128 ký tự.' };
  }
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((pattern) => pattern.test(value)).length;
  if (classes < 3) {
    return { ok: false, error: 'Mật khẩu cần có ít nhất 3 nhóm: chữ thường, chữ hoa, số hoặc ký tự đặc biệt.' };
  }
  if (/^(password|admin|123456|qwerty)/i.test(value)) {
    return { ok: false, error: 'Mật khẩu quá dễ đoán.' };
  }
  return { ok: true, error: null };
}

function isAdminUser(user = null) {
  return Boolean(user && user.is_admin === true);
}

async function ensureAdminBootstrap(pool, env = process.env) {
  const config = getAdminBootstrapConfig(env);
  if (!config.password) {
    throw new Error('ADMIN_PASSWORD is required in production.');
  }
  const validation = validatePassword(config.password);
  if (!validation.ok) throw new Error(`ADMIN_PASSWORD is not strong enough: ${validation.error}`);
  if (env.NODE_ENV === 'production' && config.password === DEFAULT_DEV_ADMIN_PASSWORD) {
    throw new Error('ADMIN_PASSWORD must not use the sample development password in production.');
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(hashtext('image_drive_admin_bootstrap_v2'))");
    const existing = await client.query(
      `SELECT id, username, email, is_admin
         FROM image_drive.users
        WHERE lower(username) = lower($1) OR lower(email) = lower($2)
        ORDER BY is_admin DESC, id
        LIMIT 1`,
      [config.username, config.email]
    );

    if (existing.rowCount) {
      const user = existing.rows[0];
      if (!user.is_admin) {
        await client.query('UPDATE image_drive.users SET is_admin = TRUE WHERE id = $1', [user.id]);
      }
      await client.query('COMMIT');
      return { ...user, is_admin: true };
    }

    const passwordHash = await bcrypt.hash(config.password, 12);
    const result = await client.query(
      `INSERT INTO image_drive.users (username, email, password_hash, is_admin)
       VALUES ($1, $2, $3, TRUE)
       RETURNING id, username, email, is_admin`,
      [config.username, config.email, passwordHash]
    );
    await client.query('COMMIT');
    return result.rows[0];
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

function validateAccountInput(values = {}, options = {}) {
  const username = String(values.username || '').trim();
  const email = normalizeIdentity(values.email);
  const password = String(values.password || '');
  const passwordConfirm = String(values.passwordConfirm || '');

  if (!/^[a-zA-Z0-9_]{3,30}$/.test(username)) {
    return { ok: false, error: 'Tên tài khoản cần 3–30 ký tự, chỉ gồm chữ, số và dấu gạch dưới.' };
  }
  if (email.length > 255 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return { ok: false, error: 'Email không hợp lệ.' };
  }
  const passwordValidation = validatePassword(password);
  if (!passwordValidation.ok) return passwordValidation;
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
  const result = validatePassword(newPassword);
  if (!result.ok) return result;
  if (newPassword !== newPasswordConfirm) {
    return { ok: false, error: 'Mật khẩu mới không trùng khớp.' };
  }
  return { ok: true, error: null };
}

module.exports = {
  DEFAULT_DEV_ADMIN_PASSWORD,
  normalizeIdentity,
  isAdminUser,
  getAdminBootstrapConfig,
  ensureAdminBootstrap,
  validatePassword,
  validateAccountInput,
  validatePasswordChangeInput
};
