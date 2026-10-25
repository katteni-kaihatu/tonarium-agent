import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { syncThreadStatus, threadStatusName } from '../src/thread-status.js';

test('thread status uses the saved ticket state after a Discord rate limit', async () => {
  const dir = mkdtempSync(join(tmpdir(),'tonarium-thread-status-'));
  const store = new Store(join(dir,'state.sqlite'));
  try {
    store.create('thread-1','二段ジャンプ');
    store.update('thread-1',{status:'waiting_info'});
    const patches = [];
    let limited = true;
    const fetcher = async (_url,options) => {
      if (options.method === 'PATCH') {
        const name = JSON.parse(options.body).name;
        patches.push(name);
        if (limited) return {status:429,json:async () => ({retry_after:1})};
        return {ok:true,status:200};
      }
      return {ok:true,json:async () => ({name:'❓ 回答待ち｜二段ジャンプ'})};
    };
    assert.equal(await syncThreadStatus({discordToken:'set'},store,'thread-1',fetcher),true);
    store.update('thread-1',{status:'coding'});
    store.setKv('thread-status-dirty:thread-1','1');
    assert.equal(await syncThreadStatus({discordToken:'set'},store,'thread-1',fetcher),false);
    assert.equal(patches[0],'🛠️ 実装中｜二段ジャンプ');
    limited = false;
    store.setKv('thread-status-retry-after:thread-1',0);
    assert.equal(await syncThreadStatus({discordToken:'set'},store,'thread-1',fetcher),true);
    assert.equal(patches[1],'🛠️ 実装中｜二段ジャンプ');
    assert.equal(store.getKv('thread-status-dirty:thread-1'),'0');
    assert.equal(threadStatusName('🛠️ 実装中｜二段ジャンプ',{emoji:'✅',label:'mainへマージ済み'}),'✅ mainへマージ済み｜二段ジャンプ');
    store.update('thread-1',{status:'pr_ready'});
    store.setKv('thread-status-retry-after:thread-1',0);
    const names = [];
    await syncThreadStatus({discordToken:'set'},store,'thread-1',async (_url,options) => {
      if (options.method === 'PATCH') { names.push(JSON.parse(options.body).name); return {ok:true,status:200}; }
      return {ok:true,json:async () => ({name:'❓ 二段ジャンプ'})};
    });
    assert.deepEqual(names,['🧪 PR確認待ち｜二段ジャンプ']);
  } finally { store.close(); rmSync(dir,{recursive:true,force:true}); }
});
