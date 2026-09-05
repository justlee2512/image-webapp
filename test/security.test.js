const test = require('node:test');
const assert = require('node:assert/strict');
const { ensureCsrfToken, csrfProtection } = require('../src/security');

function responseStub() {
  return {
    locals: {},
    statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    redirect(location) { this.redirectedTo = location; return this; },
    send(message) { this.body = message; return this; },
    json(value) { this.body = value; return this; },
    render(view) { this.view = view; return this; }
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

test('shows an expiry page for signed-out protected form submissions', () => {
  const req = { method: 'POST', path: '/logout', session: {}, body: { _csrf: 'stale' }, get: () => undefined };
  const res = responseStub();
  csrfProtection(req, res, () => assert.fail('must not call next'));
  assert.equal(res.statusCode, 401);
  assert.equal(res.view, 'session-expired');
  assert.equal(res.redirectedTo, undefined);
});

test('returns a login redirect for signed-out AJAX requests', () => {
  const req = {
    method: 'POST', path: '/folders', session: {}, body: { _csrf: 'stale' },
    get: (name) => name === 'X-Requested-With' ? 'XMLHttpRequest' : undefined
  };
  const res = responseStub();
  csrfProtection(req, res, () => assert.fail('must not call next'));
  assert.equal(res.statusCode, 401);
  assert.deepEqual(res.body, { ok: false, message: 'Phiên đăng nhập đã hết hạn.', redirectTo: '/login' });
});

test('rejects Unicode CSRF tokens without throwing', () => {
  for (const token of ['é'.repeat(43), '😀'.repeat(21) + 'a', '', ['bad', 'token']]) {
    const req = { method: 'POST', path: '/login', session: { csrfToken: 'a'.repeat(43) }, body: { _csrf: token }, get: () => undefined };
    const res = responseStub();
    assert.doesNotThrow(() => csrfProtection(req, res, () => assert.fail('must not call next')));
    assert.equal(res.statusCode, 403);
  }
});
