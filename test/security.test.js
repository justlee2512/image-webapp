const test = require('node:test');
const assert = require('node:assert/strict');
const { sanitizeFilename, normalizeUuidList } = require('../src/security');

test('sanitizes uploaded file names', () => {
  assert.equal(sanitizeFilename('../../secret/image.jpg'), 'image.jpg');
  assert.equal(sanitizeFilename('bad<name>.png'), 'bad_name_.png');
});

test('normalizes UUID lists and removes invalid or duplicate values', () => {
  const id = '550e8400-e29b-41d4-a716-446655440000';
  assert.deepEqual(normalizeUuidList([id, id, 'bad']), [id]);
});
