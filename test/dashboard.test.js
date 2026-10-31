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
