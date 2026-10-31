import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { replaceRoles, roles } from '../src/config.js';
import { getPersonas, setPersonas } from '../src/settings.js';

function fixture() {
  const dir = mkdtempSync(join(tmpdir(),'tonarium-engine-'));
  const store = new Store(join(dir,'state.sqlite'));
  const sent = [];
  const discord = { say: async (id,text,options) => sent.push({id,text,options}), decision: async () => 'forum-1', history: async () => '投稿内容' };
  const config = { maxWorkers:0, autoRelease:false, repo:dir, baseBranch:'main', githubRepo:'owner/repo' };
  const git = { baseHead:async () => 'base-123', snapshotWorktree:async () => ({path:dir}), removeWorktree:async () => {} };
  const engine = new Engine(config,store,null,git,discord);
  return { store, sent, engine, dir, close: () => { store.close(); rmSync(dir,{recursive:true,force:true}); } };
}

test('completed develop merge records the target branch', async () => {
  const f = fixture();
  try {
    f.engine.config.baseBranch = 'develop';
    f.store.create('ticket','修正');
    f.store.update('ticket',{status:'pr_ready',pr_number:12});
    await f.engine.markMerged(f.store.get('ticket'),'merge-sha');
    assert.equal(f.store.get('ticket').merged_branch,'develop');
    assert.match(f.sent[0].text,/develop にマージ/);
  } finally { f.close(); }
});

test('Discord thread status updates stay in event order', async () => {
  const f = fixture();
  try {
    const started = [];
    let finishFirst;
    f.store.create('ticket','修正');
    f.engine.discord.setThreadStatus = async id => {
      const status = f.store.get(id).status;
      started.push(status);
      if (status === 'integrating') await new Promise(resolve => { finishFirst = resolve; });
    };
    f.store.update('ticket',{status:'integrating'});
    f.engine.event('ticket','release','integrating','統合中');
    await new Promise(resolve => setImmediate(resolve));
    f.store.update('ticket',{status:'merged'});
    f.engine.event('ticket','release','merged','マージ済み');
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(started,['integrating']);
    finishFirst();
    await f.engine.threadStatusUpdates.get('ticket');
    assert.deepEqual(started,['integrating','merged']);
  } finally { f.close(); }
});

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

test('release removes changelog edits left by an older PR before testing and merging', async () => {
  const f = fixture();
  try {
    f.store.create('ticket-1','メニューを変更');
    f.store.update('ticket-1',{status:'pr_ready',branch:'agent/task-1',pr_number:12});
    f.engine.config = {baseBranch:'develop',githubRepo:'owner/repo',batchMs:0};
    f.engine.ai = {ask:async () => ({notes:''})};
    const calls = [];
    let merged = false;
    f.engine.git = {
      prInfo:async () => ({state:'OPEN'}),
      baseHead:async () => merged ? 'merge456' : 'base123',
      git:async args => { calls.push(args.join(' ')); return {stdout:''}; },
      worktree:async () => ({path:'candidate'}),
      mergeMainInto:async () => {},
      restoreChangelog:async (path,base) => { calls.push(`restore ${path} ${base}`); return ['shared/changelog.ts']; },
      test:async () => calls.push('test'),
      pushBranch:async () => 'head123',
      waitForChecks:async () => 1,
      mergePr:async () => { merged = true; return 'merge456'; },
      removeWorktree:async () => {}
    };
    assert.equal(await f.engine.release(true),true);
    const relevant = calls.filter(call => /^(restore|add|commit|test)/.test(call));
    assert.deepEqual(relevant,['restore candidate base123','add -A','commit -m chore: leave changelog to the main release','test']);
    assert.ok(f.store.events().some(event => event.kind === 'changelog_restored'));
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

test('a failing PR does not prevent another ready PR from merging', async () => {
  const f = fixture();
  try {
    f.store.create('first','型エラーのある変更');
    f.store.update('first',{status:'pr_ready',branch:'agent/first',pr_number:117});
    f.store.create('second','通過できる変更');
    f.store.update('second',{status:'pr_ready',branch:'agent/second',pr_number:116});
    f.engine.config = {baseBranch:'main',githubRepo:'owner/repo',batchMs:0};
    f.engine.ai = {ask:async () => ({selectedIds:['first','second'],notes:''})};
    f.engine.testAndRepairIntegration = async ticket => {
      if (ticket.id === 'first') throw new Error('typecheck failed: EYE is undefined');
    };
    let merged = false;
    f.engine.git = {
      prInfo:async () => ({state:'OPEN'}),
      baseHead:async () => merged ? 'merge-sha' : 'base-sha',
      git:async () => ({stdout:''}),
      worktree:async name => ({path:name}),
      mergeMainInto:async () => {},
      pushBranch:async () => 'head-sha',
      waitForChecks:async () => 1,
      mergePr:async () => { merged = true; return 'merge-sha'; },
      removeWorktree:async () => {}
    };
    assert.equal(await f.engine.release(true),true);
    assert.equal(f.store.get('first').status,'pr_ready');
    assert.equal(f.store.get('second').status,'merged');
    assert.equal(f.store.releases()[0].status,'partial');
    assert.ok(Number(f.store.getKv('release-retry-after:first')) > Date.now());
  } finally { f.close(); }
});

test('the second failed Web check pauses release and asks the thread owner', async () => {
  const f = fixture();
  try {
    f.store.create('ticket','共有アセット');
    f.store.update('ticket',{status:'pr_ready',branch:'agent/ticket',pr_number:249});
    f.engine.config = {baseBranch:'main',githubRepo:'owner/repo',batchMs:0,maxWorkers:0,autoRelease:false};
    f.engine.ai = {ask:async () => ({question:'Webチェックが失敗しました。修正して再開しますか？'})};
    f.engine.discord.threadOwnerId = async () => '12345678901234567';
    f.engine.testAndRepairIntegration = async () => {};
    f.engine.git = {
      prInfo:async () => ({state:'OPEN'}), baseHead:async () => 'base-sha',
      git:async () => ({stdout:''}), worktree:async () => ({path:'candidate'}),
      mergeMainInto:async () => {}, pushBranch:async () => 'head-sha',
      waitForChecks:async () => { throw new Error('Web checks failed'); },
      removeWorktree:async () => {}
    };
    await f.engine.release(true);
    assert.equal(f.store.get('ticket').status,'pr_ready');
    f.store.setKv('release-retry-after:ticket',0);
    await f.engine.release(true);
    assert.equal(f.store.get('ticket').status,'waiting_info');
    assert.equal(f.store.getKv('release-failure-count:ticket'),'2');
    assert.equal(f.sent.at(-1).options.mentionUserId,'12345678901234567');
    f.engine.discord.userMessage = async () => 'ユーザー: 修正して再開してください';
    f.engine.ai.ask = async () => ({retry:true,instruction:'失敗したテストを修正',reason:'再開'});
    f.store.update('ticket',{last_message_id:'12345678901234568'});
    await f.engine.receive('ticket');
    assert.equal(f.store.get('ticket').status,'pr_ready');
    assert.equal(f.store.getKv('release-instruction:ticket'),'失敗したテストを修正');
  } finally { f.close(); }
});

test('PM reviews the second failed Web check and orders a bounded repair', async () => {
  const f = fixture();
  try {
    f.store.create('ticket','共有アセット');
    f.store.update('ticket',{status:'pr_ready',branch:'agent/ticket',pr_number:249});
    f.engine.config = {baseBranch:'main',githubRepo:'owner/repo',batchMs:0,maxWorkers:0,autoRelease:false};
    let reviewed = 0;
    f.engine.ai = {ask:async (_role,prompt,options) => {
      if (prompt.includes('出荷段階で同じPR')) {
        reviewed++;
        assert.match(prompt,/asset unavailable/);
        assert.equal(options.cwd,'candidate');
        return {retry:true,instruction:'共有アセットの不変性テストを修正',reason:'CIの失敗を修正できる'};
      }
      return {notes:''};
    }};
    f.engine.testAndRepairIntegration = async () => {};
    f.engine.git = {
      prInfo:async () => ({state:'OPEN'}), baseHead:async () => 'base-sha',
      git:async () => ({stdout:''}), worktree:async () => ({path:'candidate'}),
      mergeMainInto:async () => {}, pushBranch:async () => 'head-sha',
      waitForChecks:async () => { throw new Error('Web checks failed'); },
      failedCheckDetails:async () => 'asset unavailable', removeWorktree:async () => {}
    };
    await f.engine.release(true);
    f.store.setKv('release-retry-after:ticket',0);
    await f.engine.release(true);
    assert.equal(reviewed,1);
    assert.equal(f.store.get('ticket').status,'pr_ready');
    assert.equal(f.store.getKv('release-pm-repairs:ticket'),'1');
    assert.equal(f.store.getKv('release-instruction:ticket'),'共有アセットの不変性テストを修正');
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

test('role assignment prefers members changed from the default, randomly within that group', async () => {
  const f = fixture();
  try {
    // intake2 と intake4 の人格を改名して「デフォルトから変わっている」状態にする
    setPersonas(f.store, getPersonas(f.store).map(persona => (persona.id === 'intake2' || persona.id === 'intake4') ? { ...persona, name:`改名${persona.id}` } : persona));
    // 乱数が上限寄りならグループの先頭、0 ならシャッフルで入れ替わった先頭が選ばれる
    f.engine.random = () => 0.999;
    const first = await f.engine.acquireRole('聞き取り','ticket-a');
    assert.equal(first.id,'intake2');
    f.engine.releaseRole(first);
    f.engine.random = () => 0;
    const second = await f.engine.acquireRole('聞き取り','ticket-b');
    assert.equal(second.id,'intake4');
    f.engine.releaseRole(second);
    // 変わっている人が全員使用中なら、それ以外から選ぶ
    const busyA = await f.engine.acquireRole('聞き取り','ticket-c');
    const busyB = await f.engine.acquireRole('聞き取り','ticket-d');
    assert.deepEqual(new Set([busyA.id,busyB.id]), new Set(['intake2','intake4']));
    const fallback = await f.engine.acquireRole('聞き取り','ticket-e');
    assert.equal(fallback.job,'聞き取り');
    assert.ok(!['intake2','intake4'].includes(fallback.id));
  } finally { f.close(); }
});

test('role assignment is random among unchanged members when nobody is customized', async () => {
  const f = fixture();
  try {
    f.engine.random = () => 0.999;
    assert.equal((await f.engine.acquireRole('聞き取り','ticket-a')).id,'intake');
  } finally { f.close(); }
});

test('intake unknowns are handed over to PM, lead and the implementation task', async () => {
  const f = fixture();
  try {
    f.store.create('thread-1','アバターが黒くなる');
    const prompts = [];
    f.engine.ai = { ask: async (_role, prompt) => {
      prompts.push(prompt);
      if (prompt.includes('聞き取る担当')) return { ready:true, reply:'受け付けました', title:'アバターが黒くなる', purpose:'正常に表示したい', summary:'見る人によって黒く表示される', criteria:['黒くならない'], unknowns:['発生する端末が未確認','発生するブラウザが未確認'] };
      if (prompt.includes('開発案件として判断')) return { verdict:'implement', purpose:'正常に表示したい', summary:'見る人によって黒く表示される', criteria:['黒くならない'], implementationTask:'画像の読み込み経路を調査して直す' };
      if (prompt.includes('開発リードとして')) return { task:'作業指示' };
      throw new Error(`unexpected prompt: ${prompt.slice(0, 40)}`);
    } };
    await f.engine.feedback('thread-1');
    assert.deepEqual(f.engine.unknowns('thread-1'), ['発生する端末が未確認','発生するブラウザが未確認']);
    const pmPrompt = prompts.find(prompt => prompt.includes('開発案件として判断'));
    assert.ok(pmPrompt.includes('発生する端末が未確認'), 'PM へ未確認事項が渡る');
    const leadPrompt = prompts.find(prompt => prompt.includes('開発リードとして'));
    assert.ok(leadPrompt.includes('発生するブラウザが未確認'), 'リードへ未確認事項が渡る');
    const task = f.engine.taskText('thread-1', f.store.get('thread-1'));
    assert.match(task, /未確認事項/);
    assert.ok(task.includes('発生する端末が未確認'), '実装タスクに未確認事項が載る');
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

test('a bug report in a completed thread starts the next round in the same thread', async () => {
  const f = fixture();
  try {
    f.store.create('thread-1','サムネイル');
    f.store.update('thread-1',{status:'merged',pr_number:94,issue_number:90,branch:'agent/task-thread-1',summary:'サムネイルを定期更新',criteria:JSON.stringify(['30秒ごとに更新']),last_message_id:'bug-message',answered_message_id:'old-message'});
    f.store.setKv('failure-count:thread-1',2);
    f.engine.discord.userMessage = async () => '利用者: サムネイルが更新されなくなった';
    f.engine.git.prDetails = async () => ({title:'サムネイル',body:'## 利用者向けの変更\n- 定期更新',files:['client/src/preview.ts']});
    f.engine.ai = {ask:async () => ({action:'new_fix',title:'サムネイルの更新停止',summary:'更新が止まる不具合'})};
    const started = [];
    f.engine.feedback = async id => { started.push(id); };
    await f.engine.receive('thread-1');
    await new Promise(resolve => setImmediate(resolve));
    const ticket = f.store.get('thread-1');
    assert.equal(ticket.status,'intake');
    assert.equal(ticket.round,2);
    assert.equal(ticket.pr_number,null);
    assert.equal(ticket.title,'サムネイルの更新停止');
    assert.equal(f.store.getKv('failure-count:thread-1'),'');
    assert.deepEqual(f.store.rounds('thread-1').map(round => [round.round,round.pr_number,round.status]),[[1,94,'merged']]);
    assert.deepEqual(started,['thread-1']);
    assert.match(f.sent[0].text,/PR #94.*このスレッドで続けて対応/);
    assert.match(await f.engine.roundContext('thread-1'),/"pr":94.*定期更新/);
  } finally { f.close(); }
});

test('messages during implementation or shipping always get a reply', async () => {
  const f = fixture();
  try {
    f.engine.discord.userMessage = async (_id,messageId) => `利用者: ${messageId}`;
    f.store.create('coding','カメラ');
    f.store.update('coding',{status:'coding',last_message_id:'m1'});
    await f.engine.receive('coding');
    await f.engine.receive('coding');
    assert.equal(f.sent.length,1);
    assert.match(f.sent[0].text,/PR を作る前に反映/);
    assert.deepEqual(f.engine.addenda('coding'),['利用者: m1']);
    f.store.create('shipping','地図');
    f.store.update('shipping',{status:'pr_ready',pr_number:7,last_message_id:'m2',answered_message_id:'m0'});
    await f.engine.receive('shipping');
    assert.match(f.sent[1].text,/PR #7.*マージが終わったら/);
    f.store.update('shipping',{status:'integrating'});
    await f.engine.markMerged(f.store.get('shipping'),'sha12345');
    assert.equal(f.store.get('shipping').answered_message_id,'m0');
    let followed = '';
    f.engine.followUp = async id => { followed = id; };
    await f.engine.tick();
    assert.equal(followed,'shipping');
    assert.equal(f.store.getKv('pending-followup:shipping'),'');
  } finally { f.close(); }
});

test('a message to a stopped ticket resumes it as an instruction', async () => {
  const f = fixture();
  try {
    f.store.create('stopped','二段ジャンプ');
    f.store.update('stopped',{status:'failed',last_message_id:'m1'});
    f.store.setKv('failed-review-count:stopped',3);
    let resumed = '';
    f.engine.feedback = async id => { resumed = f.store.get(id).status; };
    await f.engine.receive('stopped');
    assert.equal(resumed,'waiting_info');
    assert.equal(f.store.getKv('awaiting-instruction:stopped'),'1');
  } finally { f.close(); }
});

test('a grouped thread passes new messages to the active parent or reopens when the parent moved on', async () => {
  const f = fixture();
  try {
    f.engine.discord.userMessage = async () => '利用者: スマホでも使いたい';
    f.store.create('parent','地図の拡大'); f.store.update('parent',{status:'queued'});
    f.store.create('child','地図'); f.store.update('child',{status:'grouped',parent_ticket_id:'parent',last_message_id:'m1'});
    await f.engine.receive('child');
    assert.match(f.engine.addenda('parent')[0],/スマホでも使いたい/);
    assert.match(f.sent[0].text,/地図の拡大.*まとめ先の作業に渡しました/);
    f.store.update('parent',{status:'merged'});
    f.store.update('child',{last_message_id:'m2'});
    let reopened = '';
    f.engine.feedback = async id => { reopened = f.store.get(id).status; };
    await f.engine.receive('child');
    assert.equal(reopened,'intake');
  } finally { f.close(); }
});

test('intake questions mention the person who needs to answer, progress replies do not', async () => {
  const f = fixture();
  try {
    f.store.create('feedback','地図');
    f.store.setKv('last-author:feedback','12345678901234567');
    f.engine.ai = {ask:async () => ({ready:false,reply:'どの画面で困っていますか？',title:'地図',summary:'',criteria:[]})};
    await f.engine.feedback('feedback');
    assert.equal(f.store.get('feedback').status,'waiting_info');
    assert.equal(f.sent.at(-1).options.mentionUserId,'12345678901234567');
    f.engine.ai = {ask:async () => ({ready:true,reply:'整理できました。',title:'地図',summary:'拡大',criteria:[]})};
    f.engine.plan = async () => {};
    await f.engine.feedback('feedback');
    assert.equal(f.sent.at(-1).options.mentionUserId,undefined);
    assert.match(f.sent.at(-1).options.as,/^intake/);
  } finally { f.close(); }
});

test('PM reads the repository snapshot and can propose before implementing', async () => {
  const f = fixture();
  try {
    f.store.create('new','カメラのボタン');
    f.engine.discord.threadOwnerId = async () => '12345678901234567';
    let options;
    f.engine.ai = {ask:async (_role,_prompt,given) => { options = given; return {verdict:'propose',proposal:'既存のカメラアイテムにタイマーを足す案を推奨します。',title:'カメラ',summary:'撮影',criteria:[]}; }};
    await f.engine.plan('new','投稿内容');
    assert.equal(options.cwd,f.dir);
    assert.equal(options.repoReadOnly,true);
    assert.equal(f.store.get('new').status,'proposal');
    assert.match(f.store.getKv('proposal:new'),/タイマー/);
    assert.equal(f.sent.at(-1).options.mentionUserId,'12345678901234567');
  } finally { f.close(); }
});

test('a declined request can only be overturned by the decision maker', async () => {
  const f = fixture();
  try {
    f.engine.config.decisionMentionId = '22222222222222222';
    f.store.create('risky','管理者画面');
    f.store.update('risky',{last_message_id:'m1'});
    f.engine.discord.threadOwnerId = async () => '11111111111111111';
    f.engine.ai = {ask:async () => ({verdict:'decline',reason:'認証の確認を外す変更のため見送ります。',title:'管理者画面',summary:'権限',criteria:[]})};
    await f.engine.plan('risky','投稿内容');
    assert.equal(f.store.get('risky').status,'declined');
    assert.equal(f.sent.at(-1).options.mentionUserId,'11111111111111111');
    f.store.update('risky',{last_message_id:'m2'});
    f.engine.discord.userMessage = async () => '利用者: どうしても必要です';
    let question;
    f.engine.discord.decision = async (_ticket,text,options) => { question = {text,options}; return 'forum-1'; };
    f.engine.ai = {ask:async () => ({action:'appeal'})};
    await f.engine.receive('risky');
    assert.equal(f.store.get('risky').status,'decision');
    assert.equal(f.store.getKv('decision-kind:risky'),'appeal');
    assert.equal(question.options.mentionUserId,'22222222222222222');
    let planned = false;
    f.engine.plan = async (_id,_history,answer,options) => { planned = {answer,options}; };
    await f.engine.decision('risky','実装して','11111111111111111','forum-1');
    assert.equal(planned,false);
    assert.equal(f.store.get('risky').status,'decision');
    assert.match(f.sent.at(-1).text,/決定者の回答を待っています/);
    await f.engine.decision('risky','範囲を限定して実装してよい','22222222222222222','forum-1');
    assert.equal(planned.answer,'範囲を限定して実装してよい');
    assert.equal(planned.options.appeal,true);
  } finally { f.close(); }
});

test('an ordinary product decision can be answered from the original thread', async () => {
  const f = fixture();
  try {
    f.store.create('color','色');
    f.store.update('color',{status:'decision',decision_thread_id:'forum-1',last_message_id:'m1'});
    f.store.setKv('decision-kind:color','decision');
    f.store.setKv('last-author:color','11111111111111111');
    f.engine.discord.userMessage = async () => '利用者: 青にしてください';
    let answer;
    f.engine.plan = async (_id,_history,given) => { answer = given; };
    await f.engine.receive('color');
    assert.equal(answer,'利用者: 青にしてください');
  } finally { f.close(); }
});

test('implementation reports user-facing changes in the PR body and restores changelog edits', async () => {
  const f = fixture();
  try {
    f.store.create('task','タイマー');
    f.store.update('task',{status:'queued',summary:'目的: 集合写真\nカメラにタイマー',criteria:JSON.stringify(['5秒後に撮影'])});
    const calls = [];
    let body = '';
    f.engine.git = {
      ...f.engine.git,
      prepare:async () => {}, issue:async () => 5,
      resumeTaskWorktree:async () => null,
      worktree:async () => ({path:f.dir,branch:'agent/task-1'}),
      reviewDiff:async () => 'diff --git a/client b/client',
      restoreChangelog:async () => { calls.push('restore'); return ['changelog/2026-10-27-x.json']; },
      test:async () => calls.push('test'),
      commitPush:async () => calls.push('push'),
      findPr:async () => null,
      pr:async (_title,text) => { body = text; return 42; },
      removeWorktree:async () => {}
    };
    f.engine.ai = {
      code:async (_name,prompt) => { calls.push(prompt.startsWith('開発リード') ? 'revise' : 'code'); return 'できました\nUSER_FACING_CHANGES:\n- カメラに5秒タイマーを追加'; },
      ask:async () => ({approve:false,issues:['撮影処理を既存のカメラに寄せる']})
    };
    await f.engine.implement('task',{id:'builder1',name:'そら'});
    assert.deepEqual(calls,['code','revise','restore','test','push']);
    assert.equal(f.store.get('task').status,'pr_ready');
    assert.match(body,/^## 利用者向けの変更\n\n- カメラに5秒タイマーを追加/);
    assert.match(body,/Closes #5/);
    assert.match(body,/撮影処理を既存のカメラに寄せる/);
  } finally { f.close(); }
});

test('the completion post shows user-facing changes, unverified points and production checks', async () => {
  const f = fixture();
  try {
    f.store.create('task','ボタン配置');
    f.store.update('task',{status:'queued',summary:'目的: 揃えたい',criteria:JSON.stringify(['ボタンが揃う'])});
    f.store.setKv('production-checks:task', JSON.stringify(['実機で表示を確認']));
    f.engine.git = {
      ...f.engine.git,
      prepare:async () => {}, issue:async () => 7,
      resumeTaskWorktree:async () => null,
      worktree:async () => ({path:f.dir,branch:'agent/task-2'}),
      reviewDiff:async () => 'diff --git a/client b/client',
      restoreChangelog:async () => [],
      test:async () => {},
      commitPush:async () => {},
      findPr:async () => null,
      pr:async () => 43,
      removeWorktree:async () => {}
    };
    f.engine.ai = {
      code:async () => '直しました\nUNVERIFIED_POINTS:\n- スマホ幅の見た目は未確認\nUSER_FACING_CHANGES:\n- ボタンの位置が揃う',
      ask:async () => ({approve:true})
    };
    await f.engine.implement('task',{id:'builder1',name:'そら'});
    assert.equal(f.store.get('task').status,'pr_ready');
    const post = f.sent.at(-1).text;
    assert.match(post,/変更とテストが完了しました。PR #43/);
    assert.match(post,/変わること:\n- ボタンの位置が揃う/);
    assert.match(post,/未確認の点:\n- スマホ幅の見た目は未確認/);
    assert.match(post,/本番で確認をお願いしたい点:\n- 実機で表示を確認/);
  } finally { f.close(); }
});

test('an investigation with no code changes completes with a report instead of failing', async () => {
  const f = fixture();
  try {
    f.store.create('mystery','アバターが黒くなる');
    f.store.update('mystery',{status:'queued',summary:'見る人によって黒く表示される',criteria:JSON.stringify(['原因を特定する'])});
    f.store.setKv('investigation:mystery','1');
    let published = false;
    f.engine.git = {
      ...f.engine.git,
      prepare:async () => {}, issue:async () => 9,
      resumeTaskWorktree:async () => null,
      worktree:async () => ({path:f.dir,branch:'agent/mystery'}),
      reviewDiff:async () => '',
      restoreChangelog:async () => [],
      test:async () => {},
      hasChanges:async () => false,
      commitPush:async () => { published = true; },
      findPr:async () => null,
      pr:async () => { published = true; return 50; },
      removeWorktree:async () => {}
    };
    f.engine.ai = {
      code:async () => '調査報告: 画像の読み込み経路を確認し、仮説A（キャッシュ破損）は否定できました。次は表示側の証拠が必要です。\nUNVERIFIED_POINTS:\n- なし\nUSER_FACING_CHANGES:\n- なし',
      ask:async () => ({approve:true})
    };
    await f.engine.implement('mystery',{id:'builder1',name:'そら'});
    assert.equal(published,false);
    assert.equal(f.store.get('mystery').status,'waiting_info');
    const post = f.sent.at(-1).text;
    assert.match(post,/調査をしました。今回はコードの変更はありません。/);
    assert.match(post,/仮説A（キャッシュ破損）は否定できました/);
    assert.ok(f.store.events().some(event => event.kind === 'investigation'));
  } finally { f.close(); }
});

test('planning stores production checks and the investigation flag from PM', async () => {
  const f = fixture();
  try {
    f.store.create('big','大きな変更');
    f.engine.ai = { ask: async (_role, prompt) => {
      if (prompt.includes('開発案件として判断')) return { verdict:'implement', purpose:'目的', summary:'背景', criteria:['自動で確認できる'], productionChecks:['実機で表示を確認'], investigation:true, implementationTask:'調査して直す' };
      if (prompt.includes('開発リードとして')) return { task:'作業指示' };
      throw new Error(`unexpected prompt: ${prompt.slice(0, 40)}`);
    } };
    await f.engine.plan('big','投稿内容');
    assert.deepEqual(f.engine.productionChecks('big'), ['実機で表示を確認']);
    assert.equal(f.engine.investigation('big'), true);
    assert.match(f.sent.at(-1).text, /本番で確認: 実機で表示を確認/);
  } finally { f.close(); }
});

test('PM reviews a stopped ticket and requeues its saved worktree', async () => {
  const f = fixture();
  try {
    f.store.create('stopped','二段ジャンプ');
    f.store.update('stopped',{status:'failed',error:'main advanced; changelog check failed',branch:'agent/stopped'});
    f.engine.git.resumeTaskWorktree = async id => { assert.equal(id,'stopped'); return {path:f.dir}; };
    f.engine.ai = {ask:async (_name,prompt,options) => {
      assert.match(prompt,/変更履歴|changelog/);
      assert.equal(options.cwd,f.dir);
      return {retry:true,reason:'最新mainとの差分を調整できる',instruction:'既存の履歴を保持して再検証する'};
    }};
    await f.engine.reviewFailed('stopped');
    assert.equal(f.store.get('stopped').status,'queued');
    assert.equal(f.store.getKv('retry-instruction:stopped'),'既存の履歴を保持して再検証する');
    assert.equal(f.store.getKv('failed-review-count:stopped'),'1');
    assert.ok(f.store.events().some(event => event.kind === 'retry_scheduled'));
  } finally { f.close(); }
});

test('the second implementation failure asks the thread owner for instructions', async () => {
  const f = fixture();
  try {
    f.store.create('stopped','二段ジャンプ');
    f.store.update('stopped',{status:'queued',issue_number:162,branch:'agent/stopped'});
    f.engine.git.prepare = async () => {};
    f.engine.git.resumeTaskWorktree = async () => ({path:f.dir,branch:'agent/stopped',resumed:true});
    f.engine.ai = {
      code:async () => { throw new Error('changelog check failed'); },
      ask:async () => ({question:'既存履歴を復元して続けますか？'})
    };
    let automaticRetries = 0;
    f.engine.pmRetry = async id => { automaticRetries++; f.store.update(id,{status:'queued'}); return true; };
    f.engine.discord.threadOwnerId = async () => '12345678901234567';
    const worker = {id:'builder1',name:'そら'};
    await f.engine.implement('stopped',worker);
    assert.equal(automaticRetries,1);
    assert.equal(f.store.getKv('failure-count:stopped'),'1');
    await f.engine.implement('stopped',worker);
    assert.equal(automaticRetries,1);
    assert.equal(f.store.get('stopped').status,'waiting_info');
    assert.equal(f.store.getKv('failure-count:stopped'),'2');
    assert.equal(f.sent.at(-1).options.mentionUserId,'12345678901234567');
  } finally { f.close(); }
});

test('a user instruction resets the two-failure limit and resumes planning', async () => {
  const f = fixture();
  try {
    f.store.create('stopped','二段ジャンプ');
    f.store.update('stopped',{status:'waiting_info',last_message_id:'reply-1'});
    f.store.setKv('awaiting-instruction:stopped','1');
    f.store.setKv('failure-count:stopped',2);
    f.store.setKv('retry-count:stopped:code',2);
    f.engine.ai = {ask:async () => ({ready:true,title:'二段ジャンプ',summary:'ユーザーの指示に従って修正',criteria:['再検証する']})};
    let planned = false;
    f.engine.plan = async () => { planned = true; };
    await f.engine.feedback('stopped');
    assert.equal(planned,true);
    assert.equal(f.store.getKv('awaiting-instruction:stopped'),'0');
    assert.equal(f.store.getKv('failure-count:stopped'),'0');
    assert.equal(f.store.getKv('retry-count:stopped:code'),'0');
  } finally { f.close(); }
});

test('release attempts every ready PR even if the review omits one', async () => {
  const f = fixture();
  try {
    f.store.create('first','先に入れる変更');
    f.store.update('first',{status:'pr_ready',branch:'agent/first',pr_number:91});
    f.store.create('second','後に入れる変更');
    f.store.update('second',{status:'pr_ready',branch:'agent/second',pr_number:94});
    f.engine.config = {baseBranch:'main',githubRepo:'owner/repo',batchMs:0};
    f.engine.ai = {ask:async () => ({selectedIds:['second'],notes:''})};
    const visited = [];
    f.engine.git = {
      prInfo:async number => { visited.push(number); return {state:'MERGED',mergeCommit:{oid:'merged'}}; },
      baseHead:async () => 'merged'
    };
    assert.equal(await f.engine.release(true),true);
    assert.deepEqual(visited,[91,94]);
  } finally { f.close(); }
});

test('release keeps merging when the review agent is unavailable', async () => {
  const f = fixture();
  try {
    f.store.create('ticket','出荷できる変更');
    f.store.update('ticket',{status:'pr_ready',branch:'agent/ticket',pr_number:123});
    f.engine.config = {baseBranch:'main',githubRepo:'owner/repo',batchMs:0};
    f.engine.ai = {ask:async () => { throw new Error('model unavailable'); }};
    f.engine.git = {prInfo:async () => ({state:'MERGED',mergeCommit:{oid:'merge-sha'}}),baseHead:async () => 'merge-sha'};
    assert.equal(await f.engine.release(true),true);
    assert.equal(f.store.get('ticket').status,'merged');
    assert.ok(f.store.events().some(event => event.kind === 'selection_warning'));
  } finally { f.close(); }
});

test('shrinking the pool while busy never reassigns a removed role to a waiting ticket', async () => {
  const f = fixture();
  const original = roles.map(role => ({ ...role }));
  try {
    const assigned = await Promise.all(Array.from({ length: 5 }, (_, index) => f.engine.acquireRole('聞き取り', `ticket-${index}`)));
    let sixthRole = null;
    const sixth = f.engine.acquireRole('聞き取り', 'ticket-6').then(role => { sixthRole = role; return role; });
    // 稼働中に聞き取りを1人へ縮小する（管理画面の人数変更と同じく roles を差し替える）
    replaceRoles(roles.filter(role => role.job !== '聞き取り' || role.id === 'intake'));
    f.engine.reconcileRoles();
    // 担当者はランダムに選ばれるため、「残るロール」と「消えるロール」を実物で特定する
    const survivor = assigned.find(role => role.id === 'intake');
    const removed = assigned.find(role => role.id !== 'intake');
    assert.equal(f.engine.roleBusy.has('intake'), true);
    assert.equal(f.engine.roleBusy.has(removed.id), false);
    // 削除済みロールが解放されても、待機案件へそのロールは渡らない
    f.engine.releaseRole(removed);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(sixthRole, null);
    // 現行ロールが空いたら、待機案件はそのロールを受け取る
    f.engine.releaseRole(survivor);
    assert.equal((await sixth).id, 'intake');
    assert.equal(f.engine.roleBusy.get('intake'), 'ticket-6');
  } finally { replaceRoles(original); f.close(); }
});

// 案B: 判断を含む呼び出しには人格プロンプトを混ぜない（speaking を渡さない）。
// roleId（仕事の解決）は判断とは無関係なので従来どおり渡る
test('intake judgment calls do not request persona (no speaking flag)', async () => {
  const f = fixture();
  try {
    f.store.create('ticket-judge', '聞き取りの声');
    let seen;
    f.engine.ai = { ask: async (_role, _prompt, options) => { seen = options; return { ready: false, reply: 'もう少し教えてください', title: '件名', summary: '要約', criteria: [] }; } };
    await f.engine.feedback('ticket-judge');
    assert.equal(f.store.get('ticket-judge').status, 'waiting_info');
    assert.equal(seen.speaking, undefined);
    assert.match(seen.roleId, /^intake/);
  } finally { f.close(); }
});

test('support classification calls do not request persona (no speaking flag)', async () => {
  const f = fixture();
  try {
    f.store.create('ticket-support', '完了した対応');
    f.store.update('ticket-support', { status: 'merged', last_message_id: 'm2', answered_message_id: 'm1' });
    f.engine.discord.userMessage = async () => '使い方が分かりません';
    let seen;
    f.engine.ai = { ask: async (_role, _prompt, options) => { seen = options; return { action: 'answer', answer: 'こう使います', title: '', summary: '' }; } };
    await f.engine.followUp('ticket-support');
    assert.equal(seen.speaking, undefined);
    assert.equal(seen.roleId, 'support');
  } finally { f.close(); }
});

test('appeal classification calls do not request persona (no speaking flag)', async () => {
  const f = fixture();
  try {
    f.store.create('ticket-appeal', '見送った対応');
    f.store.update('ticket-appeal', { status: 'declined', last_message_id: 'm9', answered_message_id: 'm1' });
    f.engine.discord.userMessage = async () => '承知しました';
    let seen;
    f.engine.ai = { ask: async (_role, _prompt, options) => { seen = options; return { action: 'none', reply: '' }; } };
    await f.engine.appeal('ticket-appeal');
    assert.equal(seen.speaking, undefined);
    assert.equal(seen.roleId, 'pm');
  } finally { f.close(); }
});

test('PM verdict calls do not request persona (no speaking flag)', async () => {
  const f = fixture();
  try {
    let seen;
    f.engine.ai = { ask: async (_role, _prompt, options) => { seen = options; return { verdict: 'implement' }; } };
    await f.engine.pmReview({ id: 'ticket-pm', title: '件名' }, f.dir, []);
    assert.equal(seen.speaking, undefined);
    assert.equal(seen.roleId, 'pm');
  } finally { f.close(); }
});
