import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { AdminAuth, exchangeCode, hashToken, pkceChallenge } from '../src/auth.js';

const config = { misskeyOrigin: 'https://misskey.resonite.love', adminPublicUrl: '', initialAdminMisskeyIds: [] };

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
    const url = new URL(auth.loginUrl({ headers: { host: 'public.example', 'x-forwarded-proto': 'https' } }));
    assert.equal(url.origin + url.pathname, 'https://misskey.resonite.love/oauth/authorize');
    assert.equal(url.searchParams.get('scope'), 'read:account');
    assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(url.searchParams.get('redirect_uri'), 'https://public.example/admin/auth/callback');
    const state = url.searchParams.get('state');
    const pending = JSON.parse(f.store.getKv(`admin-login:${state}`));
    assert.equal(pkceChallenge(pending.verifier), url.searchParams.get('code_challenge'));
    assert.ok(pending.expiresAt > Date.now());

    assert.equal(auth.sessionUser({ headers: {} }), null);
    f.store.upsertAdmin({ misskeyId: 'user-9', username: 'carol', displayName: 'Carol', permissions: [] });
    f.store.createAdminSession(hashToken('raw-token'), 'user-9', Date.now() + 60_000);
    const user = auth.sessionUser({ headers: { cookie: 'other=1; tonarium_agent_admin=raw-token' } });
    assert.deepEqual(user, { misskeyId: 'user-9', username: 'carol', displayName: 'Carol' });
    auth.logout({ headers: { cookie: 'tonarium_agent_admin=raw-token' } });
    assert.equal(auth.sessionUser({ headers: { cookie: 'tonarium_agent_admin=raw-token' } }), null);
  } finally { f.close(); }
});
