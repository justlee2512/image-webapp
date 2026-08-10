const test = require('node:test');
const assert = require('node:assert/strict');
const { ensureCsrfToken, csrfProtection, LoginRateLimiter } = require('../src/security');

function responseStub() {
  return {
    locals: {},
    statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    send(message) { this.body = message; return this; },
    json(value) { this.body = value; return this; }
  };
}

test('creates and reuses a CSRF token in the session', () => {
  const req = { session: {} };
  const res = responseStub();
  ensureCsrfToken(req, res, () => {});
  const first = req.session.csrfToken;
  assert.ok(first.length >= 40);
  ensureCsrfToken(req, res, () => {});
  assert.equal(req.session.csrfToken, first);
  assert.equal(res.locals.csrfToken, first);
});

test('rejects invalid CSRF tokens and accepts a valid token', () => {
  const validReq = { method: 'POST', session: { csrfToken: 'abc' }, body: { _csrf: 'abc' }, get: () => undefined };
  let called = false;
  csrfProtection(validReq, responseStub(), () => { called = true; });
  assert.equal(called, true);

  const invalidReq = { method: 'POST', session: { csrfToken: 'abc' }, body: { _csrf: 'xyz' }, get: () => undefined };
  const res = responseStub();
  csrfProtection(invalidReq, res, () => assert.fail('must not call next'));
  assert.equal(res.statusCode, 403);
});

test('rate limits repeated failed logins and clears successful identities', () => {
  const limiter = new LoginRateLimiter({ windowMs: 60_000, maxAttempts: 2 });
  const req = { ip: '127.0.0.1' };
  limiter.fail(req, 'User');
  assert.equal(limiter.check(req, 'user').allowed, true);
  limiter.fail(req, 'user');
  assert.equal(limiter.check(req, 'USER').allowed, false);
  limiter.clear(req, 'user');
  assert.equal(limiter.check(req, 'user').allowed, true);
});
