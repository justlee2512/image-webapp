const test = require('node:test');
const assert = require('node:assert/strict');

const {
  isAdminUser,
  getAdminBootstrapConfig,
  validatePassword,
  validateAccountInput,
  validatePasswordChangeInput
} = require('../src/admin');

test('admin permission comes only from is_admin flag', () => {
  assert.equal(isAdminUser({ is_admin: true }), true);
  assert.equal(isAdminUser({ is_admin: false, username: 'admin' }), false);
  assert.equal(isAdminUser({ role: 'admin' }), false);
  assert.equal(isAdminUser(null), false);
});

test('uses environment values for bootstrap admin', () => {
  assert.deepEqual(getAdminBootstrapConfig({
    NODE_ENV: 'production',
    ADMIN_USERNAME: 'root',
    ADMIN_EMAIL: 'ROOT@example.com',
    ADMIN_PASSWORD: 'Strong-Password-123!'
  }), {
    username: 'root',
    email: 'root@example.com',
    password: 'Strong-Password-123!'
  });
});

test('rejects weak passwords', () => {
  assert.equal(validatePassword('password').ok, false);
  assert.equal(validatePassword('onlylowercase123').ok, false);
  assert.equal(validatePassword('Strong-Password-123!').ok, true);
});

test('validates account inputs and account limit', () => {
  const valid = validateAccountInput({
    username: 'richard_01',
    email: 'richard@example.com',
    password: 'Strong-Password-123!',
    passwordConfirm: 'Strong-Password-123!'
  }, { maxAccounts: 5, currentCount: 4, isAdmin: false });
  assert.equal(valid.ok, true);

  const full = validateAccountInput({
    username: 'richard_02',
    email: 'richard2@example.com',
    password: 'Strong-Password-123!',
    passwordConfirm: 'Strong-Password-123!'
  }, { maxAccounts: 5, currentCount: 5, isAdmin: false });
  assert.equal(full.ok, false);
});

test('validates password confirmation', () => {
  assert.equal(validatePasswordChangeInput({
    newPassword: 'Strong-Password-123!',
    newPasswordConfirm: 'Another-Password-123!'
  }).ok, false);
});
