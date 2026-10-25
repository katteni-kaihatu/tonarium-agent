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
  const config = { maxWorkers:0, autoRelease:false, repo:dir };
  const engine = new Engine(config,store,null,null,discord);
  return { store, sent, engine, dir, close: () => { store.close(); rmSync(dir,{recursive:true,force:true}); } };
}

test('intake recognizes an existing feature only with a real repository file', async () => {
  const f = fixture();
  try {
    writeFileSync(join(f.dir,'feature.md'),'Existing feature');
    f.store.create('feedback','この機能はありますか');
    f.engine.ai = { ask: async () => ({ alreadyExists:true, evidencePath:'feature.md', reply:'設定から使えます。', title:'機能', summary:'使い方', criteria:[] }) };
    await f.engine.feedback('feedback');
    assert.equal(f.store.get('feedback').status,'resolved_existing');
    assert.equal(f.store.events()[0].kind,'existing');
    assert.match(f.sent[0].text,/設定から使えます/);
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

test('release tests the combined branch before deploying and marks the ticket deployed', async () => {
  const f = fixture();
  try {
    f.store.create('ticket-1','修正');
    f.store.update('ticket-1',{status:'pr_ready',branch:'agent/task-1',pr_number:12});
    const calls = [];
    f.engine.config = { coolifyWebhook:'https://example.com/deploy',coolifyApiBase:'https://example.com',coolifyToken:'test',nightlyUrl:'https://nightly.example.com',batchMs:0 };
    f.engine.ai = { ask: async () => ({selectedIds:['ticket-1'],notes:'修正'}) };
    f.engine.git = {
      prepare: async () => calls.push('prepare'),
      worktree: async () => ({path:'candidate'}),
      mergeInto: async () => calls.push('merge'),
      test: async () => calls.push('test'),
      pushNightly: async () => { calls.push('push'); return 'abc123'; },
      removeWorktree: async () => calls.push('cleanup')
    };
    f.engine.deploy = async () => { calls.push('deploy'); return {id:'deployment-1'}; };
    assert.equal(await f.engine.release(true),true);
    assert.deepEqual(calls,['prepare','merge','test','push','deploy','cleanup']);
    assert.equal(f.store.get('ticket-1').status,'deployed');
    assert.equal(f.store.releases()[0].commit_sha,'abc123');
  } finally { f.close(); }
});
