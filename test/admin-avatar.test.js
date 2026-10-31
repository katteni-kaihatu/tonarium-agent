import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AdminConsole } from '../src/admin.js';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

function mockResponse() {
  return {
    status: 0, headers: {}, body: null,
    writeHead(status, headers = {}) { this.status = status; this.headers = headers; },
    end(body) { this.body = body ?? null; }
  };
}

async function setup() {
  const base = await mkdtemp(join(tmpdir(), 'tonarium-admin-avatar-'));
  const dataRoot = join(base, '.data');
  const publicRoot = base;
  await mkdir(join(dataRoot, 'avatars'), { recursive: true });
  await mkdir(join(publicRoot, 'public', 'avatars'), { recursive: true });
  await writeFile(join(dataRoot, 'avatars', 'custom.png'), PNG);
  await writeFile(join(publicRoot, 'public', 'avatars', 'stock.png'), PNG);
  const admin = new AdminConsole({}, { event: () => {} }, {}, { dataRoot, publicRoot });
  return admin;
}

test('serveAvatar serves the uploaded icon with cache validators', async () => {
  const admin = await setup();
  const response = mockResponse();
  await admin.serveAvatar(response, 'custom.png', { headers: {} });
  assert.equal(response.status, 200);
  assert.match(response.headers.ETag, /^"\d+-\d+"$/);
  assert.ok(response.headers['Last-Modified']);
  assert.equal(response.headers['Cache-Control'], 'no-cache');
  assert.deepEqual(response.body, PNG);
});

test('serveAvatar answers 304 when If-None-Match matches the current icon', async () => {
  const admin = await setup();
  const first = mockResponse();
  await admin.serveAvatar(first, 'custom.png', { headers: {} });
  const second = mockResponse();
  await admin.serveAvatar(second, 'custom.png', { headers: { 'if-none-match': first.headers.ETag } });
  assert.equal(second.status, 304);
  assert.equal(second.body, null);
});

test('serveAvatar serves a versioned URL as immutable only when the version matches', async () => {
  const admin = await setup();
  const plain = mockResponse();
  await admin.serveAvatar(plain, 'custom.png', { headers: {} });
  const version = plain.headers.ETag.replaceAll('"', '');
  const versioned = mockResponse();
  await admin.serveAvatar(versioned, 'custom.png', { headers: {} }, version);
  assert.equal(versioned.status, 200);
  assert.match(versioned.headers['Cache-Control'], /immutable/);
  const stale = mockResponse();
  await admin.serveAvatar(stale, 'custom.png', { headers: {} }, '0-0');
  assert.equal(stale.headers['Cache-Control'], 'no-cache');
});

test('serveAvatar falls back to the bundled icon and rejects bad names', async () => {
  const admin = await setup();
  const response = mockResponse();
  await admin.serveAvatar(response, 'stock.png', { headers: {} });
  assert.equal(response.status, 200);
  const bad = mockResponse();
  await admin.serveAvatar(bad, '../secret.png', { headers: {} });
  assert.equal(bad.status, 404);
  const missing = mockResponse();
  await admin.serveAvatar(missing, 'missing.png', { headers: {} });
  assert.equal(missing.status, 404);
});
