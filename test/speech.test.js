import test from 'node:test';
import assert from 'node:assert/strict';
import { SpeechPolisher, speechRewriteIsSafe, protectedTokens } from '../src/speech.js';
import { Poster, setSpeechPolisher } from '../src/poster.js';

const ROLE = { roleId: 'pm', personaId: 'pm', name: 'さくら' };
const hooksWith = persona => ({ personaPrompt: (id, name, options) => { assert.equal(options.strict, true); return id === 'pm' ? persona : ''; } });

function fakeAi(responder) {
  const calls = [];
  return { calls, config: {}, ask: async (role, prompt, options) => { calls.push({ role, prompt, options }); return responder(prompt); } };
}

test('polish is skipped (and AI is never called) when the persona prompt is empty', async () => {
  const ai = fakeAi(() => ({ text: '変わってしまう' }));
  const polisher = new SpeechPolisher(ai, hooksWith(''));
  assert.equal(await polisher.polish('そのまま送る文章です。', ROLE), 'そのまま送る文章です。');
  assert.equal(ai.calls.length, 0);
});

test('polish rewrites only the tone, passing the original text and the persona to the AI', async () => {
  const ai = fakeAi(() => ({ text: '確認してもらえると助かります〜' }));
  const polisher = new SpeechPolisher(ai, hooksWith('明るく柔らかい口調で話す'));
  const result = await polisher.polish('確認してください。', ROLE);
  assert.equal(result, '確認してもらえると助かります〜');
  assert.equal(ai.calls.length, 1);
  assert.equal(ai.calls[0].role, '発話添削');
  assert.match(ai.calls[0].prompt, /明るく柔らかい口調で話す/);
  assert.match(ai.calls[0].prompt, /確認してください。/);
});

test('polish falls back to the original when the AI fails', async () => {
  const ai = { config: {}, ask: async () => { throw new Error('model down'); } };
  const polisher = new SpeechPolisher(ai, hooksWith('口調の指定'));
  assert.equal(await polisher.polish('原文のまま送られます。', ROLE), '原文のまま送られます。');
});

test('polish falls back when the rewrite drops a mention or an URL, or invents a mention', async () => {
  const original = '<@111111111111111111> https://example.com/pr/1 を確認してください。';
  for (const bad of [
    '確認してください。',
    '<@111111111111111111> を確認してください。',
    '<@111111111111111111> <@222222222222222222> https://example.com/pr/1 を確認してください。'
  ]) {
    const polisher = new SpeechPolisher(fakeAi(() => ({ text: bad })), hooksWith('口調の指定'));
    assert.equal(await polisher.polish(original, ROLE), original);
  }
});

test('polish caches identical text for the same persona', async () => {
  const ai = fakeAi(() => ({ text: '添削済みの文章です。' }));
  const polisher = new SpeechPolisher(ai, hooksWith('口調の指定'));
  assert.equal(await polisher.polish('同じ文章です。', ROLE), '添削済みの文章です。');
  assert.equal(await polisher.polish('同じ文章です。', ROLE), '添削済みの文章です。');
  assert.equal(ai.calls.length, 1);
});

test('speechRewriteIsSafe guards tokens and length', () => {
  assert.deepEqual(protectedTokens('a <@123> b `code` https://x.example/y'), ['<@123>', '`code`', 'https://x.example/y']);
  assert.equal(speechRewriteIsSafe('短い文です。', '短い文ですよ。'), true);
  assert.equal(speechRewriteIsSafe('短い文です。', ''), false);
  assert.equal(speechRewriteIsSafe('あ'.repeat(100), 'あ'.repeat(300)), false);
  assert.equal(speechRewriteIsSafe('あ'.repeat(100), 'あ'.repeat(30)), false);
});

test('poster.say sends the polished text when a polisher is set, and relay is never polished', async () => {
  const posts = [];
  const rest = {
    get: async route => { if (route.includes('/users/@me')) return { id: '999999999999999999' }; if (route.includes('/webhooks')) throw new Error('webhooks unavailable'); return { type: 0 }; },
    post: async (route, options) => { posts.push({ route, options }); return {}; }
  };
  setSpeechPolisher({ polish: async text => text.replace('確認してください。', '確認してもらえると助かります。') });
  try {
    const poster = new Poster(rest, null);
    await poster.say('123456789012345678', '確認してください。', { as: 'pm' });
    const message = posts.find(post => post.route.endsWith('/messages'));
    assert.match(message.options.body.content, /確認してもらえると助かります。/);
  } finally { setSpeechPolisher(null); }
});
