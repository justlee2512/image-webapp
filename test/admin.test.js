const test = require('node:test');
const assert = require('node:assert/strict');
const { isAdminUser, getAdminBootstrapConfig, validateAccountInput, validatePasswordChangeInput } = require('../src/admin');

test('detects admin users', () => {
  assert.equal(isAdminUser({ is_admin: true }), true);
  assert.equal(isAdminUser({ role: 'admin' }), true);
  assert.equal(isAdminUser({ is_admin: false }), false);
  assert.equal(isAdminUser(null), false);
});

test('treats configured admin identities as admins without a DB flag', () => {
  const env = { ADMIN_USERNAME: 'admin', ADMIN_EMAIL: 'admin@example.com', ADMIN_PASSWORD: 'Secret123!' };
  assert.equal(isAdminUser({ username: 'admin' }, env), true);
  assert.equal(isAdminUser({ email: 'admin@example.com' }, env), true);
  assert.equal(isAdminUser({ username: 'guest' }, env), false);
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
    ADMIN_PASSWORD: 'Secret123!'
  });

  assert.deepEqual(config, {
    username: 'root',
    email: 'root@example.com',
    password: 'Secret123!'
  });
});
