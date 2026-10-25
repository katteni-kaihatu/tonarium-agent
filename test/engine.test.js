import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';

function fixture() {
  const dir = mkdtempSync(join(tmpdir(),'tonarium-engine-'));
  const store = new Store(join(dir,'state.sqlite'));
  const sent = [];
  const discord = { say: async (id,text) => sent.push({id,text}), decision: async () => 'forum-1', history: async () => '投稿内容' };
  const config = { maxWorkers:0, autoRelease:false, repo:dir, baseBranch:'main', githubRepo:'owner/repo' };
  const git = { baseHead:async () => 'base-123', snapshotWorktree:async () => ({path:dir}), removeWorktree:async () => {} };
  const engine = new Engine(config,store,null,git,discord);
  return { store, sent, engine, dir, close: () => { store.close(); rmSync(dir,{recursive:true,force:true}); } };
}

test('intake recognizes an existing feature only with a real repository file', async () => {
  const f = fixture();
  try {
    writeFileSync(join(f.dir,'feature.md'),'Existing feature');
    f.store.create('feedback','この機能はありますか');
    f.engine.config.intakeProvider = 'codex';
    let cleaned = false;
    f.engine.discord.downloadImages = async () => ({paths:['C:/feedback/screenshot.png'],cleanup:async () => { cleaned = true; }});
    f.engine.ai = { ask: async (_role,_prompt,options) => {
      assert.equal(options.provider,'codex');
      assert.deepEqual(options.images,['C:/feedback/screenshot.png']);
      return { alreadyExists:true, evidencePath:'feature.md', reply:'設定から使えます。', title:'機能', summary:'使い方', criteria:[] };
    } };
    await f.engine.feedback('feedback');
    assert.equal(f.store.get('feedback').status,'resolved_existing');
    assert.equal(f.store.get('feedback').base_sha,'base-123');
    assert.equal(f.store.events()[0].kind,'existing');
    assert.match(f.sent[0].text,/設定から使えます/);
    assert.equal(cleaned,true);
  } finally { f.close(); }
});

test('intake combines similar voices before creating a task', async () => {
  const f = fixture();
  try {
    f.store.create('original','操作しづらい'); f.store.update('original',{status:'queued'});
    f.store.create('feedback','操作の声');
    f.engine.ai = { ask: async () => ({ duplicateOf:'original', reply:'同じ案件にまとめます。', title:'操作の声', summary:'追加の観点', criteria:[] }) };
    await f.engine.feedback('feedback');
    assert.equal(f.store.get('feedback').status,'grouped');
    assert.equal(f.store.get('feedback').parent_ticket_id,'original');
  } finally { f.close(); }
});

test('PM combines matching feedback without starting a second implementation', async () => {
  const f = fixture();
  try {
    f.store.create('old','既存の要望'); f.store.update('old',{status:'queued',summary:'同じ問題'});
    f.store.create('new','新しい声'); f.store.update('new',{summary:'同じ問題'});
    f.engine.ai = { ask: async () => ({ duplicateOf:'old', summary:'同じ問題' }) };
    await f.engine.plan('new','投稿内容');
    assert.equal(f.store.get('new').status,'grouped');
    assert.equal(f.store.get('new').parent_ticket_id,'old');
    assert.match(f.sent[0].text,/まとめました/);
  } finally { f.close(); }
});

test('product decision creates a forum post and waits for a reply', async () => {
  const f = fixture();
  try {
    f.store.create('new','見た目の変更');
    f.engine.ai = { ask: async () => ({ needsDecision:true, decisionQuestion:'色はどちらにしますか？', title:'見た目の変更', summary:'配色', criteria:[] }) };
    await f.engine.plan('new','投稿内容');
    assert.equal(f.store.get('new').status,'decision');
    assert.equal(f.store.get('new').decision_thread_id,'forum-1');
  } finally { f.close(); }
});

test('release tests a PR against current main, waits for checks, then merges it', async () => {
  const f = fixture();
  try {
    f.store.create('ticket-1','修正');
    f.store.update('ticket-1',{status:'pr_ready',branch:'agent/task-1',pr_number:12});
    const calls = [];
    f.engine.config = { baseBranch:'main',githubRepo:'owner/repo',batchMs:0 };
    f.engine.ai = { ask: async () => ({selectedIds:['ticket-1'],notes:'修正'}) };
    f.engine.git = {
      prInfo: async () => ({state:'OPEN',headRefOid:'head123'}),
      git: async () => calls.push('fetch'),
      worktree: async () => ({path:'candidate'}),
      mergeMainInto: async () => calls.push('merge'),
      test: async () => calls.push('test'),
      pushBranch: async () => { calls.push('push'); return 'head123'; },
      waitForChecks: async () => { calls.push('checks'); return 2; },
      mergePr: async () => { calls.push('mergePR'); return 'merge456'; },
      baseHead: async () => { calls.push('baseHead'); return calls.includes('mergePR') ? 'merge456' : 'base123'; },
      removeWorktree: async () => calls.push('cleanup')
    };
    assert.equal(await f.engine.release(true),true);
    assert.deepEqual(calls,['baseHead','fetch','merge','test','push','checks','baseHead','mergePR','cleanup','baseHead']);
    assert.equal(f.store.get('ticket-1').status,'merged');
    assert.equal(f.store.releases()[0].commit_sha,'merge456');
  } finally { f.close(); }
});

test('release retries when main advances while PR checks run', async () => {
  const f = fixture();
  try {
    f.store.create('ticket-1','修正');
    f.store.update('ticket-1',{status:'pr_ready',branch:'agent/task-1',pr_number:12});
    f.engine.config = {baseBranch:'main',githubRepo:'owner/repo',batchMs:0};
    f.engine.ai = {ask:async () => ({selectedIds:['ticket-1'],notes:''})};
    let reads = 0, merged = false;
    f.engine.git = {
      prInfo:async () => ({state:'OPEN'}),
      baseHead:async () => ++reads === 1 ? 'main-before' : 'main-after',
      git:async () => {}, worktree:async () => ({path:'candidate'}),
      mergeMainInto:async () => {}, test:async () => {},
      pushBranch:async () => 'head123', waitForChecks:async () => 1,
      mergePr:async () => { merged = true; }, removeWorktree:async () => {}
    };
    assert.equal(await f.engine.release(true),false);
    assert.equal(merged,false);
    assert.equal(f.store.get('ticket-1').status,'pr_ready');
  } finally { f.close(); }
});

test('scheduler starts release on the next tick when batching is zero', async () => {
  const f = fixture();
  try {
    f.store.create('ticket-1','修正');
    f.store.update('ticket-1',{status:'pr_ready',branch:'agent/task-1',pr_number:12});
    f.engine.config = {maxWorkers:0,autoRelease:true,batchMs:0};
    let called = false;
    f.engine.release = async () => { called = true; };
    await f.engine.tick();
    assert.equal(called,true);
  } finally { f.close(); }
});

test('intake assignments use five distinct agents and queue the sixth', async () => {
  const f = fixture();
  try {
    const assigned = await Promise.all(Array.from({length:5},(_,index) => f.engine.acquireRole('聞き取り',`ticket-${index}`)));
    assert.equal(new Set(assigned.map(role => role.id)).size,5);
    let sixthAssigned = false;
    const sixth = f.engine.acquireRole('聞き取り','ticket-6').then(role => { sixthAssigned = true; return role; });
    assert.equal(sixthAssigned,false);
    f.engine.releaseRole(assigned[0]);
    assert.equal((await sixth).id,assigned[0].id);
    assert.equal(f.engine.roleBusy.get(assigned[0].id),'ticket-6');
    for (const role of assigned) f.engine.releaseRole(role);
  } finally { f.close(); }
});

test('completed threads answer implementation questions without reopening the task', async () => {
  const f = fixture();
  try {
    f.store.create('thread-1','サムネイル');
    f.store.update('thread-1',{status:'merged',pr_number:94,last_message_id:'new-message',answered_message_id:'old-message'});
    f.engine.discord.userMessage = async () => '利用者: 定期的ってどれくらい？';
    f.engine.git.prDetails = async () => ({title:'サムネイル',files:['client/src/preview.ts']});
    f.engine.ai = {ask:async () => ({answer:'client/src/preview.ts で30秒ごとに撮影します。'})};
    await f.engine.receive('thread-1');
    assert.equal(f.store.get('thread-1').status,'merged');
    assert.equal(f.store.get('thread-1').answered_message_id,'new-message');
    assert.match(f.sent[0].text,/30秒ごと/);
  } finally { f.close(); }
});

test('release follows the release agent selected PR order', async () => {
  const f = fixture();
  try {
    f.store.create('first','先に入れる変更');
    f.store.update('first',{status:'pr_ready',branch:'agent/first',pr_number:91});
    f.store.create('second','後に入れる変更');
    f.store.update('second',{status:'pr_ready',branch:'agent/second',pr_number:94});
    f.engine.config = {baseBranch:'main',githubRepo:'owner/repo',batchMs:0};
    f.engine.ai = {ask:async () => ({selectedIds:['first','second'],notes:''})};
    const visited = [];
    f.engine.git = {
      prInfo:async number => { visited.push(number); return {state:'MERGED',mergeCommit:{oid:'merged'}}; },
      baseHead:async () => 'merged'
    };
    assert.equal(await f.engine.release(true),true);
    assert.deepEqual(visited,[91,94]);
  } finally { f.close(); }
});
