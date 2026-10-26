import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../src/store.js';

test('ticket state and events survive a restart; interrupted work is queued', () => {
  const dir = mkdtempSync(join(tmpdir(),'tonarium-store-'));
  const path = join(dir,'state.sqlite');
  try {
    let store = new Store(path);
    store.create('thread-1','要望');
    store.update('thread-1',{status:'coding',worker:'builder1',criteria:JSON.stringify(['表示される'])});
    store.update('thread-1',{base_sha:'abc123',answered_message_id:'answer-1'});
    store.event('thread-1','そら','coding','着手');
    store.close();
    store = new Store(path);
    assert.equal(store.get('thread-1').status,'coding');
    store.recover();
    assert.equal(store.get('thread-1').status,'queued');
    assert.equal(store.get('thread-1').worker,null);
    assert.equal(store.get('thread-1').base_sha,'abc123');
    assert.equal(store.get('thread-1').answered_message_id,'answer-1');
    assert.equal(store.events()[0].text,'着手');
    store.close();
  } finally { rmSync(dir,{recursive:true,force:true}); }
});

test('existing merged tickets retain their main branch label after migration', () => {
  const dir = mkdtempSync(join(tmpdir(),'tonarium-store-migrate-'));
  const path = join(dir,'state.sqlite');
  try {
    const store = new Store(path);
    store.create('old-ticket','以前の案件');
    store.update('old-ticket',{status:'merged'});
    store.close();
    const db = new DatabaseSync(path);
    db.exec('ALTER TABLE tickets DROP COLUMN merged_branch');
    db.close();
    const migrated = new Store(path);
    assert.equal(migrated.get('old-ticket').merged_branch,'main');
    migrated.close();
  } finally { rmSync(dir,{recursive:true,force:true}); }
});
