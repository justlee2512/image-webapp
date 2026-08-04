const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (name) => fs.readFileSync(path.join(root, name), 'utf8');

test('all pages load the toast controller and expose a toast stack', () => {
  for (const file of ['views/login.ejs', 'views/register.ejs', 'views/drive.ejs', 'views/admin-users.ejs']) {
    const source = read(file);
    assert.match(source, /\/assets\/toast\.js\?v=/, file);
    assert.match(source, /id="toast-stack"/, file);
    assert.match(source, /name="asset-version"/, file);
  }
});

test('frontend actions request JSON instead of navigating to an error page', () => {
  const app = read('public/app.js');
  const auth = read('public/auth.js');
  assert.match(app, /X-Requested-With': 'XMLHttpRequest/);
  assert.match(auth, /X-Requested-With': 'XMLHttpRequest/);
  assert.match(app, /showToast\(error\.message/);
  assert.match(auth, /showToast\(error\.message/);
});

test('server returns JSON for AJAX authorization errors', () => {
  const server = read('src/server.js');
  assert.match(server, /res\.status\(403\)\.json\(\{ ok: false, message: 'Bạn không có quyền quản trị\.'/);
  assert.match(server, /res\.status\(401\)\.json\(\{ ok: false, message \}/);
  assert.match(server, /redirectWithToast/);
});

test('HTML and frontend assets disable browser cache while images retain immutable cache', () => {
  const server = read('src/server.js');
  assert.match(server, /DISABLE_FRONTEND_CACHE/);
  assert.match(server, /no-store, no-cache, must-revalidate/);
  assert.match(server, /private, max-age=31536000, immutable/);
});

test('frontend version change removes legacy Cache Storage and service workers', () => {
  const toast = read('public/toast.js');
  assert.match(toast, /caches\.keys\(\)/);
  assert.match(toast, /registration\.unregister\(\)/);
  assert.match(toast, /image-drive\.frontend-version/);
});

test('EJS delimiters are balanced', () => {
  for (const file of fs.readdirSync(path.join(root, 'views')).filter((name) => name.endsWith('.ejs'))) {
    const source = read(`views/${file}`);
    assert.equal((source.match(/<%/g) || []).length, (source.match(/%>/g) || []).length, file);
  }
});
