const test = require('node:test');
const assert = require('node:assert/strict');
const { isAdminUser, getAdminBootstrapConfig, validateAccountInput, validatePasswordChangeInput } = require('../src/admin');

test('detects admin users', () => {
  assert.equal(isAdminUser({ is_admin: true }), true);
  assert.equal(isAdminUser({ role: 'admin' }), false);
  assert.equal(isAdminUser({ is_admin: false }), false);
  assert.equal(isAdminUser(null), false);
});

test('never grants admin from a username, email or legacy role', () => {
  const env = { ADMIN_USERNAME: 'owner', ADMIN_EMAIL: 'owner@example.com' };
  for (const user of [{ username: 'admin' }, { username: 'owner' }, { email: 'owner@example.com' }, { role: 'admin' }, { is_admin: 'true' }]) {
    assert.equal(isAdminUser(user, env), false);
  }
});

test('rejects missing, default, placeholder and oversized bootstrap passwords', () => {
  for (const password of ['', 'Admin@123456', 'short', 'replace-this-with-a-unique-password-of-12-characters-or-more', 'é'.repeat(37)]) {
    assert.throws(() => getAdminBootstrapConfig({ ADMIN_PASSWORD: password }), /ADMIN_PASSWORD/);
  }
});

test('validates create-account input for admins and regular users', () => {
  const regularResult = validateAccountInput({ username: 'guest', email: 'guest@example.com', password: 'Secret123!', passwordConfirm: 'Secret123!' }, { maxAccounts: 1, currentCount: 1, isAdmin: false });
  assert.equal(regularResult.ok, false);
  assert.match(regularResult.error, /đã đủ/);

  const adminResult = validateAccountInput({ username: 'newuser', email: 'newuser@example.com', password: 'Secret123!', passwordConfirm: 'Secret123!' }, { maxAccounts: 1, currentCount: 1, isAdmin: true });
  assert.equal(adminResult.ok, true);
  assert.equal(adminResult.error, null);
});

test('validates password changes', () => {
  const missingConfirm = validatePasswordChangeInput({ newPassword: 'NewPass123!', newPasswordConfirm: 'Other123!' });
  assert.equal(missingConfirm.ok, false);
  assert.match(missingConfirm.error, /không trùng/);

  const valid = validatePasswordChangeInput({ newPassword: 'NewPass123!', newPasswordConfirm: 'NewPass123!' });
  assert.equal(valid.ok, true);
  assert.equal(valid.error, null);
});

test('uses environment values for the bootstrap admin', () => {
  const config = getAdminBootstrapConfig({
    ADMIN_USERNAME: 'root',
    ADMIN_EMAIL: 'root@example.com',
    ADMIN_PASSWORD: 'UniqueSecret123!'
  });

  assert.deepEqual(config, {
    username: 'root',
    email: 'root@example.com',
    password: 'UniqueSecret123!'
  });
});
