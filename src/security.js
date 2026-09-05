const crypto = require('crypto');

function ensureCsrfToken(req, res, next) {
  if (!req.session.csrfToken) req.session.csrfToken = crypto.randomBytes(32).toString('base64url');
  res.locals.csrfToken = req.session.csrfToken;
  next();
}

function sendSessionExpired(req, res) {
  if (req.get('X-Requested-With') === 'XMLHttpRequest' || req.get('X-Upload-Queue')) {
    return res.status(401).json({ ok: false, message: 'Phiên đăng nhập đã hết hạn.', redirectTo: '/login' });
  }
  return res.status(401).render('session-expired');
}

function csrfProtection(req, res, next) {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return next();
  const expected = Buffer.from(String(req.session?.csrfToken || ''), 'utf8');
  const supplied = Buffer.from(String(req.get('X-CSRF-Token') || req.body?._csrf || ''), 'utf8');
  const valid = expected.length > 0
    && supplied.length === expected.length
    && crypto.timingSafeEqual(supplied, expected);
  if (valid) return next();

  // Login and registration deliberately work without an authenticated session.
  // Every other state-changing request belongs to the signed-in area, so a
  // missing user here means the server-side session has expired.
  const isPublicAuthRequest = req.path === '/login' || req.path === '/register';
  if (req.path && !req.session?.user && !isPublicAuthRequest) {
    return sendSessionExpired(req, res);
  }

  if (req.get('X-Requested-With') === 'XMLHttpRequest' || req.get('X-Upload-Queue')) {
    return res.status(403).json({ ok: false, message: 'Phiên bảo mật đã hết hạn. Vui lòng tải lại trang.' });
  }
  return res.status(403).send('Yêu cầu không hợp lệ hoặc phiên bảo mật đã hết hạn.');
}

module.exports = { ensureCsrfToken, csrfProtection, sendSessionExpired };
