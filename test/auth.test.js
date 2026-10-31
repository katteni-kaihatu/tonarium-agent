import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { AdminAuth, LOGIN_COOKIE, exchangeCode, hashToken, pkceChallenge } from '../src/auth.js';

const config = { misskeyOrigin: 'https://misskey.resonite.love', adminPublicUrl: 'https://public.example', initialAdminMisskeyIds: [] };

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'tonarium-auth-'));
  const store = new Store(join(dir, 'state.sqlite'));
  return { store, close: () => { store.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test('pkceChallenge matches the RFC 7636 test vector and hashToken is sha256 hex', () => {
  assert.equal(pkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'), 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  assert.equal(hashToken('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

test('exchangeCode trades the code and reads the Misskey user', async () => {
  const calls = [];
  const fetchFn = async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith('/oauth/token')) return { ok: true, json: async () => ({ access_token: 'token-1' }) };
    if (url.endsWith('/api/i')) return { ok: true, json: async () => ({ id: 'misskey-1', username: 'alice', name: 'Alice' }) };
    throw new Error(`unexpected ${url}`);
  };
  const user = await exchangeCode('https://misskey.example', 'https://public.example', 'code-1', 'verifier-1', fetchFn);
  assert.deepEqual(user, { id: 'misskey-1', username: 'alice', name: 'Alice' });
  const body = calls[0].options.body;
  assert.equal(body.get('grant_type'), 'authorization_code');
  assert.equal(body.get('client_id'), 'https://public.example/');
  assert.equal(body.get('redirect_uri'), 'https://public.example/admin/auth/callback');
  assert.equal(body.get('code_verifier'), 'verifier-1');
  assert.equal(calls[1].options.headers.Authorization, 'Bearer token-1');
});

test('exchangeCode returns null when Misskey refuses or the user payload is invalid', async () => {
  const refused = async () => ({ ok: false, json: async () => ({}) });
  assert.equal(await exchangeCode('https://misskey.example', 'https://public.example', 'c', 'v', refused), null);
  const badUser = async url => url.endsWith('/oauth/token')
    ? { ok: true, json: async () => ({ access_token: 't' }) }
    : { ok: true, json: async () => ({ username: 'no-id' }) };
  assert.equal(await exchangeCode('https://misskey.example', 'https://public.example', 'c', 'v', badUser), null);
});

test('admin sessions round-trip through the store and expire', () => {
  const f = fixture();
  try {
    f.store.createAdminSession(hashToken('raw-1'), 'user-1', Date.now() + 60_000);
    assert.equal(f.store.adminSession(hashToken('raw-1')).misskey_id, 'user-1');
    f.store.createAdminSession(hashToken('raw-2'), 'user-1', Date.now() - 1);
    assert.equal(f.store.adminSession(hashToken('raw-2')), undefined);
    // 期限切れは読んだ時点で消える
    assert.equal(f.store.adminSession(hashToken('raw-2')), undefined);
    f.store.deleteAdminSession(hashToken('raw-1'));
    assert.equal(f.store.adminSession(hashToken('raw-1')), undefined);
  } finally { f.close(); }
});

test('AdminAuth login URL parks a PKCE verifier and sessionUser reads the cookie session', () => {
  const f = fixture();
  try {
    const auth = new AdminAuth(config, f.store);
    // 転送ヘッダーで別オリジンを主張しても、redirect_uri は設定済みの公開オリジンに固定される
    const { url: loginUrl, cookie } = auth.beginLogin({ headers: { host: 'evil.example', 'x-forwarded-proto': 'https', 'x-forwarded-host': 'evil.example' }, socket: { remoteAddress: '192.0.2.1' } });
    const url = new URL(loginUrl);
    assert.equal(url.origin + url.pathname, 'https://misskey.resonite.love/oauth/authorize');
    assert.equal(url.searchParams.get('scope'), 'read:account');
    assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(url.searchParams.get('redirect_uri'), 'https://public.example/admin/auth/callback');
    assert.equal(url.searchParams.get('client_id'), 'https://public.example/');
    const state = url.searchParams.get('state');
    const pending = JSON.parse(f.store.getKv(`admin-login:${state}`));
    assert.equal(pkceChallenge(pending.verifier), url.searchParams.get('code_challenge'));
    assert.ok(pending.expiresAt > Date.now());
    // 開始ブラウザ確認用の nonce は Cookie で渡し、DB にはハッシュだけを残す
    assert.ok(cookie.startsWith(`${LOGIN_COOKIE}=`));
    assert.match(cookie, /HttpOnly/);
    const nonce = cookie.split(';')[0].split('=').slice(1).join('=');
    assert.equal(pending.nonceHash, hashToken(nonce));

    assert.equal(auth.sessionUser({ headers: {} }), null);
    f.store.upsertAdmin({ misskeyId: 'user-9', username: 'carol', displayName: 'Carol', permissions: [] });
    f.store.createAdminSession(hashToken('raw-token'), 'user-9', Date.now() + 60_000);
    const user = auth.sessionUser({ headers: { cookie: 'other=1; tonarium_agent_admin=raw-token' } });
    assert.deepEqual(user, { misskeyId: 'user-9', username: 'carol', displayName: 'Carol' });
    auth.logout({ headers: { cookie: 'tonarium_agent_admin=raw-token' } });
    assert.equal(auth.sessionUser({ headers: { cookie: 'tonarium_agent_admin=raw-token' } }), null);
  } finally { f.close(); }
});

test('beginLogin refuses to start when ADMIN_PUBLIC_URL is not configured', () => {
  const f = fixture();
  try {
    const auth = new AdminAuth({ ...config, adminPublicUrl: '' }, f.store);
    assert.throws(
      () => auth.beginLogin({ headers: { host: 'evil.example', 'x-forwarded-host': 'evil.example' }, socket: { remoteAddress: '192.0.2.2' } }),
      error => error.code === 'ADMIN_DISABLED'
    );
    assert.equal(f.store.listKv('admin-login:').length, 0);
  } finally { f.close(); }
});

test('beginLogin prunes expired pending logins and caps the total count', () => {
  const f = fixture();
  try {
    for (let i = 0; i < 3; i++) f.store.setKv(`admin-login:expired-${i}`, JSON.stringify({ verifier: 'v', expiresAt: Date.now() - 1000 }));
    for (let i = 0; i < 120; i++) f.store.setKv(`admin-login:seed-${i}`, JSON.stringify({ verifier: 'v', expiresAt: Date.now() + (i + 1) * 60_000 }));
    const auth = new AdminAuth(config, f.store);
    auth.beginLogin({ headers: {}, socket: { remoteAddress: '192.0.2.3' } });
    const rows = f.store.listKv('admin-login:');
    assert.equal(rows.length, 100);
    assert.ok(rows.every(row => !row.key.includes('expired')));
    // 古いものから消え、最近の手続きは残る
    assert.equal(f.store.getKv('admin-login:seed-119') !== undefined, true);
    assert.equal(f.store.getKv('admin-login:seed-0'), undefined);
  } finally { f.close(); }
});

test('beginLogin rate-limits repeated attempts from the same source', () => {
  const f = fixture();
  try {
    const auth = new AdminAuth(config, f.store);
    const req = { headers: {}, socket: { remoteAddress: '192.0.2.4' } };
    for (let i = 0; i < 10; i++) auth.beginLogin(req);
    assert.throws(() => auth.beginLogin(req), error => error.code === 'RATE_LIMITED');
    // 別の接続元は影響を受けない
    assert.ok(auth.beginLogin({ headers: {}, socket: { remoteAddress: '192.0.2.5' } }).url);
  } finally { f.close(); }
});

const mockResponse = () => ({
  status: null, headers: null, body: '',
  writeHead(status, headers) { this.status = status; this.headers = headers; },
  end(body = '') { this.body = body; }
});

test('callback requires the nonce cookie issued to the browser that started login', async () => {
  const f = fixture();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async url => String(url).endsWith('/oauth/token')
    ? { ok: true, json: async () => ({ access_token: 'token-1' }) }
    : { ok: true, json: async () => ({ id: 'misskey-1', username: 'alice', name: 'Alice' }) };
  try {
    const auth = new AdminAuth(config, f.store);
    const req = { headers: {}, socket: { remoteAddress: '198.51.100.7' } };
    // nonce Cookie を持たない別ブラウザで callback URL を開いてもログインできない
    const first = auth.beginLogin(req);
    const state1 = new URL(first.url).searchParams.get('state');
    const refused = mockResponse();
    await auth.handleCallback({ headers: {} }, refused, new URL(`https://public.example/admin/auth/callback?code=code-1&state=${state1}`));
    assert.equal(refused.status, 400);
    // 開始したブラウザ（nonce Cookie あり）ではログインが完了する
    const second = auth.beginLogin(req);
    const state2 = new URL(second.url).searchParams.get('state');
    const nonce = second.cookie.split(';')[0].split('=').slice(1).join('=');
    const accepted = mockResponse();
    await auth.handleCallback({ headers: { cookie: `${LOGIN_COOKIE}=${nonce}` } }, accepted, new URL(`https://public.example/admin/auth/callback?code=code-1&state=${state2}`));
    assert.equal(accepted.status, 302);
    const setCookie = accepted.headers['Set-Cookie'];
    assert.ok(Array.isArray(setCookie) && setCookie.some(value => value.startsWith('tonarium_agent_admin=')));
    const sessionToken = setCookie[0].split(';')[0].split('=').slice(1).join('=');
    assert.equal(auth.sessionUser({ headers: { cookie: `tonarium_agent_admin=${sessionToken}` } })?.misskeyId, 'misskey-1');
  } finally { globalThis.fetch = originalFetch; f.close(); }
});
