import { createHash, randomBytes, randomUUID } from 'node:crypto';

// Misskey 認証は tonarium 本体（server/auth.ts）と同じ OAuth 2.0 認可コード＋PKCE。
// トークンは本人確認にだけ使い、終わったら捨てる。セッションはハッシュだけを DB に持つ。
export const ADMIN_COOKIE = 'tonarium_agent_admin';
const PENDING_TTL = 10 * 60_000;
const SESSION_TTL = 30 * 86_400_000;

export const hashToken = token => createHash('sha256').update(String(token)).digest('hex');
export const pkceChallenge = verifier => createHash('sha256').update(String(verifier)).digest('base64url');

/** 前段（トンネル/プロキシ）が付ける X-Forwarded-* を優先して、ブラウザから見た自オリジンを返す */
export function requestOrigin(req) {
  const proto = String(req.headers['x-forwarded-proto'] ?? 'http').split(',')[0].trim();
  const host = String(req.headers['x-forwarded-host'] ?? req.headers.host ?? 'localhost').split(',')[0].trim();
  return /^[\w.:[\]-]+$/.test(host) ? `${proto === 'https' ? 'https' : 'http'}://${host}` : '';
}

export function parseCookies(header) {
  const out = Object.create(null);
  for (const part of String(header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

/** 認可コードをトークンに替えて、許可した人を確かめる */
export async function exchangeCode(misskeyOrigin, publicOrigin, code, verifier, fetchFn = fetch) {
  try {
    const tokenResponse = await fetchFn(`${misskeyOrigin}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      signal: AbortSignal.timeout(10_000),
      body: new URLSearchParams({
        grant_type: 'authorization_code', code,
        client_id: `${publicOrigin}/`,
        redirect_uri: `${publicOrigin}/admin/auth/callback`,
        code_verifier: verifier
      })
    });
    if (!tokenResponse.ok) return null;
    const accessToken = (await tokenResponse.json())?.access_token;
    if (typeof accessToken !== 'string') return null;
    const userResponse = await fetchFn(`${misskeyOrigin}/api/i`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
      body: '{}',
      signal: AbortSignal.timeout(10_000)
    });
    if (!userResponse.ok) return null;
    const user = await userResponse.json();
    if (typeof user?.id !== 'string' || typeof user?.username !== 'string') return null;
    return { id: user.id, username: user.username, name: typeof user.name === 'string' ? user.name : null };
  } catch { return null; }
}

export class AdminAuth {
  constructor(config, store) { Object.assign(this, { config, store }); }

  publicOrigin(req) { return this.config.adminPublicUrl || requestOrigin(req); }

  sessionCookie(req, value, maxAgeMs) {
    const secure = this.publicOrigin(req).startsWith('https:') ? '; Secure' : '';
    return `${ADMIN_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(maxAgeMs / 1000)}${secure}`;
  }

  loginUrl(req) {
    const state = randomUUID();
    const verifier = randomBytes(32).toString('base64url');
    // verifier はサーバー側（DB）にだけ置く。10分で失効し、コールバックで一度だけ使う
    this.store.setKv(`admin-login:${state}`, JSON.stringify({ verifier, expiresAt: Date.now() + PENDING_TTL }));
    const origin = this.publicOrigin(req);
    const query = new URLSearchParams({
      response_type: 'code',
      client_id: `${origin}/`,
      redirect_uri: `${origin}/admin/auth/callback`,
      scope: 'read:account',
      state,
      code_challenge: pkceChallenge(verifier),
      code_challenge_method: 'S256'
    });
    return `${this.config.misskeyOrigin}/oauth/authorize?${query}`;
  }

  fail(response, message) {
    response.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
    response.end(`ログインできませんでした。${message}\n管理画面からもう一度お試しください: /admin`);
  }

  async handleCallback(req, response, url) {
    const state = url.searchParams.get('state') || '';
    const key = `admin-login:${state}`;
    let pending = null;
    try { pending = JSON.parse(this.store.getKv(key) || 'null'); } catch { pending = null; }
    if (state) this.store.deleteKv(key);
    if (!pending || !pending.verifier || pending.expiresAt <= Date.now()) return this.fail(response, '手続きが見つからないか、期限が切れました。');
    const iss = url.searchParams.get('iss');
    if (iss !== null && iss !== this.config.misskeyOrigin) return this.fail(response, '別のサーバーからの応答でした。');
    const code = url.searchParams.get('code');
    if (!code) return this.fail(response, 'Misskey で許可されませんでした。');
    const user = await exchangeCode(this.config.misskeyOrigin, this.publicOrigin(req), code, pending.verifier);
    if (!user) return this.fail(response, 'Misskey で本人確認ができませんでした。');
    // プロフィールのキャッシュとしてだけ保存する。既存レコードの権限は変えない
    this.store.upsertAdmin({ misskeyId: user.id, username: user.username, displayName: user.name || user.username });
    const token = randomBytes(32).toString('base64url');
    this.store.createAdminSession(hashToken(token), user.id, Date.now() + SESSION_TTL);
    response.writeHead(302, { Location: '/admin', 'Set-Cookie': this.sessionCookie(req, token, SESSION_TTL), 'Cache-Control': 'no-store' });
    response.end();
  }

  sessionUser(req) {
    const token = parseCookies(req.headers.cookie)[ADMIN_COOKIE];
    if (!token) return null;
    const row = this.store.adminSession(hashToken(token));
    if (!row) return null;
    return { misskeyId: row.misskey_id, username: row.username || '', displayName: row.display_name || row.username || '' };
  }

  logout(req) {
    const token = parseCookies(req.headers.cookie)[ADMIN_COOKIE];
    if (token) this.store.deleteAdminSession(hashToken(token));
    return this.sessionCookie(req, '', 0);
  }
}
