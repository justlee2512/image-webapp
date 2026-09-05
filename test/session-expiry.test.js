const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function loadExpiryScript(fetch) {
  const navigations = [];
  const timers = [];
  function element(tag) {
    return {
      tag, children: [], listeners: {},
      setAttribute() {},
      append(...children) { this.children.push(...children); },
      appendChild(child) { this.children.push(child); },
      addEventListener(type, listener) { this.listeners[type] = listener; },
      showModal() { this.open = true; },
      focus() { this.focused = true; }
    };
  }
  const document = { body: element('body'), createElement: element, addEventListener() {} };
  const window = {
    location: { assign: (url) => navigations.push(url) },
    addEventListener() {}, clearTimeout() {},
    setTimeout: (callback, delay) => timers.push({ callback, delay })
  };
  vm.runInNewContext(fs.readFileSync(require.resolve('../public/session-expiry.js'), 'utf8'), { window, document, fetch });
  return { window, document, navigations, timers };
}

test('expiry shows one modal and waits for Continue before navigating', async () => {
  const { window, document, navigations, timers } = loadExpiryScript(async () => ({ status: 401 }));
  await new Promise(setImmediate);
  assert.equal(window.sessionExpiry.isExpired(), true);
  assert.equal(document.body.children.length, 1);
  assert.deepEqual(navigations, []);
  window.sessionExpiry.show();
  assert.equal(document.body.children.length, 1);
  const dialog = document.body.children[0];
  assert.equal(dialog.open, true);
  let prevented = false;
  dialog.listeners.cancel({ preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  const button = dialog.children[2];
  assert.equal(button.textContent, 'Continue');
  assert.equal(button.focused, true);
  button.listeners.click();
  assert.deepEqual(navigations, ['/login']);
  assert.equal(timers.length, 0);
});

test('network and server errors retry without showing an expiry notification', async () => {
  for (const fetch of [async () => { throw new Error('offline'); }, async () => ({ status: 503, ok: false })]) {
    const state = loadExpiryScript(fetch);
    await new Promise(setImmediate);
    assert.equal(state.window.sessionExpiry.isExpired(), false);
    assert.equal(state.document.body.children.length, 0);
    assert.equal(state.timers[0].delay, 30000);
  }
});

test('status checks use the remaining server lifetime for the next check', async () => {
  const state = loadExpiryScript(async () => ({ status: 200, ok: true, json: async () => ({ active: true, remainingMs: 5000 }) }));
  await new Promise(setImmediate);
  assert.equal(state.document.body.children.length, 0);
  assert.equal(state.timers[0].delay, 5000);
});
