const test = require('node:test');
const assert = require('node:assert/strict');
const { isAdminUser, getAdminBootstrapConfig } = require('../src/admin');

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
