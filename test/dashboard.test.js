import test from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getConfig } from '../src/config.js';
import { Dashboard } from '../src/dashboard.js';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const stubStore = { list: () => [], releases: () => [], events: () => [], getKv: () => undefined };
const stubEngine = { roleBusy: new Map(), releasing: false };

test('top page declares the Misskey redirect_uri for the configured public origin', async () => {
  const config = { ...getConfig({ ADMIN_PUBLIC_URL: 'https://example.test' }), host: '127.0.0.1', port: 0 };
  const dashboard = new Dashboard(config, stubStore, stubEngine, root);
  await dashboard.start();
  try {
    const { port } = dashboard.server.address();
    const html = await (await fetch(`http://127.0.0.1:${port}/`)).text();
    assert.match(html, /<link rel="redirect_uri" href="https:\/\/example\.test\/admin\/auth\/callback" \/>/);
  } finally { await dashboard.stop(); }
});

test('state carries an avatar version for roles whose icon file exists', () => {
  const config = { ...getConfig({}), host: '127.0.0.1', port: 0 };
  const dashboard = new Dashboard(config, stubStore, stubEngine, root);
  const state = dashboard.state();
  const pm = state.roles.find(role => role.id === 'pm');
  assert.match(pm.avatarVersion, /^\d+-\d+$/);
  assert.equal(dashboard.avatarVersion({ id: 'no-such-member' }), '');
});

test('state resolves release contents to ticket titles, including tickets outside the recent list', () => {
  const config = { ...getConfig({}), host: '127.0.0.1', port: 0 };
  const store = {
    list: () => [{ id: 't1', title: '一覧にある変更', status: 'merged', criteria: '[]', updated_at: 1 }],
    releases: () => [{ id: 9, status: 'merged', tickets: '["t1","t2","t3"]', commit_sha: 'abc', created_at: 1, updated_at: 2 }],
    events: () => [],
    getKv: () => undefined,
    get: id => id === 't2' ? { id: 't2', title: '一覧に無い古い変更', issue_number: 42 } : undefined
  };
  const dashboard = new Dashboard(config, store, stubEngine, root);
  const [release] = dashboard.state().releases;
  assert.deepEqual(release.tickets, ['t1', 't2', 't3']);
  assert.deepEqual(release.contents, [
    { id: 't1', title: '一覧にある変更', issue_number: null },
    { id: 't2', title: '一覧に無い古い変更', issue_number: 42 },
    { id: 't3', title: '', issue_number: null }
  ]);
});

test('top page has no redirect_uri declaration while ADMIN_PUBLIC_URL is unset', async () => {
  const config = { ...getConfig({}), host: '127.0.0.1', port: 0 };
  const dashboard = new Dashboard(config, stubStore, stubEngine, root);
  await dashboard.start();
  try {
    const { port } = dashboard.server.address();
    const html = await (await fetch(`http://127.0.0.1:${port}/`)).text();
    assert.doesNotMatch(html, /rel="redirect_uri"/);
  } finally { await dashboard.stop(); }
});
