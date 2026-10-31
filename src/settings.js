import { roles, JOB_RULES, replaceRoles } from './config.js';

// 設定の正本は SQLite (kv / admin_users)。ファイルと env は初期値（seed）として使う。
// このモジュールが読み込まれた時点の roles は既定値なので、それを seed の元として固定する。
const DEFAULT_ROLES = roles.map(role => ({ ...role }));

export const PERMISSIONS = ['admin','character','project'];

const parseJson = (raw, fallback) => {
  if (raw === undefined || raw === null || raw === '') return fallback;
  try { const value = JSON.parse(raw); return value ?? fallback; } catch { return fallback; }
};

export function sanitizePermissions(list, { allowAdmin = false } = {}) {
  if (!Array.isArray(list)) return [];
  const result = [...new Set(list.filter(value => PERMISSIONS.includes(value)))];
  return allowAdmin ? result : result.filter(value => value !== 'admin');
}

export function basePermissions(store) {
  return sanitizePermissions(parseJson(store.getKv('base_permissions'), []), { allowAdmin:false });
}

export function setBasePermissions(store, list) {
  // ベース権限（Misskey アカウントさえあれば使える権限）に管理権限は絶対に入れない
  const permissions = sanitizePermissions(list, { allowAdmin:false });
  store.setKv('base_permissions', JSON.stringify(permissions));
  return permissions;
}

export function isInitialAdmin(config, misskeyId) {
  return Boolean(misskeyId) && (config?.initialAdminMisskeyIds || []).includes(misskeyId);
}

export function effectivePermissions(store, config, misskeyId) {
  if (isInitialAdmin(config, misskeyId)) return [...PERMISSIONS];
  const permissions = new Set(basePermissions(store));
  const record = misskeyId ? store.getAdmin?.(misskeyId) : undefined;
  if (record) for (const permission of sanitizePermissions(parseJson(record.permissions, []), { allowAdmin:true })) permissions.add(permission);
  return [...permissions];
}

const snowflake = value => /^\d{17,20}$/.test(String(value || '')) ? String(value) : '';

export function decisionUserIds(store, config) {
  const stored = store.getKv('decision_discord_user_ids');
  if (stored !== undefined) return [...new Set(parseJson(stored, []).map(snowflake).filter(Boolean))];
  const fallback = snowflake(config?.decisionMentionId);
  return fallback ? [fallback] : [];
}

export function setDecisionUserIds(store, ids) {
  if (!Array.isArray(ids)) throw new Error('decision user ids must be an array');
  const cleaned = ids.map(value => snowflake(value));
  if (cleaned.some(value => !value)) throw new Error('decision user ids must be Discord user IDs (17-20 digits)');
  const result = [...new Set(cleaned)];
  store.setKv('decision_discord_user_ids', JSON.stringify(result));
  return result;
}

export function isDecisionUser(store, config, authorId) {
  return decisionUserIds(store, config).includes(String(authorId || ''));
}

// ---- キャラ人格（personas）: 名前・アイコン・人格プロンプトの定義体。メンバー枠とは独立 ----

export function getPersonas(store) {
  const stored = store.getKv('personas');
  if (stored !== undefined) return parseJson(stored, []);
  const seed = DEFAULT_ROLES.map(role => ({ id: role.id, name: role.name, prompt: '' }));
  store.setKv('personas', JSON.stringify(seed));
  return seed;
}

export function setPersonas(store, personas) {
  if (!Array.isArray(personas)) throw new Error('personas must be an array');
  const seen = new Set();
  const cleaned = personas.map(persona => {
    const id = String(persona?.id || '').trim();
    const name = String(persona?.name || '').trim();
    const prompt = String(persona?.prompt || '');
    if (!id) throw new Error('persona id must not be empty');
    if (seen.has(id)) throw new Error(`persona id is duplicated: ${id}`);
    seen.add(id);
    if (!name || name.length > 40) throw new Error(`persona name must be 1-40 characters: ${id}`);
    if (prompt.length > 8000) throw new Error(`persona prompt is too long (max 8000): ${id}`);
    return { id, name, prompt };
  });
  store.setKv('personas', JSON.stringify(cleaned));
  return cleaned;
}

// ---- メンバー（members）: 仕事ごとの枠。人数と人格の割り当てだけを持つ ----

export function getMembers(store) {
  const stored = store.getKv('members');
  if (stored !== undefined) return parseJson(stored, []);
  const seed = DEFAULT_ROLES.map(role => ({ id: role.id, job: role.job, personaId: role.id }));
  store.setKv('members', JSON.stringify(seed));
  return seed;
}

// 「デフォルトから変わっている」メンバーの集合。担当者選びで優先するために使う:
// - 人格の割り当てが種の既定（自分と同じ ID の人格）と違う
// - 割り当てられた人格が新規作成されたもの、既定から改名されたもの、
//   または人格プロンプトが設定されたもの
export function customizedMemberIds(store) {
  const personas = getPersonas(store);
  const defaultName = id => DEFAULT_ROLES.find(role => role.id === id)?.name;
  const changed = new Set();
  for (const member of getMembers(store)) {
    if (member.personaId && member.personaId !== member.id) { changed.add(member.id); continue; }
    const persona = personas.find(entry => entry.id === member.personaId);
    if (!persona) continue;
    if (defaultName(persona.id) === undefined || persona.name !== defaultName(persona.id) || String(persona.prompt || '').trim()) changed.add(member.id);
  }
  return changed;
}

const jobRule = job => JOB_RULES.find(rule => rule.job === job);

export function setMembers(store, members) {
  if (!Array.isArray(members)) throw new Error('members must be an array');
  const seen = new Set();
  const counts = new Map();
  const cleaned = members.map(member => {
    const id = String(member?.id || '').trim();
    const job = String(member?.job || '');
    if (!id) throw new Error('member id must not be empty');
    if (seen.has(id)) throw new Error(`member id is duplicated: ${id}`);
    seen.add(id);
    if (!jobRule(job)) throw new Error(`unknown job: ${job}`);
    counts.set(job, (counts.get(job) || 0) + 1);
    return { id, job, personaId: member?.personaId ?? null };
  });
  for (const rule of JOB_RULES) {
    const count = counts.get(rule.job) || 0;
    if (count < rule.min || count > rule.max) throw new Error(`${rule.job} must have ${rule.min}-${rule.max} members (got ${count})`);
  }
  store.setKv('members', JSON.stringify(cleaned));
  return cleaned;
}

// メンバー ID の数値サフィックス。接頭辞だけの ID（intake 等）は 1 として数える
const memberNumber = (rule, id) => {
  if (id === rule.prefix) return 1;
  if (!id.startsWith(rule.prefix)) return null;
  const rest = id.slice(rule.prefix.length);
  return /^\d+$/.test(rest) ? Number(rest) : null;
};

export function resizeMembers(store, job, count) {
  const rule = jobRule(job);
  if (!rule) throw new Error(`unknown job: ${job}`);
  if (rule.locked) throw new Error(`${job} の人数は変更できません`);
  if (!Number.isInteger(count) || count < rule.min || count > rule.max) throw new Error(`${job} の人数は ${rule.min}〜${rule.max} です`);
  const members = getMembers(store);
  const mine = members.filter(member => member.job === job);
  if (count < mine.length) {
    const remove = new Set(mine.slice(count).map(member => member.id));
    return setMembers(store, members.filter(member => !remove.has(member.id)));
  }
  const next = [...members];
  const used = new Set(mine.map(member => memberNumber(rule, member.id)).filter(value => value !== null));
  while (next.filter(member => member.job === job).length < count) {
    let n = 1;
    while (used.has(n)) n++;
    used.add(n);
    // builder だけは最初から builder1 のように番号付き。それ以外は1人目が接頭辞のみ
    const id = n === 1 && rule.prefix !== 'builder' ? rule.prefix : `${rule.prefix}${n}`;
    next.push({ id, job, personaId: null });
  }
  return setMembers(store, next);
}

export function assignPersona(store, memberId, personaId) {
  const members = getMembers(store);
  const member = members.find(entry => entry.id === memberId);
  if (!member) throw new Error(`unknown member: ${memberId}`);
  if (personaId !== null && personaId !== undefined && personaId !== '') {
    if (!getPersonas(store).some(persona => persona.id === personaId)) throw new Error(`unknown persona: ${personaId}`);
    member.personaId = personaId;
  } else member.personaId = null;
  return setMembers(store, members);
}

export function resolvedRoles(members, personas) {
  const byId = new Map(personas.map(persona => [persona.id, persona]));
  return members.map(member => {
    const persona = member.personaId ? byId.get(member.personaId) : undefined;
    return {
      id: member.id,
      name: persona?.name || member.id,
      job: member.job,
      color: jobRule(member.job)?.color || 'blue',
      personaId: member.personaId ?? null,
      avatarId: persona?.id || member.id
    };
  });
}

export function applySettings(store, config) {
  const resolved = resolvedRoles(getMembers(store), getPersonas(store));
  replaceRoles(resolved);
  return roles;
}

// ---- プロンプト上書き: ファイルが既定値、DB にあればそちらを優先 ----

export const PROMPT_FILES = [
  'WORKFLOW.md', 'policy/guardrails.md',
  'prompts/intake.md', 'prompts/pm.md', 'prompts/lead.md', 'prompts/builder.md',
  'prompts/support.md', 'prompts/integrator.md', 'prompts/release.md', 'prompts/main-release.md',
  'prompts/translator.md', 'prompts/review.md', 'prompts/speech.md'
];

const promptOverrides = store => {
  const parsed = parseJson(store.getKv('prompt_overrides'), {});
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
};

export function getPromptOverride(store, file) {
  const value = promptOverrides(store)[file];
  return typeof value === 'string' ? value : undefined;
}

export function setPromptOverride(store, file, content) {
  if (!PROMPT_FILES.includes(file)) throw new Error(`unknown prompt file: ${file}`);
  const text = String(content || '');
  if (!text.trim()) throw new Error('prompt content must not be empty');
  if (text.length > 60_000) throw new Error('prompt content is too long (max 60000)');
  const overrides = promptOverrides(store);
  overrides[file] = text;
  store.setKv('prompt_overrides', JSON.stringify(overrides));
  return text;
}

export function clearPromptOverride(store, file) {
  if (!PROMPT_FILES.includes(file)) throw new Error(`unknown prompt file: ${file}`);
  const overrides = promptOverrides(store);
  delete overrides[file];
  store.setKv('prompt_overrides', JSON.stringify(overrides));
}

// AI へ渡すフック一式。人格プロンプトは人格 ID で引く（名前は重複しうるため、名前は予備）。
// strict（メンバー ID で解決できた呼び出し）では personaId が正本で、未割当（null）や
// 見つからない ID のときに同名の別人格へ寄せない。名前フォールバックは ID 解決を
// していない従来の呼び出しだけに残す
export function aiHooks(store) {
  return {
    personaPrompt: (personaId, name, { strict = false } = {}) => {
      const personas = getPersonas(store);
      const byId = personaId ? personas.find(persona => persona.id === personaId) : undefined;
      if (byId) return byId.prompt;
      if (strict) return '';
      return personas.find(persona => persona.name === name)?.prompt || '';
    },
    promptOverride: file => getPromptOverride(store, file)
  };
}
