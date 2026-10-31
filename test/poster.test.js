import test from 'node:test';
import assert from 'node:assert/strict';
import { Poster } from '../src/poster.js';

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

test('say keeps the single mentionUserId form working', async () => {
  const posts = [];
  const poster = new Poster(fakeRest(posts), null);
  await poster.say('123456789012345678', '確認してください。', { as: 'mainrelease', mentionUserId: ID1 });
  const message = posts.find(post => post.route.endsWith('/messages'));
  assert.ok(message);
  assert.ok(message.options.body.content.startsWith(`<@${ID1}> `));
  assert.deepEqual(message.options.body.allowed_mentions, { users: [ID1] });
});
