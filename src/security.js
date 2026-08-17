const crypto = require('crypto');

function ensureCsrfToken(req, res, next) {
  if (!req.session.csrfToken) req.session.csrfToken = crypto.randomBytes(32).toString('base64url');
  res.locals.csrfToken = req.session.csrfToken;
  next();
}

function csrfProtection(req, res, next) {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return next();
  const expected = String(req.session?.csrfToken || '');
  const supplied = String(req.get('X-CSRF-Token') || req.body?._csrf || '');
  const valid = expected.length > 0
    && supplied.length === expected.length
    && crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(expected));
  if (valid) return next();

  // Login and registration deliberately work without an authenticated session.
  // Every other state-changing request belongs to the signed-in area, so a
  // missing user here means the server-side session has expired.
  const isPublicAuthRequest = req.path === '/login' || req.path === '/register';
  if (req.path && !req.session?.user && !isPublicAuthRequest) {
    if (req.get('X-Requested-With') === 'XMLHttpRequest' || req.get('X-Upload-Queue')) {
      return res.status(401).json({ ok: false, message: 'Phiên đăng nhập đã hết hạn.', redirectTo: '/login' });
    }
    return res.redirect('/login');
  }

  if (req.get('X-Requested-With') === 'XMLHttpRequest' || req.get('X-Upload-Queue')) {
    return res.status(403).json({ ok: false, message: 'Phiên bảo mật đã hết hạn. Vui lòng tải lại trang.' });
  }
  return res.status(403).send('Yêu cầu không hợp lệ hoặc phiên bảo mật đã hết hạn.');
}

class LoginRateLimiter {
  constructor({ windowMs = 15 * 60 * 1000, maxAttempts = 10 } = {}) {
    this.windowMs = windowMs;
    this.maxAttempts = maxAttempts;
    this.entries = new Map();
  }

  key(req, identity = '') {
    return `${req.ip}|${String(identity).trim().toLowerCase()}`;
  }

  check(req, identity) {
    const key = this.key(req, identity);
    const now = Date.now();
    const entry = this.entries.get(key);
    if (!entry || entry.resetAt <= now) {
      this.entries.delete(key);
      return { allowed: true, retryAfterSeconds: 0 };
    }
    return {
      allowed: entry.count < this.maxAttempts,
      retryAfterSeconds: Math.max(1, Math.ceil((entry.resetAt - now) / 1000))
    };
  }

  fail(req, identity) {
    const key = this.key(req, identity);
    const now = Date.now();
    const entry = this.entries.get(key);
    if (!entry || entry.resetAt <= now) this.entries.set(key, { count: 1, resetAt: now + this.windowMs });
    else entry.count += 1;
  }

  clear(req, identity) {
    this.entries.delete(this.key(req, identity));
  }
}

module.exports = { ensureCsrfToken, csrfProtection, LoginRateLimiter };
