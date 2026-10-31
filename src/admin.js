import { readFile, writeFile, copyFile, mkdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { JOB_RULES } from './config.js';
import {
  PERMISSIONS, sanitizePermissions, basePermissions, setBasePermissions,
  effectivePermissions, isInitialAdmin, decisionUserIds, setDecisionUserIds,
  getPersonas, setPersonas, getMembers, resizeMembers, assignPersona, applySettings,
  PROMPT_FILES, getPromptOverride, setPromptOverride, clearPromptOverride
} from './settings.js';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const parseJson = (raw, fallback) => { try { return JSON.parse(raw || ''); } catch { return fallback; } };

function sendJson(response, status, body, headers = {}) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  response.end(JSON.stringify(body));
}

async function readJsonBody(request, max = 6 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > max) throw new Error('request body is too large');
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text.trim()) return {};
  const body = JSON.parse(text);
  if (!body || typeof body !== 'object') throw new Error('request body must be a JSON object');
  return body;
}

export class AdminConsole {
  constructor(config, store, auth, { dataRoot, publicRoot, onChange = () => {} } = {}) {
    Object.assign(this, { config, store, auth, dataRoot, publicRoot, onChange });
  }

  audit(user, text) {
    this.store.event(null, user.displayName || user.username || user.misskeyId, 'admin', text);
  }

  async servePublic(response, file, type) {
    try {
      const content = await readFile(join(this.publicRoot, 'public', file));
      response.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' });
      response.end(content);
    } catch { response.writeHead(500); response.end('Admin page unavailable'); }
  }

  async serveAvatar(response, filename, request = null) {
    if (!/^[a-zA-Z0-9_-]+\.png$/.test(filename)) { response.writeHead(404); response.end('Not found'); return; }
    for (const candidate of [join(this.dataRoot, 'avatars', filename), join(this.publicRoot, 'public', 'avatars', filename)]) {
      try {
        const info = await stat(candidate);
        if (!info.isFile()) continue;
        // 検証子（ETag / Last-Modified）を付けて no-cache の再検証が正しく効くようにする。
        // 検証子が無いとブラウザが手元の古い画像を使い続ける場合がある。
        const etag = `"${info.size}-${Math.round(info.mtimeMs)}"`;
        const headers = { 'Content-Type': 'image/png', 'Cache-Control': 'no-cache', ETag: etag, 'Last-Modified': info.mtime.toUTCString(), 'X-Content-Type-Options': 'nosniff' };
        const ifNoneMatch = request?.headers?.['if-none-match'];
        const ifModifiedSince = request?.headers?.['if-modified-since'];
        const fresh = ifNoneMatch
          ? ifNoneMatch.split(',').map(value => value.trim()).includes(etag)
          : ifModifiedSince && !Number.isNaN(Date.parse(ifModifiedSince)) && Math.floor(info.mtimeMs / 1000) <= Math.floor(Date.parse(ifModifiedSince) / 1000);
        if (fresh) { response.writeHead(304, headers); response.end(); return; }
        const content = await readFile(candidate);
        response.writeHead(200, headers);
        response.end(content);
        return;
      } catch { /* 次の候補へ */ }
    }
    response.writeHead(404); response.end('Not found');
  }

  async handle(request, response, url) {
    const path = url.pathname;
    if (path === '/admin' || path === '/admin/') { await this.servePublic(response, 'admin.html', 'text/html; charset=utf-8'); return true; }
    if (path === '/admin.js') { await this.servePublic(response, 'admin.js', 'text/javascript; charset=utf-8'); return true; }
    if (path === '/admin/login') {
      try {
        const { url, cookie } = this.auth.beginLogin(request);
        response.writeHead(302, { Location: url, 'Set-Cookie': cookie, 'Cache-Control': 'no-store' });
        response.end();
      } catch (error) {
        const limited = error.code === 'RATE_LIMITED';
        if (!limited && error.code !== 'ADMIN_DISABLED') console.error('Admin login failed:', error);
        response.writeHead(limited ? 429 : 503, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
        response.end(limited ? 'ログイン試行が多すぎます。しばらく待ってからお試しください。\n' : '管理画面ログインは無効です（ADMIN_PUBLIC_URL が未設定です）。\n');
      }
      return true;
    }
    if (path === '/admin/auth/callback') { await this.auth.handleCallback(request, response, url); return true; }
    if (path.startsWith('/avatars/')) { await this.serveAvatar(response, path.slice('/avatars/'.length), request); return true; }
    if (path.startsWith('/api/admin/')) { await this.api(request, response, url); return true; }
    return false;
  }

  async api(request, response, url) {
    const path = url.pathname;
    const method = request.method;
    const user = this.auth.sessionUser(request);
    if (!user) return sendJson(response, 401, { error: 'unauthorized' });
    if (method !== 'GET') {
      const origin = request.headers.origin;
      if (origin && origin !== this.auth.publicOrigin()) return sendJson(response, 403, { error: 'origin mismatch' });
    }
    const permissions = effectivePermissions(this.store, this.config, user.misskeyId);
    const has = permission => permissions.includes(permission);
    const deny = () => sendJson(response, 403, { error: 'forbidden' });
    try {
      if (method === 'GET' && path === '/api/admin/me') {
        return sendJson(response, 200, { user, permissions, isInitialAdmin: isInitialAdmin(this.config, user.misskeyId) });
      }
      if (method === 'POST' && path === '/api/admin/logout') {
        const cookie = this.auth.logout(request);
        return sendJson(response, 200, { ok: true }, { 'Set-Cookie': cookie });
      }
      if (method === 'GET' && path === '/api/admin/state') return sendJson(response, 200, this.state(user, permissions));

      if (method === 'PUT' && path === '/api/admin/base-permissions') {
        if (!has('admin')) return deny();
        const body = await readJsonBody(request);
        const saved = setBasePermissions(this.store, body.permissions);
        this.audit(user, `ベース権限を変更: ${saved.join(', ') || 'なし'}`);
        return sendJson(response, 200, { basePermissions: saved });
      }
      if (method === 'POST' && path === '/api/admin/admins') {
        if (!has('admin')) return deny();
        const body = await readJsonBody(request);
        const misskeyId = String(body.misskeyId || '').trim();
        if (!misskeyId || misskeyId.length > 64) return sendJson(response, 400, { error: 'misskeyId is required (max 64 chars)' });
        const saved = this.store.upsertAdmin({
          misskeyId,
          username: body.username ? String(body.username).slice(0, 100) : null,
          displayName: body.displayName ? String(body.displayName).slice(0, 100) : null,
          permissions: sanitizePermissions(body.permissions, { allowAdmin: true }),
          createdBy: user.misskeyId
        });
        this.audit(user, `管理者を追加/更新: ${misskeyId}`);
        return sendJson(response, 200, { admin: this.adminRow(saved) });
      }
      const adminTarget = path.match(/^\/api\/admin\/admins\/(.+)$/);
      if (adminTarget && (method === 'PUT' || method === 'DELETE')) {
        if (!has('admin')) return deny();
        const targetId = decodeURIComponent(adminTarget[1]);
        if (isInitialAdmin(this.config, targetId)) return sendJson(response, 400, { error: '初期管理者の権限は変更できません' });
        if (method === 'DELETE') {
          this.store.deleteAdmin(targetId);
          this.audit(user, `管理者を削除: ${targetId}`);
          return sendJson(response, 200, { ok: true });
        }
        const body = await readJsonBody(request);
        const saved = this.store.upsertAdmin({ misskeyId: targetId, permissions: sanitizePermissions(body.permissions, { allowAdmin: true }), createdBy: user.misskeyId });
        this.audit(user, `管理者の権限を変更: ${targetId}`);
        return sendJson(response, 200, { admin: this.adminRow(saved) });
      }

      if (method === 'POST' && path === '/api/admin/personas') {
        if (!has('character')) return deny();
        const body = await readJsonBody(request);
        const id = `persona-${randomUUID().slice(0, 8)}`;
        const personas = setPersonas(this.store, [...getPersonas(this.store), { id, name: body.name, prompt: body.prompt || '' }]);
        // 新規人格のアイコンは仮置きとして既存のものをコピーしておく（画面から差し替え可能）
        const placeholder = join(this.publicRoot, 'public', 'avatars', 'support.png');
        if (existsSync(placeholder)) {
          await mkdir(join(this.dataRoot, 'avatars'), { recursive: true });
          await copyFile(placeholder, join(this.dataRoot, 'avatars', `${id}.png`)).catch(() => {});
        }
        applySettings(this.store, this.config);
        this.onChange();
        this.audit(user, `キャラ人格を追加: ${id}`);
        return sendJson(response, 201, { persona: personas.find(persona => persona.id === id) });
      }
      const personaIcon = path.match(/^\/api\/admin\/personas\/(.+)\/icon$/);
      if (personaIcon && method === 'POST') {
        if (!has('character')) return deny();
        const id = decodeURIComponent(personaIcon[1]);
        if (!getPersonas(this.store).some(persona => persona.id === id)) return sendJson(response, 404, { error: 'persona not found' });
        const body = await readJsonBody(request);
        const base64 = String(body.image || '').replace(/^data:image\/png;base64,/, '');
        const bytes = Buffer.from(base64, 'base64');
        if (!bytes.length || bytes.length > 2 * 1024 * 1024) return sendJson(response, 400, { error: 'image must be a PNG up to 2MB' });
        if (!bytes.subarray(0, 8).equals(PNG_SIGNATURE)) return sendJson(response, 400, { error: 'image must be a PNG' });
        await mkdir(join(this.dataRoot, 'avatars'), { recursive: true });
        await writeFile(join(this.dataRoot, 'avatars', `${id}.png`), bytes);
        this.onChange();
        this.audit(user, `キャラ人格のアイコンを変更: ${id}`);
        return sendJson(response, 200, { ok: true });
      }
      const personaTarget = path.match(/^\/api\/admin\/personas\/(.+)$/);
      if (personaTarget && (method === 'PUT' || method === 'DELETE')) {
        if (!has('character')) return deny();
        const id = decodeURIComponent(personaTarget[1]);
        const personas = getPersonas(this.store);
        if (!personas.some(persona => persona.id === id)) return sendJson(response, 404, { error: 'persona not found' });
        if (method === 'DELETE') {
          if (getMembers(this.store).some(member => member.personaId === id)) return sendJson(response, 400, { error: 'メンバーに割り当て中の人格は削除できません' });
          setPersonas(this.store, personas.filter(persona => persona.id !== id));
          applySettings(this.store, this.config);
          this.onChange();
          this.audit(user, `キャラ人格を削除: ${id}`);
          return sendJson(response, 200, { ok: true });
        }
        const body = await readJsonBody(request);
        const saved = setPersonas(this.store, personas.map(persona => persona.id === id ? { id, name: body.name, prompt: body.prompt || '' } : persona));
        applySettings(this.store, this.config);
        this.onChange();
        this.audit(user, `キャラ人格を更新: ${id}`);
        return sendJson(response, 200, { persona: saved.find(persona => persona.id === id) });
      }

      if (method === 'PUT' && path === '/api/admin/members/count') {
        if (!has('project')) return deny();
        const body = await readJsonBody(request);
        const members = resizeMembers(this.store, String(body.job || ''), Number(body.count));
        applySettings(this.store, this.config);
        this.onChange();
        this.audit(user, `メンバー人数を変更: ${body.job} → ${body.count}人`);
        return sendJson(response, 200, { members });
      }
      const memberPersona = path.match(/^\/api\/admin\/members\/(.+)\/persona$/);
      if (memberPersona && method === 'PUT') {
        if (!has('project')) return deny();
        const body = await readJsonBody(request);
        const members = assignPersona(this.store, decodeURIComponent(memberPersona[1]), body.personaId ?? null);
        applySettings(this.store, this.config);
        this.onChange();
        this.audit(user, `メンバーの人格割り当てを変更: ${decodeURIComponent(memberPersona[1])} → ${body.personaId || 'なし'}`);
        return sendJson(response, 200, { members });
      }

      const promptTarget = path.match(/^\/api\/admin\/prompts\/(.+)$/);
      if (promptTarget && ['GET', 'PUT', 'DELETE'].includes(method)) {
        if (!has('project')) return deny();
        const file = decodeURIComponent(promptTarget[1]);
        if (!PROMPT_FILES.includes(file)) return sendJson(response, 400, { error: `unknown prompt file: ${file}` });
        if (method === 'GET') {
          const override = getPromptOverride(this.store, file);
          if (override !== undefined) return sendJson(response, 200, { file, content: override, source: 'override' });
          const content = await readFile(join(this.publicRoot, file), 'utf8');
          return sendJson(response, 200, { file, content, source: 'file' });
        }
        if (method === 'DELETE') {
          clearPromptOverride(this.store, file);
          this.audit(user, `プロンプトの上書きを解除: ${file}`);
          return sendJson(response, 200, { ok: true });
        }
        const body = await readJsonBody(request);
        setPromptOverride(this.store, file, body.content);
        this.audit(user, `プロンプトを上書き: ${file}`);
        return sendJson(response, 200, { ok: true });
      }

      if (method === 'PUT' && path === '/api/admin/decision-users') {
        if (!has('project')) return deny();
        const body = await readJsonBody(request);
        const ids = setDecisionUserIds(this.store, body.ids);
        this.audit(user, `変更判断のDiscordユーザーを変更: ${ids.length}人`);
        return sendJson(response, 200, { decisionUserIds: ids });
      }

      return sendJson(response, 404, { error: 'not found' });
    } catch (error) {
      return sendJson(response, 400, { error: error.message });
    }
  }

  adminRow(row) {
    return {
      misskeyId: row.misskey_id,
      username: row.username || '',
      displayName: row.display_name || '',
      permissions: sanitizePermissions(parseJson(row.permissions, []), { allowAdmin: true }),
      isInitial: isInitialAdmin(this.config, row.misskey_id),
      createdBy: row.created_by || '',
      createdAt: row.created_at
    };
  }

  state(user, permissions) {
    const has = permission => permissions.includes(permission);
    const state = {
      me: { user, permissions, isInitialAdmin: isInitialAdmin(this.config, user.misskeyId) },
      permissions: PERMISSIONS
    };
    if (has('admin')) {
      state.basePermissions = basePermissions(this.store);
      state.admins = this.store.listAdmins().map(row => this.adminRow(row));
      state.initialAdminIds = this.config.initialAdminMisskeyIds || [];
    }
    if (has('character') || has('project')) {
      state.personas = getPersonas(this.store);
      state.members = getMembers(this.store);
      state.jobRules = JOB_RULES;
    }
    if (has('project')) {
      state.prompts = PROMPT_FILES.map(file => ({ file, hasOverride: getPromptOverride(this.store, file) !== undefined }));
      state.decisionUserIds = decisionUserIds(this.store, this.config);
    }
    return state;
  }
}
