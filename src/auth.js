import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

// Misskey 認証は tonarium 本体（server/auth.ts）と同じ OAuth 2.0 認可コード＋PKCE。
// トークンは本人確認にだけ使い、終わったら捨てる。セッションはハッシュだけを DB に持つ。
export const ADMIN_COOKIE = 'tonarium_agent_admin';
export const LOGIN_COOKIE = 'tonarium_agent_login';
const PENDING_TTL = 10 * 60_000;
const SESSION_TTL = 30 * 86_400_000;
// 未認証のログイン開始で DB が際限なく増えないよう、手続き中レコードには上限を付ける
const MAX_PENDING_LOGINS = 100;
const LOGIN_RATE_LIMIT = 10;
const LOGIN_RATE_WINDOW = 10 * 60_000;

export const hashToken = token => createHash('sha256').update(String(token)).digest('hex');
export const pkceChallenge = verifier => createHash('sha256').update(String(verifier)).digest('base64url');
const safeEqual = (a, b) => {
  const left = Buffer.from(String(a)), right = Buffer.from(String(b));
  return left.length === right.length && timingSafeEqual(left, right);
};

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
  constructor(config, store) { Object.assign(this, { config, store }); this.loginAttempts = new Map(); }

  // 公開オリジンは env（ADMIN_PUBLIC_URL）で固定したものだけを使う。X-Forwarded-* は
  // 誰でも付けられるので、redirect_uri や Cookie の発行先の決定には使わない。
  // 未設定なら管理画面ログインは無効（公開ダッシュボード自体は動き続ける）
  publicOrigin() { return this.config.adminPublicUrl || ''; }

  sessionCookie(req, value, maxAgeMs) {
    const secure = this.publicOrigin().startsWith('https:') ? '; Secure' : '';
    return `${ADMIN_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(maxAgeMs / 1000)}${secure}`;
  }

  loginCookie(value, maxAgeMs) {
    const secure = this.publicOrigin().startsWith('https:') ? '; Secure' : '';
    return `${LOGIN_COOKIE}=${value}; Path=/admin; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(maxAgeMs / 1000)}${secure}`;
  }

  // ログイン開始の連打・放置で pending レコードが増え続けないよう、同一接続元に上限を付ける。
  // 公開トンネル経由では接続元がトンネル端末に寄るため、実質全体の上限としても働く
  checkLoginRate(req) {
    const source = String(req?.socket?.remoteAddress || 'unknown');
    const now = Date.now();
    const attempts = (this.loginAttempts.get(source) || []).filter(at => now - at < LOGIN_RATE_WINDOW);
    if (attempts.length >= LOGIN_RATE_LIMIT) {
      this.loginAttempts.set(source, attempts);
      const error = new Error('ログイン試行が多すぎます。しばらく待ってからお試しください。');
      error.code = 'RATE_LIMITED';
      throw error;
    }
    attempts.push(now);
    this.loginAttempts.set(source, attempts);
  }

  // 期限切れの掃除と件数上限。コールバックまで来なかった手続きが DB に残り続けないようにする
  prunePendingLogins() {
    if (typeof this.store.listKv !== 'function') return;
    const now = Date.now();
    const alive = [];
    for (const row of this.store.listKv('admin-login:')) {
      let pending = null;
      try { pending = JSON.parse(row.value); } catch { pending = null; }
      if (!pending || !pending.expiresAt || pending.expiresAt <= now) this.store.deleteKv(row.key);
      else alive.push({ key: row.key, expiresAt: pending.expiresAt });
    }
    alive.sort((a, b) => a.expiresAt - b.expiresAt);
    while (alive.length >= MAX_PENDING_LOGINS) this.store.deleteKv(alive.shift().key);
  }

  beginLogin(req) {
    const origin = this.publicOrigin();
    if (!origin) {
      const error = new Error('ADMIN_PUBLIC_URL が未設定のため、管理画面ログインは無効です。');
      error.code = 'ADMIN_DISABLED';
      throw error;
    }
    this.checkLoginRate(req);
    this.prunePendingLogins();
    const state = randomUUID();
    const verifier = randomBytes(32).toString('base64url');
    const nonce = randomBytes(32).toString('base64url');
    // verifier と、開始ブラウザ確認用 nonce のハッシュはサーバー側（DB）にだけ置く。
    // 10分で失効し、コールバックで一度だけ使う
    this.store.setKv(`admin-login:${state}`, JSON.stringify({ verifier, nonceHash: hashToken(nonce), expiresAt: Date.now() + PENDING_TTL }));
    const query = new URLSearchParams({
      response_type: 'code',
      client_id: `${origin}/`,
      redirect_uri: `${origin}/admin/auth/callback`,
      scope: 'read:account',
      state,
      code_challenge: pkceChallenge(verifier),
      code_challenge_method: 'S256'
    });
    return { url: `${this.config.misskeyOrigin}/oauth/authorize?${query}`, cookie: this.loginCookie(nonce, PENDING_TTL) };
  }

  fail(response, message, headers = {}) {
    response.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
    response.end(`ログインできませんでした。${message}\n管理画面からもう一度お試しください: /admin`);
  }

  async handleCallback(req, response, url) {
    const clearLogin = { 'Set-Cookie': this.loginCookie('', 0) };
    if (!this.publicOrigin()) return this.fail(response, '管理画面ログインが有効化されていません。', clearLogin);
    const state = url.searchParams.get('state') || '';
    const key = `admin-login:${state}`;
    let pending = null;
    try { pending = JSON.parse(this.store.getKv(key) || 'null'); } catch { pending = null; }
    if (state) this.store.deleteKv(key);
    if (!pending || !pending.verifier || pending.expiresAt <= Date.now()) return this.fail(response, '手続きが見つからないか、期限が切れました。', clearLogin);
    // コールバック URL は state さえ合えば別ブラウザでも開けてしまうため、ログインを
    // 開始したブラウザにだけ渡した nonce Cookie と一致することを確かめる（ログイン CSRF 対策）
    const nonce = parseCookies(req.headers.cookie)[LOGIN_COOKIE];
    if (!nonce || !pending.nonceHash || !safeEqual(hashToken(nonce), pending.nonceHash)) return this.fail(response, 'ログインを開始したブラウザと一致しませんでした。', clearLogin);
    const iss = url.searchParams.get('iss');
    if (iss !== null && iss !== this.config.misskeyOrigin) return this.fail(response, '別のサーバーからの応答でした。', clearLogin);
    const code = url.searchParams.get('code');
    if (!code) return this.fail(response, 'Misskey で許可されませんでした。', clearLogin);
    const user = await exchangeCode(this.config.misskeyOrigin, this.publicOrigin(), code, pending.verifier);
    if (!user) return this.fail(response, 'Misskey で本人確認ができませんでした。', clearLogin);
    // プロフィールのキャッシュとしてだけ保存する。既存レコードの権限は変えない
    this.store.upsertAdmin({ misskeyId: user.id, username: user.username, displayName: user.name || user.username });
    const token = randomBytes(32).toString('base64url');
    this.store.createAdminSession(hashToken(token), user.id, Date.now() + SESSION_TTL);
    response.writeHead(302, { Location: '/admin', 'Set-Cookie': [this.sessionCookie(req, token, SESSION_TTL), this.loginCookie('', 0)], 'Cache-Control': 'no-store' });
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
