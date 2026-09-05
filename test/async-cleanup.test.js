const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { settleAll, trackPoolShutdown } = require('../test-support/async-cleanup');

test('pool cleanup waits for socket end after pool.end resolves', async () => {
  const pool = new EventEmitter();
  pool.end = async () => {};
  const close = trackPoolShutdown(pool);
  const clients = [new EventEmitter(), new EventEmitter()];
  clients.forEach((client) => pool.emit('connect', client));
  let completed = false;
  const closing = close().then(() => { completed = true; });
  await new Promise(setImmediate);
  assert.equal(completed, false);
  clients[0].emit('end');
  await new Promise(setImmediate);
  assert.equal(completed, false);
  clients[1].emit('end');
  await closing;
  assert.equal(completed, true);
  assert.equal(pool.listenerCount('connect'), 0);
});

test('pool cleanup reports background errors instead of hiding them', async () => {
  const pool = new EventEmitter();
  pool.end = async () => {};
  const close = trackPoolShutdown(pool);
  const error = new Error('database connection lost');
  pool.emit('error', error);
  await assert.rejects(close(), (failure) => failure instanceof AggregateError && failure.errors[0] === error);
});

test('failed concurrent batches drain siblings before rejecting', async () => {
  let finishSibling;
  const sibling = new Promise((resolve) => { finishSibling = resolve; });
  const failure = new Error('query failed');
  let rejected = false;
  const batch = settleAll([Promise.reject(failure), sibling]);
  const checked = assert.rejects(batch, (error) => {
    rejected = true;
    return error instanceof AggregateError && error.errors[0] === failure;
  });
  await new Promise(setImmediate);
  assert.equal(rejected, false);
  finishSibling('completed');
  await checked;
  assert.equal(rejected, true);
  assert.deepEqual(await settleAll([Promise.resolve('a'), Promise.resolve('b')]), ['a', 'b']);
});
