import test from 'node:test';
import assert from 'node:assert/strict';
import { replaceRoles, roles } from '../src/config.js';
import { AI } from '../src/ai.js';

// 人格の割り当てで名前が重複しても、仕事（プロンプト）の解決はメンバー ID で決まること
test('guidance resolves the job by member id when persona names collide across jobs', async () => {
  const original = roles.map(role => ({ ...role }));
  try {
    replaceRoles([
      { id: 'pm', name: 'さくら', job: 'PM', color: 'rose', personaId: 'pm', avatarId: 'pm' },
      { id: 'builder1', name: 'さくら', job: '実装', color: 'blue', personaId: 'pm', avatarId: 'pm' }
    ]);
    let seenPersonaId = null;
    const ai = new AI({}, undefined, {
      personaPrompt: (personaId, name) => { seenPersonaId = personaId; return 'PERSONA-TEXT'; }
    });
    const builderGuidance = await ai.guidance('さくら', { speaking: true, roleId: 'builder1' });
    assert.match(builderGuidance, /割り当てられた worktree/); // prompts/builder.md
    assert.doesNotMatch(builderGuidance, /案件の目的を確かめ/); // prompts/pm.md ではない
    assert.equal(seenPersonaId, 'pm'); // 人格は ID で引かれている
    const pmGuidance = await ai.guidance('さくら', { speaking: true, roleId: 'pm' });
    assert.match(pmGuidance, /案件の目的を確かめ/);
    // roleId なし（従来の名前解決）も一意な名前では従来どおり動く
    const byName = await ai.guidance('さくら');
    assert.ok(byName.length > 0);
  } finally {
    replaceRoles(original);
  }
});

// メンバー ID で解決できた呼び出しでは、人格の解決が strict（personaId のみ）になること
test('guidance marks the persona lookup strict only when the member id resolves', async () => {
  const original = roles.map(role => ({ ...role }));
  try {
    replaceRoles([
      { id: 'builder1', name: 'そら', job: '実装', color: 'blue', personaId: null, avatarId: 'builder1' },
      { id: 'builder2', name: 'ゆず', job: '実装', color: 'blue', personaId: 'builder2', avatarId: 'builder2' }
    ]);
    const seen = [];
    const ai = new AI({}, undefined, {
      personaPrompt: (personaId, name, options) => { seen.push({ personaId, options }); return ''; }
    });
    await ai.guidance('そら', { speaking: true, roleId: 'builder1' });
    assert.deepEqual(seen[0], { personaId: null, options: { strict: true } });
    await ai.guidance('ゆず', { speaking: true });
    assert.deepEqual(seen[1], { personaId: 'builder2', options: { strict: false } });
  } finally {
    replaceRoles(original);
  }
});
