import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { GitHub } from '../src/git.js';

test('GitHub push retries a temporary remote rejection without rerunning implementation', async () => {
  const git = new GitHub({repo:process.cwd()},process.cwd());
  git.pushRetryDelays = [0,0,0];
  let attempts = 0, notices = 0;
  git.git = async () => {
    if (++attempts < 3) throw new Error('remote rejected');
    return {stdout:''};
  };
  await git.pushWithRetry(process.cwd(),'agent/task-1',() => notices++);
  assert.equal(attempts,3);
  assert.equal(notices,2);
});

test('PM can queue a bounded repair and preserve the failed worktree', async () => {
  const dir = mkdtempSync(join(tmpdir(),'tonarium-retry-'));
  const store = new Store(join(dir,'state.sqlite'));
  try {
    store.create('ticket','修正する機能');
    const engine = new Engine({intakeProvider:'codex'},store,{ask:async (_name,_prompt,options) => {
      assert.equal(options.provider,'codex');
      return {retry:true,reason:'型エラーを直せます',instruction:'Player.tsx の変数名を修正'};
    }}, {}, {say:async () => {}});
    const worktree = {path:dir,branch:'agent/task-1'};
    assert.equal(await engine.pmRetry('ticket',new Error('typecheck failed'),'code',worktree),true);
    assert.equal(store.get('ticket').status,'queued');
    assert.equal(store.getKv('retry-stage:ticket'),'code');
    assert.match(store.getKv('retry-instruction:ticket'),/Player.tsx/);
    assert.equal(await engine.pmRetry('ticket',new Error('typecheck failed'),'code',worktree),true);
    assert.equal(await engine.pmRetry('ticket',new Error('typecheck failed'),'code',worktree),false);
  } finally { store.close(); rmSync(dir,{recursive:true,force:true}); }
});

test('a publish retry pushes the existing commit and creates a PR without running the coder', async () => {
  const dir = mkdtempSync(join(tmpdir(),'tonarium-publish-retry-'));
  const store = new Store(join(dir,'state.sqlite'));
  try {
    store.create('ticket','変更履歴の位置を変える');
    store.update('ticket',{status:'queued',base_sha:'base-123',issue_number:1,summary:'位置の変更'});
    store.setKv('retry-stage:ticket','publish');
    let pushed = 0, removed = 0, coded = 0;
    const git = {
      prepare:async () => {},
      resumeTaskWorktree:async () => ({path:dir,branch:'agent/task-1',resumed:true}),
      pushWithRetry:async () => { pushed++; },
      findPr:async () => null,
      pr:async () => 109,
      removeWorktree:async () => { removed++; }
    };
    const engine = new Engine({baseBranch:'main',intakeProvider:'codex'},store,{code:async () => { coded++; }},git,{say:async () => {}});
    await engine.implement('ticket',{id:'builder1',name:'そら'});
    assert.equal(pushed,1);
    assert.equal(coded,0);
    assert.equal(store.get('ticket').pr_number,109);
    assert.equal(store.get('ticket').status,'pr_ready');
    assert.equal(removed,1);
  } finally { store.close(); rmSync(dir,{recursive:true,force:true}); }
});
