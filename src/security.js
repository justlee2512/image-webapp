const crypto = require('crypto');
const sharp = require('sharp');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ''));
  const b = Buffer.from(String(right || ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function csrfSession(req, res, next) {
  if (!req.session.csrfToken) req.session.csrfToken = crypto.randomBytes(32).toString('base64url');
  res.locals.csrfToken = req.session.csrfToken;
  next();
}

function csrfProtection(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const token = req.get('x-csrf-token') || (req.body && req.body._csrf);
  if (!safeEqual(token, req.session && req.session.csrfToken)) {
    const wantsJson = req.get('x-requested-with') === 'XMLHttpRequest' || req.accepts(['html', 'json']) === 'json';
    if (wantsJson) return res.status(403).json({ ok: false, message: 'Phiên bảo mật đã hết hạn. Hãy tải lại trang.' });
    return res.status(403).send('Phiên bảo mật đã hết hạn. Hãy tải lại trang.');
  }
  next();
}

function sanitizeFilename(value = '') {
  const normalized = String(value).normalize('NFKC').replace(/[\u0000-\u001f\u007f]/g, '');
  const basename = normalized.replace(/\\/g, '/').split('/').pop() || 'image';
  return basename.replace(/[<>:"|?*]/g, '_').slice(0, 255) || 'image';
}

function detectImageMime(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return null;
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  const gif = buffer.subarray(0, 6).toString('ascii');
  if (gif === 'GIF87a' || gif === 'GIF89a') return 'image/gif';
  if (buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  return null;
}

async function inspectImage(buffer, maxPixels) {
  const mime = detectImageMime(buffer);
  if (!mime) throw new Error('Tệp không phải ảnh JPG, PNG, GIF hoặc WebP hợp lệ.');
  const metadata = await sharp(buffer, { failOn: 'error', animated: false, limitInputPixels: maxPixels }).metadata();
  if (!metadata.width || !metadata.height) throw new Error('Không đọc được kích thước ảnh.');
  if (metadata.width * metadata.height > maxPixels) throw new Error('Ảnh có độ phân giải quá lớn.');
  const expected = { jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp' }[metadata.format];
  if (!expected || expected !== mime) throw new Error('Định dạng ảnh không khớp với nội dung thực tế.');
  return { mime, width: metadata.width, height: metadata.height };
}

function normalizeUuidList(value, max = 1000) {
  const list = Array.isArray(value) ? value : value ? [value] : [];
  const unique = [...new Set(list.map(String).filter((id) => UUID_RE.test(id)))];
  return unique.slice(0, max);
}

class Semaphore {
  constructor(limit, maxQueue = 100) {
    this.limit = Math.max(1, limit);
    this.maxQueue = Math.max(0, maxQueue);
    this.active = 0;
    this.waiters = [];
  }

  acquire() {
    return new Promise((resolve, reject) => {
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
      if (this.active < this.limit) return enter();
      if (this.waiters.length >= this.maxQueue) {
        const error = new Error('Hệ thống đang bận. Hãy thử lại sau.');
        error.status = 503;
        return reject(error);
      }
      this.waiters.push(enter);
    });
  }
}

function createRateLimiter({ windowMs, limit, keyPrefix }) {
  const buckets = new Map();
  const timer = setInterval(() => {
    const now = Date.now();
    for (const [key, value] of buckets) if (value.resetAt <= now) buckets.delete(key);
  }, Math.max(30000, windowMs));
  timer.unref();

  return (req, res, next) => {
    const now = Date.now();
    const key = `${keyPrefix}:${req.ip}:${String(req.body && (req.body.identity || req.body.email || req.body.username) || '').toLowerCase()}`;
    let bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= now) bucket = { count: 0, resetAt: now + windowMs };
    bucket.count += 1;
    buckets.set(key, bucket);
    res.set('X-RateLimit-Limit', String(limit));
    res.set('X-RateLimit-Remaining', String(Math.max(0, limit - bucket.count)));
    if (bucket.count > limit) {
      const retryAfter = Math.ceil((bucket.resetAt - now) / 1000);
      res.set('Retry-After', String(retryAfter));
      return res.status(429).send('Bạn thao tác quá nhanh. Hãy thử lại sau ít phút.');
    }
    next();
  };
}

function requestContext(req, res, next) {
  const requestId = req.get('x-request-id') || crypto.randomUUID();
  req.id = requestId;
  res.set('X-Request-Id', requestId);
  next();
}

module.exports = {
  UUID_RE,
  csrfSession,
  csrfProtection,
  sanitizeFilename,
  inspectImage,
  normalizeUuidList,
  Semaphore,
  createRateLimiter,
  requestContext
};
