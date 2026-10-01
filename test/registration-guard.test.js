const test = require('node:test');
const assert = require('node:assert/strict');
const { registrationGuard } = require('../src/registration-guard');

function response() {
  return { headers: {}, statusCode: 200, set(k, v) { this.headers[k] = v; return this; },
    status(v) { this.statusCode = v; return this; }, type() { return this; }, send(v) { this.body = v; return this; } };
}

test('counts all registration POST route variants before body/CSRF validation', async () => {
  const consumed = [];
  const checked = [];
  const guard = registrationGuard({
    async consume(req) { consumed.push(req); return { allowed: true }; },
    async check(req) { checked.push(req); return { allowed: true }; }
  });
  let next = 0;
  for (const path of ['/register', '/register/', '/REGISTER']) {
    await guard({ method: 'POST', path, ip: '192.0.2.1' }, response(), () => next++);
  }
  await guard({ method: 'GET', path: '/register', ip: '192.0.2.1' }, response(), () => next++);
  assert.equal(consumed.length, 3);
  assert.equal(checked.length, 1);
  assert.equal(next, 4);
});

test('blocks all routes and cookies with 429 and Retry-After without consuming more attempts', async () => {
  const guard = registrationGuard({ async check() { return { allowed: false, retryAfterSeconds: 3600 }; } });
  for (const path of ['/login', '/drive', '/images/1', '/styles.css', '/session-status']) {
    const res = response();
    await guard({ method: 'GET', path, ip: '192.0.2.1', session: { user: { id: 1 } } }, res, () => assert.fail('Blocked request passed'));
    assert.equal(res.statusCode, 429);
    assert.equal(res.headers['Retry-After'], '3600');
    assert.equal(res.headers['Cache-Control'], 'no-store');
    assert.match(res.body, /tạm bị khóa/);
  }
});

test('rate limit database failure fails closed', async (t) => {
  t.mock.method(console, 'error', () => {});
  const guard = registrationGuard({ async check() { throw new Error('DB offline'); } });
  const res = response();
  await guard({ method: 'GET', path: '/login' }, res, () => assert.fail('Outage bypassed the guard'));
  assert.equal(res.statusCode, 503);
});
