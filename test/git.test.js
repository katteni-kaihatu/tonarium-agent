import test from 'node:test';
import assert from 'node:assert/strict';
import { GitHub } from '../src/git.js';

class TestGitHub extends GitHub {
  async workflowRunsForCommit() { return []; }
}

test('release accepts completed PR checks for the exact tested head', async () => {
  const git = new TestGitHub({checksTimeoutMs:1000},process.cwd());
  git.prInfo = async () => ({headRefOid:'tested-sha',statusCheckRollup:[{name:'Web checks',conclusion:'SUCCESS'}]});
  assert.equal(await git.waitForChecks(12,'tested-sha'),1);
});

test('release refuses a failed PR check', async () => {
  const git = new TestGitHub({checksTimeoutMs:1000},process.cwd());
  git.prInfo = async () => ({headRefOid:'tested-sha',statusCheckRollup:[{name:'Web checks',conclusion:'FAILURE'}]});
  await assert.rejects(git.waitForChecks(12,'tested-sha'),/Web checks/);
});

test('release refuses a PR whose head changed after testing', async () => {
  const git = new TestGitHub({checksTimeoutMs:1000,checksPollMs:1},process.cwd());
  let calls = 0;
  git.prInfo = async () => ++calls === 1
    ? {headRefOid:'tested-sha',statusCheckRollup:[{name:'web',state:'PENDING'}]}
    : {headRefOid:'different-sha',statusCheckRollup:[]};
  await assert.rejects(git.waitForChecks(12,'tested-sha'),/head changed/);
});

test('release waits for GitHub to reflect the pushed PR head', async () => {
  const git = new TestGitHub({checksTimeoutMs:1000,checksPollMs:1},process.cwd());
  let calls = 0;
  git.prInfo = async () => ++calls === 1
    ? {headRefOid:'old-sha',statusCheckRollup:[]}
    : {headRefOid:'tested-sha',statusCheckRollup:[{name:'web',conclusion:'SUCCESS'}]};
  assert.equal(await git.waitForChecks(12,'tested-sha'),1);
  assert.equal(calls,2);
});

test('release waits for the Web check to appear', async () => {
  const git = new TestGitHub({checksTimeoutMs:1000,checksPollMs:1},process.cwd());
  let calls = 0;
  git.prInfo = async () => ({headRefOid:'tested-sha',statusCheckRollup:++calls === 1 ? [] : [{name:'web',conclusion:'SUCCESS'}]});
  assert.equal(await git.waitForChecks(12,'tested-sha'),1);
  assert.equal(calls,2);
});

test('release accepts a successful Web check attached to the exact commit', async () => {
  const git = new TestGitHub({checksTimeoutMs:1000,checksStartGraceMs:0},process.cwd());
  git.prInfo = async () => ({headRefOid:'tested-sha',headRefName:'agent/task-1',statusCheckRollup:[]});
  git.checkRunsForCommit = async sha => {
    assert.equal(sha,'tested-sha');
    return [{name:'web',conclusion:'success',state:'completed'}];
  };
  assert.equal(await git.waitForChecks(12,'tested-sha'),1);
});

test('release starts the Web workflow when GitHub has not scheduled a check', async () => {
  const git = new TestGitHub({checksTimeoutMs:1000,checksPollMs:1,checksStartGraceMs:0},process.cwd());
  git.prInfo = async () => ({headRefOid:'tested-sha',headRefName:'agent/task-1',statusCheckRollup:[]});
  let checked = 0, triggered = 0;
  git.checkRunsForCommit = async () => ++checked === 1 ? [] : [{name:'web',conclusion:'success',state:'completed'}];
  git.triggerWebCheck = async branch => { assert.equal(branch,'agent/task-1'); triggered++; };
  assert.equal(await git.waitForChecks(12,'tested-sha'),1);
  assert.equal(triggered,1);
});

test('release waits for a workflow run before its jobs appear in the PR rollup', async () => {
  const git = new TestGitHub({checksTimeoutMs:1000,checksPollMs:1,checksStartGraceMs:0},process.cwd());
  git.prInfo = async () => ({headRefOid:'tested-sha',headRefName:'agent/task-1',statusCheckRollup:[{name:'web',conclusion:'SUCCESS'}]});
  let polls = 0;
  git.workflowRunsForCommit = async sha => {
    assert.equal(sha,'tested-sha');
    return [{name:'Native checks',state:++polls === 1 ? 'queued' : 'completed',conclusion:polls === 1 ? '' : 'success'}];
  };
  assert.equal(await git.waitForChecks(12,'tested-sha'),2);
  assert.equal(polls,2);
});
