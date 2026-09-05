const test = require('node:test');
const assert = require('node:assert/strict');
const { positiveInteger, PgRateLimiter } = require('../src/limits');
const { validateAccountInput, validatePasswordChangeInput } = require('../src/admin');

test('invalid limit configuration fails instead of silently disabling protection', () => {
  for (const value of ['NaN', 'Infinity', '0', '-1', '1.5', '', Number.MAX_SAFE_INTEGER]) {
    assert.throws(() => positiveInteger(value, 10, 'limit'), /limit/);
    assert.throws(() => new PgRateLimiter({ pool: {}, scope: 'test', maxAttempts: value }));
  }
  assert.equal(positiveInteger(undefined, 10, 'limit'), 10);
  assert.equal(positiveInteger('50', 10, 'limit'), 50);
});

test('password validators enforce bcrypt byte limits for multibyte passwords', () => {
  const accepted = 'é'.repeat(36);
  const rejected = 'é'.repeat(37);
  for (const [password, ok] of [[accepted, true], [rejected, false]]) {
    assert.equal(validateAccountInput({ username: 'guest', email: 'guest@example.com', password, passwordConfirm: password }).ok, ok);
    assert.equal(validatePasswordChangeInput({ newPassword: password, newPasswordConfirm: password }).ok, ok);
  }
});
