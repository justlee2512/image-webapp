function registrationGuard(limiter) {
  return async (req, res, next) => {
    try {
      // Match Express's default case-insensitive routes and optional trailing slash.
      const registration = req.method === 'POST' && /^\/register\/?$/i.test(req.path);
      const limit = registration ? await limiter.consume(req) : await limiter.check(req);
      if (limit.allowed) return next();
      res.set('Retry-After', String(limit.retryAfterSeconds));
      res.set('Cache-Control', 'no-store');
      return res.status(429).type('text/plain').send(
        `IP này đã tạm bị khóa vì gửi quá nhiều yêu cầu đăng ký. Vui lòng thử lại sau ${limit.retryAfterSeconds} giây.`
      );
    } catch (error) {
      console.error(error);
      return res.status(503).type('text/plain').send('Không thể kiểm tra giới hạn truy cập. Vui lòng thử lại sau.');
    }
  };
}

module.exports = { registrationGuard };
