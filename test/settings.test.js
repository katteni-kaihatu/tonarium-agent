import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import {
  PERMISSIONS, sanitizePermissions, basePermissions, setBasePermissions, effectivePermissions,
  decisionUserIds, setDecisionUserIds, isDecisionUser,
  getPersonas, setPersonas, getMembers, resizeMembers, assignPersona, resolvedRoles,
  getPromptOverride, setPromptOverride, clearPromptOverride
} from '../src/settings.js';

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'tonarium-settings-'));
  const store = new Store(join(dir, 'state.sqlite'));
  return { store, close: () => { store.close(); rmSync(dir, { recursive: true, force: true }); } };
}
const config = { decisionMentionId: '111111111111111111', initialAdminMisskeyIds: ['root-user'] };

test('permissions are sanitized and base permissions never include admin', () => {
  const f = fixture();
  try {
    assert.deepEqual(sanitizePermissions(['project', 'project', 'bogus', 'character']), ['project', 'character']);
    assert.deepEqual(sanitizePermissions(['admin', 'project'], { allowAdmin: false }), ['project']);
    assert.deepEqual(sanitizePermissions(['admin', 'project'], { allowAdmin: true }), ['admin', 'project']);
    assert.deepEqual(setBasePermissions(f.store, ['admin', 'character']), ['character']);
    assert.deepEqual(basePermissions(f.store), ['character']);
  } finally { f.close(); }
});

test('effective permissions: initial admin gets all, others get base plus their record', () => {
  const f = fixture();
  try {
    assert.deepEqual(effectivePermissions(f.store, config, 'root-user'), PERMISSIONS);
    setBasePermissions(f.store, ['character']);
    assert.deepEqual(effectivePermissions(f.store, config, 'nobody'), ['character']);
    f.store.upsertAdmin({ misskeyId: 'alice', permissions: ['project'] });
    assert.deepEqual(new Set(effectivePermissions(f.store, config, 'alice')), new Set(['character', 'project']));
    f.store.upsertAdmin({ misskeyId: 'bob', permissions: ['admin'] });
    assert.ok(effectivePermissions(f.store, config, 'bob').includes('admin'));
  } finally { f.close(); }
});

test('decision users fall back to the env single user, then stored multiple users win', () => {
  const f = fixture();
  try {
    assert.deepEqual(decisionUserIds(f.store, config), ['111111111111111111']);
    assert.deepEqual(decisionUserIds(f.store, { decisionMentionId: 'not-a-snowflake' }), []);
    assert.equal(isDecisionUser(f.store, config, '111111111111111111'), true);
    assert.equal(isDecisionUser(f.store, config, '222222222222222222'), false);
    const saved = setDecisionUserIds(f.store, ['222222222222222222', '333333333333333333', '222222222222222222']);
    assert.deepEqual(saved, ['222222222222222222', '333333333333333333']);
    assert.deepEqual(decisionUserIds(f.store, config), saved);
    assert.equal(isDecisionUser(f.store, config, '333333333333333333'), true);
    assert.throws(() => setDecisionUserIds(f.store, ['123']), /Discord user ID/);
  } finally { f.close(); }
});

test('personas and members seed from the 30 default roles', () => {
  const f = fixture();
  try {
    const personas = getPersonas(f.store);
    assert.equal(personas.length, 30);
    assert.equal(personas.find(persona => persona.id === 'pm').name, 'さくら');
    assert.equal(personas.find(persona => persona.id === 'builder15').prompt, '');
    const members = getMembers(f.store);
    assert.equal(members.length, 30);
    assert.equal(members.filter(member => member.job === '実装').length, 15);
    assert.equal(members.find(member => member.id === 'pm').personaId, 'pm');
    // 二度目は保存済みの内容が返る
    assert.deepEqual(getPersonas(f.store), personas);
    assert.deepEqual(getMembers(f.store), members);
  } finally { f.close(); }
});

test('persona validation rejects duplicate ids, long names and long prompts', () => {
  const f = fixture();
  try {
    getPersonas(f.store);
    assert.throws(() => setPersonas(f.store, [{ id: 'x', name: 'a', prompt: '' }, { id: 'x', name: 'b', prompt: '' }]), /duplicated/);
    assert.throws(() => setPersonas(f.store, [{ id: 'x', name: 'a'.repeat(41), prompt: '' }]), /1-40/);
    assert.throws(() => setPersonas(f.store, [{ id: 'x', name: 'a', prompt: 'a'.repeat(8001) }]), /8000/);
    assert.throws(() => setPersonas(f.store, [{ id: '', name: 'a', prompt: '' }]), /must not be empty/);
  } finally { f.close(); }
});

test('resizeMembers refuses locked jobs and out-of-range counts', () => {
  const f = fixture();
  try {
    assert.throws(() => resizeMembers(f.store, 'PM', 1), /変更できません/);
    assert.throws(() => resizeMembers(f.store, '統合', 2), /変更できません/);
    assert.throws(() => resizeMembers(f.store, '実装', 16), /1〜15/);
    assert.throws(() => resizeMembers(f.store, '聞き取り', 0), /1〜10/);
    assert.throws(() => resizeMembers(f.store, '存在しない仕事', 1), /unknown job/);
  } finally { f.close(); }
});

test('resizeMembers shrinks from the end and regrows with the same id scheme and no persona', () => {
  const f = fixture();
  try {
    let members = resizeMembers(f.store, '実装', 12);
    let builders = members.filter(member => member.job === '実装');
    assert.equal(builders.length, 12);
    assert.equal(builders.at(-1).id, 'builder12');
    members = resizeMembers(f.store, '実装', 14);
    builders = members.filter(member => member.job === '実装');
    assert.deepEqual(builders.slice(12).map(member => member.id), ['builder13', 'builder14']);
    assert.ok(builders.slice(12).every(member => member.personaId === null));

    members = resizeMembers(f.store, '聞き取り', 3);
    assert.deepEqual(members.filter(member => member.job === '聞き取り').map(member => member.id), ['intake', 'intake2', 'intake3']);
    members = resizeMembers(f.store, '聞き取り', 4);
    assert.deepEqual(members.filter(member => member.job === '聞き取り').map(member => member.id), ['intake', 'intake2', 'intake3', 'intake4']);
  } finally { f.close(); }
});

test('assignPersona drives the resolved display name and avatar', () => {
  const f = fixture();
  try {
    setPersonas(f.store, [...getPersonas(f.store), { id: 'persona-x', name: 'テスト人格', prompt: '元気に話す' }]);
    assignPersona(f.store, 'builder1', 'persona-x');
    let resolved = resolvedRoles(getMembers(f.store), getPersonas(f.store));
    let builder1 = resolved.find(role => role.id === 'builder1');
    assert.equal(builder1.name, 'テスト人格');
    assert.equal(builder1.avatarId, 'persona-x');
    assert.equal(builder1.job, '実装');
    assert.throws(() => assignPersona(f.store, 'builder1', 'missing'), /unknown persona/);
    assert.throws(() => assignPersona(f.store, 'missing', null), /unknown member/);
    assignPersona(f.store, 'builder1', null);
    resolved = resolvedRoles(getMembers(f.store), getPersonas(f.store));
    builder1 = resolved.find(role => role.id === 'builder1');
    assert.equal(builder1.name, 'builder1');
    assert.equal(builder1.avatarId, 'builder1');
    assert.equal(builder1.personaId, null);
  } finally { f.close(); }
});

test('prompt overrides can be set, read and cleared, and reject unknown files', () => {
  const f = fixture();
  try {
    assert.equal(getPromptOverride(f.store, 'prompts/pm.md'), undefined);
    setPromptOverride(f.store, 'prompts/pm.md', '上書きした PM 指示');
    assert.equal(getPromptOverride(f.store, 'prompts/pm.md'), '上書きした PM 指示');
    assert.equal(getPromptOverride(f.store, 'WORKFLOW.md'), undefined);
    clearPromptOverride(f.store, 'prompts/pm.md');
    assert.equal(getPromptOverride(f.store, 'prompts/pm.md'), undefined);
    assert.throws(() => setPromptOverride(f.store, 'prompts/nope.md', 'x'), /unknown prompt file/);
    assert.throws(() => setPromptOverride(f.store, 'prompts/pm.md', '   '), /must not be empty/);
    assert.throws(() => clearPromptOverride(f.store, 'nope.md'), /unknown prompt file/);
  } finally { f.close(); }
});
