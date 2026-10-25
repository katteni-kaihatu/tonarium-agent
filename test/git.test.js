import test from 'node:test';
import assert from 'node:assert/strict';
import { GitHub } from '../src/git.js';

test('release accepts completed PR checks for the exact tested head', async () => {
  const git = new GitHub({checksTimeoutMs:1000},process.cwd());
  git.prInfo = async () => ({headRefOid:'tested-sha',statusCheckRollup:[{name:'Web checks',conclusion:'SUCCESS'}]});
  assert.equal(await git.waitForChecks(12,'tested-sha'),1);
});

test('release refuses a failed PR check', async () => {
  const git = new GitHub({checksTimeoutMs:1000},process.cwd());
  git.prInfo = async () => ({headRefOid:'tested-sha',statusCheckRollup:[{name:'Web checks',conclusion:'FAILURE'}]});
  await assert.rejects(git.waitForChecks(12,'tested-sha'),/Web checks/);
});

test('release refuses a PR whose head changed after testing', async () => {
  const git = new GitHub({checksTimeoutMs:1000},process.cwd());
  git.prInfo = async () => ({headRefOid:'different-sha',statusCheckRollup:[]});
  await assert.rejects(git.waitForChecks(12,'tested-sha'),/head changed/);
});

test('release waits for the Web check to appear', async () => {
  const git = new GitHub({checksTimeoutMs:1000,checksPollMs:1},process.cwd());
  let calls = 0;
  git.prInfo = async () => ({headRefOid:'tested-sha',statusCheckRollup:++calls === 1 ? [] : [{name:'web',conclusion:'SUCCESS'}]});
  assert.equal(await git.waitForChecks(12,'tested-sha'),1);
  assert.equal(calls,2);
});
