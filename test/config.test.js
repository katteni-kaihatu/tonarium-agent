import test from 'node:test';
import assert from 'node:assert/strict';
import { getConfig, roles } from '../src/config.js';

test('release batching can be disabled without falling back to 30 minutes', () => {
  assert.equal(getConfig({RELEASE_BATCH_MINUTES:'0'}).batchMs,0);
  assert.equal(getConfig({RELEASE_BATCH_MINUTES:'2'}).batchMs,120_000);
  assert.equal(getConfig({}).batchMs,0);
});

test('intake and leads each have five agents and implementation has fifteen', () => {
  assert.equal(roles.filter(role => role.job === '聞き取り').length,5);
  assert.equal(roles.filter(role => role.job === '開発リード').length,5);
  assert.equal(roles.filter(role => role.job === '実装').length,15);
  assert.equal(getConfig({MAX_WORKERS:'15'}).maxWorkers,15);
});

test('all agent roles default to Codex subscription', () => {
  const config = getConfig({});
  for (const key of ['intakeProvider','planningProvider','codingProvider','integrationProvider','translationProvider']) assert.equal(config[key],'codex');
});
