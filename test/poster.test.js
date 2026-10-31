import test from 'node:test';
import assert from 'node:assert/strict';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Poster, roleIdentity, setAvatarRoot } from '../src/poster.js';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

const ID1 = '111111111111111111';
const ID2 = '222222222222222222';

// Webhook が使えない環境を再現し、Bot 本人投稿（raw 経路）へ落ちるようにする
function fakeRest(posts) {
  return {
    get: async route => {
      if (route.includes('/users/@me')) return { id: '999999999999999999' };
      if (route.includes('/webhooks')) throw new Error('webhooks unavailable');
      return { type: 0 };
    },
    post: async (route, options) => { posts.push({ route, options }); return {}; }
  };
}

test('say mentions every decision user and allows exactly those mentions', async () => {
  const posts = [];
  const poster = new Poster(fakeRest(posts), null);
  await poster.say('123456789012345678', 'main への反映を止めました。', { as: 'mainrelease', mentionUserIds: [ID1, ID2] });
  const message = posts.find(post => post.route.endsWith('/messages'));
  assert.ok(message);
  assert.ok(message.options.body.content.startsWith(`<@${ID1}> <@${ID2}> `));
  assert.deepEqual(message.options.body.allowed_mentions, { users: [ID1, ID2] });
});

test('roleIdentity adds the icon file version to the Discord avatar URL once a root is set', () => {
  // ルート未設定（単体利用）では従来どおり版数なし
  assert.match(roleIdentity('pm').avatarURL, /\/avatars\/pm\.png$/);
  setAvatarRoot(root);
  try {
    // public/avatars/pm.png が同梱されているので版数が付く（Discord の URL 単位キャッシュを回避する）
    assert.match(roleIdentity('pm').avatarURL, /\/avatars\/pm\.png\?v=\d+-\d+$/);
    assert.match(roleIdentity('mainrelease').avatarURL, /\/avatars\/mainrelease\.png\?v=\d+-\d+$/);
  } finally { setAvatarRoot(''); }
});

test('say keeps the single mentionUserId form working', async () => {
  const posts = [];
  const poster = new Poster(fakeRest(posts), null);
  await poster.say('123456789012345678', '確認してください。', { as: 'mainrelease', mentionUserId: ID1 });
  const message = posts.find(post => post.route.endsWith('/messages'));
  assert.ok(message);
  assert.ok(message.options.body.content.startsWith(`<@${ID1}> `));
  assert.deepEqual(message.options.body.allowed_mentions, { users: [ID1] });
});
