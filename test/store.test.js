import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';

test('ticket state and events survive a restart; interrupted work is queued', () => {
  const dir = mkdtempSync(join(tmpdir(),'tonarium-store-'));
  const path = join(dir,'state.sqlite');
  try {
    let store = new Store(path);
    store.create('thread-1','要望');
    store.update('thread-1',{status:'coding',worker:'builder1',criteria:JSON.stringify(['表示される'])});
    store.event('thread-1','そら','coding','着手');
    store.close();
    store = new Store(path);
    assert.equal(store.get('thread-1').status,'coding');
    store.recover();
    assert.equal(store.get('thread-1').status,'queued');
    assert.equal(store.get('thread-1').worker,null);
    assert.equal(store.events()[0].text,'着手');
    store.close();
  } finally { rmSync(dir,{recursive:true,force:true}); }
});
