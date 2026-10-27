import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { MainRelease, entryFiles, normalizeEntries, prNumberFrom, tokyoStamp, userFacingSection } from '../src/main-release.js';

function fixture({ commits = [], open = [] } = {}) {
  const dir = mkdtempSync(join(tmpdir(),'tonarium-main-release-'));
  mkdirSync(join(dir,'release','changelog'),{recursive:true});
  const store = new Store(join(dir,'state.sqlite'));
  const calls = [], notices = [];
  const git = {
    fetchBranches:async () => calls.push('fetch'),
    revParse:async () => 'a'.repeat(40),
    openPrs:async () => open,
    firstParentCommits:async () => commits,
    prDetails:async number => ({title:`PR ${number}`,body:number === 7 ? '## 利用者向けの変更\n\n- カメラにタイマーを追加\n\n## 背景と目的\n' : '',author:'dev'}),
    commitDiff:async sha => ({stat:'1 file changed',diff:'+code',addedChangelog:sha === 'old' ? ['changelog/2026-10-26-old.json'] : []}),
    releaseWorktree:async () => ({path:join(dir,'release'),branch:'release/main-test'}),
    git:async args => { calls.push(args.join(' ')); return {stdout:'head-sha'}; },
    pushWithRetry:async () => calls.push('push'),
    createPr:async (_title,body) => { calls.push('pr'); calls.body = body; return 99; },
    waitForChecks:async () => calls.push('checks'),
    mergePr:async (number,head,base) => { calls.push(`merge ${number} ${head} ${base}`); return 'merge-sha'; },
    closePr:async number => calls.push(`close ${number}`),
    removeWorktree:async () => calls.push('cleanup')
  };
  const ai = {ask:async () => ({entries:[{slug:'camera-timer',title:'カメラのタイマー',items:['5秒後に撮影できます'],units:['u1']}]})};
  const release = new MainRelease({mainBranch:'main',baseBranch:'develop',githubRepo:'owner/repo'},store,ai,git,async (text,options) => notices.push({text,options}));
  return {dir,store,calls,notices,git,ai,release,close:() => { store.close(); rmSync(dir,{recursive:true,force:true}); }};
}

test('PR bodies give the user-facing section and PR numbers come from merge subjects', () => {
  assert.deepEqual(userFacingSection('## 利用者向けの変更\n\n<!-- 説明 -->\n- 地図を拡大できる\n- なし\n\n## 背景と目的\n- 関係ない'),['地図を拡大できる']);
  assert.deepEqual(userFacingSection('本文だけ'),[]);
  assert.equal(prNumberFrom('Merge pull request #295 from katteni-kaihatu/agent/task'),295);
  assert.equal(prNumberFrom('Fix camera (#12)'),12);
  assert.equal(prNumberFrom('Direct commit'),null);
});

test('changelog entries are validated and changes the AI left out become a maintenance entry', () => {
  const units = [{id:'u1',sha:'1111111',pr:7,title:'タイマー',userFacing:['タイマー'],recorded:false},{id:'u2',sha:'2222222',pr:null,title:'CI を調整',userFacing:[],recorded:false},{id:'u3',sha:'3333333',pr:8,title:'旧運用',userFacing:[],recorded:true}];
  const entries = normalizeEntries({entries:[{slug:'Camera Timer!',title:'タイマー',items:['5秒後に撮影'],units:['u1','u3']},{title:'',items:['壊れた']}]},units);
  assert.deepEqual(entries.map(entry => [entry.slug,entry.title,entry.tag]),[['camera-timer','タイマー',undefined],['maintenance','開発・保守の更新','開発・保守']]);
  assert.deepEqual(entries[1].items,['CI を調整']);
  const now = Date.parse('2026-10-27T06:05:00Z');
  assert.deepEqual(tokyoStamp(now),{date:'2026-10-27',hhmm:'1505',label:'2026-10-27 15:05 JST'});
  const files = entryFiles([...entries,{...entries[0]}],now);
  assert.deepEqual(files.map(file => file.file),['2026-10-27-rel1505-camera-timer.json','2026-10-27-rel1505-maintenance.json','2026-10-27-rel1505-camera-timer-2.json']);
  assert.deepEqual(files[1].content,{date:'2026-10-27',title:'開発・保守の更新',items:['CI を調整'],tag:'開発・保守'});
});

test('main release skips when develop has nothing new', async () => {
  const f = fixture();
  try {
    assert.equal((await f.release.run({log:() => {}})).status,'skipped');
    assert.ok(!f.calls.includes('pr'));
  } finally { f.close(); }
});

test('main release merges a develop snapshot with per-feature changelog files and marks threads', async () => {
  const f = fixture({commits:[{sha:'s1',parents:['p1','p2'],author:'bot',subject:'Merge pull request #7 from org/agent/task',body:'カメラのタイマー'},{sha:'old',parents:['p0'],author:'dev',subject:'Old change with changelog',body:''}]});
  try {
    f.store.create('thread-7','タイマー');
    f.store.update('thread-7',{status:'merged',pr_number:7,merged_branch:'develop'});
    const result = await f.release.run({now:Date.parse('2026-10-27T06:05:00Z'),log:() => {}});
    assert.equal(result.status,'merged');
    assert.deepEqual(JSON.parse(readFileSync(join(f.dir,'release','changelog','2026-10-27-rel1505-camera-timer.json'),'utf8')),{date:'2026-10-27',title:'カメラのタイマー',items:['5秒後に撮影できます']});
    assert.ok(f.calls.some(call => call.startsWith('merge --no-ff')));
    assert.ok(f.calls.includes('add -- changelog/2026-10-27-rel1505-camera-timer.json'));
    assert.ok(f.calls.includes(`merge 99 head-sha main`));
    assert.match(f.calls.body,/Develop snapshot: a{40}/);
    assert.match(f.calls.body,/旧運用で履歴を記録済み/);
    f.git.prDetails = async () => null;
    assert.equal((await f.release.collect([{sha:'s9',parents:['p9'],author:'bot',subject:'Merge pull request #9 from org/x',body:'地図を拡大\n詳細'}]))[0].title,'地図を拡大');
    assert.equal(f.store.getKv('main-released:thread-7'),'1');
    assert.match(f.notices[0].text,/main に反映しました（PR #99）/);
    assert.equal(f.notices[0].options,undefined);
  } finally { f.close(); }
});

test('a dry run prints the plan without pushing, opening a PR or notifying', async () => {
  const f = fixture({commits:[{sha:'s1',parents:['p1'],author:'dev',subject:'Direct fix',body:''}]});
  try {
    const lines = [];
    const result = await f.release.run({dryRun:true,log:line => lines.push(line)});
    assert.equal(result.status,'dry-run');
    assert.ok(!f.calls.includes('push') && !f.calls.includes('pr'));
    assert.match(lines.join('\n'),/camera-timer/);
    assert.equal(f.notices.length,0);
  } finally { f.close(); }
});

test('a failed main release notifies the decision maker once and waits for develop to change', async () => {
  const f = fixture({commits:[{sha:'s1',parents:['p1'],author:'dev',subject:'Direct fix',body:''}]});
  try {
    f.git.waitForChecks = async () => { throw new Error('PR #99 checks failed: web'); };
    await assert.rejects(f.release.run({log:() => {}}),/checks failed/);
    assert.equal(f.notices.length,1);
    assert.equal(f.notices[0].options.mention,true);
    f.git.openPrs = async () => [{number:99,headRefName:'release/main-test',headRefOid:'head-sha',body:`Develop snapshot: ${'a'.repeat(40)}`}];
    assert.equal((await f.release.run({log:() => {}})).status,'blocked');
    f.git.revParse = async () => 'b'.repeat(40);
    f.git.waitForChecks = async () => {};
    const result = await f.release.run({log:() => {}});
    assert.ok(f.calls.includes('close 99'));
    assert.equal(result.status,'merged');
    assert.equal(f.notices.length,2);
  } finally { f.close(); }
});
