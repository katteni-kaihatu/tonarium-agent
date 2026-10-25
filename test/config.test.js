import test from 'node:test';
import assert from 'node:assert/strict';
import { getConfig } from '../src/config.js';

test('release batching can be disabled without falling back to 30 minutes', () => {
  assert.equal(getConfig({RELEASE_BATCH_MINUTES:'0'}).batchMs,0);
  assert.equal(getConfig({RELEASE_BATCH_MINUTES:'2'}).batchMs,120_000);
  assert.equal(getConfig({}).batchMs,0);
});
