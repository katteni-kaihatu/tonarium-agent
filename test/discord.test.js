import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Store } from '../src/store.js';
import { DiscordTransport, historyLine } from '../src/discord.js';
import { Poster } from '../src/poster.js';

test('a parent-channel message becomes one feedback thread', async () => {
  const dir = mkdtempSync(join(tmpdir(),'tonarium-discord-'));
  const store = new Store(join(dir,'state.sqlite'));
  try {
    const transport = new DiscordTransport({discordChannelId:'channel-1'},store);
    const received = [];
    transport.onFeedback = async id => received.push(id);
    let starts = 0;
    const message = {
      id:'message-1', content:'地図を拡大しやすくしたい', hasThread:false,
      author:{username:'user'},
      startThread:async options => { starts++; assert.equal(options.name,'地図を拡大しやすくしたい'); return {id:'message-1',name:options.name}; }
    };
    await transport.handleParentMessage(message);
    assert.equal(starts,1);
    assert.deepEqual(received,['message-1']);
    assert.equal(store.get('message-1').last_message_id,'message-1');
    message.hasThread = true;
    await transport.handleParentMessage(message);
    assert.equal(starts,1);
    transport.client.destroy();
  } finally { store.close(); rmSync(dir,{recursive:true,force:true}); }
});

function fakeRest({ webhooks = true, existing = [] } = {}) {
  const posts = [], hooks = [...existing], deleted = [];
  return {
    posts, hooks, deleted, failOn:null,
    async get(route) {
      if (route === '/users/%40me') return {id:'bot-1'};
      if (route === '/channels/thread-1') return {type:11,parent_id:'channel-1'};
      if (route === '/channels/release-1') return {type:0};
      if (route.endsWith('/webhooks')) { if (!webhooks) throw new Error('Missing Permissions'); return hooks.filter(hook => !deleted.includes(hook.id)); }
      throw new Error(`unexpected GET ${route}`);
    },
    async delete(route) { deleted.push(route.split('/').pop()); },
    async post(route, options) {
      if (route.endsWith('/webhooks')) { const hook = {id:`hook-${hooks.length + 1}`,token:'secret',name:options.body.name,user:{id:'bot-1'}}; hooks.push(hook); return hook; }
      if (this.failOn && this.failOn(route,options)) throw Object.assign(new Error('Unknown Webhook'),{status:404});
      posts.push({route,...options});
      return {};
    }
  };
}

test('agents post with their own name and avatar and show only the other languages', async () => {
  const dir = mkdtempSync(join(tmpdir(),'tonarium-discord-'));
  const store = new Store(join(dir,'state.sqlite'));
  try {
    const translator = {translate:async text => text.startsWith('どう') ? {source:'ja',ja:text,en:'What happened?',ko:'무슨 일이세요?'} : {source:'en',ja:'こんにちは',en:'Hello',ko:'안녕하세요'}};
    const transport = new DiscordTransport({discordChannelId:'channel-1',discordToken:'set'},store,translator);
    const rest = fakeRest();
    transport.poster = new Poster(rest,translator);
    await transport.say('thread-1','どうされました？',{as:'pm',mentionUserId:'12345678901234567'});
    await transport.translateUser({id:'msg-1',content:'Hello',author:{username:'kokoa'},member:{displayName:'ここあ_dev',displayAvatarURL:() => 'https://cdn.example/kokoa.png'}},'thread-1');
    assert.deepEqual(rest.hooks.map(hook => hook.name),['Tonarium Agent','Tonarium Agent 通訳']);
    const [agent,relay] = rest.posts;
    assert.equal(agent.route,'/webhooks/hook-1/secret');
    assert.equal(agent.query.get('thread_id'),'thread-1');
    assert.equal(agent.body.username,'さくら｜PM');
    assert.match(agent.body.avatar_url,/\/avatars\/pm\.png$/);
    assert.equal(agent.body.content,'<@12345678901234567> どうされました？\n\n🇺🇸 What happened?\n🇰🇷 무슨 일이세요?');
    assert.deepEqual(agent.body.allowed_mentions,{users:['12345678901234567']});
    assert.equal(relay.route,'/webhooks/hook-2/secret');
    assert.equal(relay.body.username,'ここあ_dev');
    assert.equal(relay.body.avatar_url,'https://cdn.example/kokoa.png');
    assert.equal(relay.body.content,'🇯🇵 こんにちは\n🇰🇷 안녕하세요');
    transport.client.destroy();
  } finally { store.close(); rmSync(dir,{recursive:true,force:true}); }
});

test('without webhook permission posts fall back to the bot with the agent name in the text', async () => {
  const rest = fakeRest({webhooks:false});
  const poster = new Poster(rest,null);
  await poster.say('release-1','反映しました。',{as:'mainrelease'});
  await poster.relay('thread-1','Hello',{username:'kokoa'});
  assert.equal(rest.posts.length,1);
  assert.equal(rest.posts[0].route,'/channels/release-1/messages');
  assert.equal(rest.posts[0].body.content,'**つむぎ｜リリース**\n反映しました。');
});

test('history keeps agent webhook replies and drops relayed translations', () => {
  const message = (author,content,webhookId = '') => ({author,content,webhookId,attachments:new Map()});
  const webhooks = {agent:new Set(['hook-1','hook-3']),translation:new Set(['hook-2'])};
  assert.equal(historyLine(message({id:'hook-1',bot:true,username:'さくら｜PM'},'進めます。\n\n🇺🇸 Proceeding.','hook-1'),'bot-1',webhooks),'Bot(さくら｜PM): 進めます。');
  assert.equal(historyLine(message({id:'hook-3',bot:true,username:'ひより｜聞き取り'},'どの画面ですか？','hook-3'),'bot-1',webhooks),'Bot(ひより｜聞き取り): どの画面ですか？');
  assert.equal(historyLine(message({id:'hook-2',bot:true,username:'ここあ'},'🇺🇸 Hello','hook-2'),'bot-1',webhooks),'');
  assert.equal(historyLine(message({id:'bot-1',bot:true,username:'tonarium'},'**さくら｜PM**\n進めます。\n\n🌐 **翻訳 / Translations / 번역**\n🇺🇸 x'),'bot-1',webhooks),'Bot(tonarium): **さくら｜PM**\n進めます。');
});

test('webhooks are reused, unreadable ones replaced, and deleted ones recreated', async () => {
  const rest = fakeRest({existing:[
    {id:'old-agent',name:'Tonarium Agent',user:{id:'bot-1'}},
    {id:'human-hook',name:'Tonarium Agent 通訳',token:'other',user:{id:'someone'}},
    {id:'old-translation',name:'Tonarium Agent 通訳',token:'secret',user:{id:'bot-1'}}
  ]});
  const poster = new Poster(rest,null);
  await poster.say('thread-1','一つ目',{as:'pm'});
  assert.deepEqual(rest.deleted,['old-agent']);
  assert.equal(rest.posts[0].route,'/webhooks/hook-4/secret');
  assert.deepEqual([...(await poster.webhookIds('thread-1')).translation],['old-translation']);
  rest.failOn = route => route === '/webhooks/hook-4/secret';
  await poster.say('thread-1','二つ目',{as:'pm'});
  assert.equal(rest.posts.at(-1).route,'/channels/thread-1/messages');
  rest.failOn = null;
  await poster.say('thread-1','三つ目',{as:'pm'});
  assert.equal(rest.posts.at(-1).route,'/webhooks/hook-4/secret');
});

test('a long post that fails midway sends only the rest as the bot', async () => {
  const rest = fakeRest();
  const poster = new Poster(rest,null);
  let calls = 0;
  rest.failOn = route => route.startsWith('/webhooks/') && ++calls === 2;
  await poster.say('thread-1','あ'.repeat(2500),{as:'pm'});
  assert.deepEqual(rest.posts.map(post => [post.route,post.body.content.length]),[['/webhooks/hook-1/secret',1900],['/channels/thread-1/messages',600]]);
});

test('Discord PNG attachments are downloaded for the intake vision input and cleaned up', async () => {
  const dir = mkdtempSync(join(tmpdir(),'tonarium-discord-'));
  const store = new Store(join(dir,'state.sqlite'));
  try {
    const png = Uint8Array.from([137,80,78,71,13,10,26,10,0,0,0,0]);
    const fetcher = async () => ({ok:true,headers:{get:() => String(png.length)},arrayBuffer:async () => png.buffer});
    const transport = new DiscordTransport({},store,null,fetcher);
    const message = {author:{bot:false},createdTimestamp:1,attachments:new Map([['image',{url:'https://cdn.discordapp.com/attachments/1/2/screenshot.png',size:png.length}]])};
    transport.client.channels.fetch = async () => ({messages:{fetch:async () => new Map([['message',message]])},fetchStarterMessage:async () => null});
    const bundle = await transport.downloadImages('thread');
    assert.equal(bundle.paths.length,1);
    assert.deepEqual(readFileSync(bundle.paths[0]),Buffer.from(png));
    await bundle.cleanup();
    assert.equal(existsSync(bundle.paths[0]),false);
    transport.client.destroy();
  } finally { store.close(); rmSync(dir,{recursive:true,force:true}); }
});

test('large attachments are resized before being handed to the vision input when a converter exists', async (t) => {
  const dir = mkdtempSync(join(tmpdir(),'tonarium-discord-'));
  const store = new Store(join(dir,'state.sqlite'));
  try {
    // 2400x2400 のノイズ画像（300KB を超える実 PNG）を ffmpeg で作る。無い環境では skip
    const bigPath = join(dir,'big.png');
    try { await promisify(execFile)('ffmpeg', ['-y','-loglevel','error','-f','lavfi','-i','testsrc2=size=2400x2400:duration=1','-frames:v','1',bigPath], { timeout: 30_000 }); }
    catch { t.skip('ffmpeg is not available'); return; }
    const png = readFileSync(bigPath);
    if (png.length <= 300 * 1024) { t.skip('generated image is too small'); return; }
    const fetcher = async () => ({ok:true,headers:{get:() => String(png.length)},arrayBuffer:async () => png.buffer.slice(png.byteOffset, png.byteOffset + png.byteLength)});
    const transport = new DiscordTransport({},store,null,fetcher);
    const message = {author:{bot:false},createdTimestamp:1,attachments:new Map([['image',{url:'https://cdn.discordapp.com/attachments/1/2/big.png',size:png.length,contentType:'image/png'}]])};
    transport.client.channels.fetch = async () => ({messages:{fetch:async () => new Map([['message',message]])},fetchStarterMessage:async () => null});
    const bundle = await transport.downloadImages('thread');
    assert.equal(bundle.paths.length,1);
    assert.match(bundle.paths[0],/-small\.jpg$/);
    assert.ok(readFileSync(bundle.paths[0]).length < png.length, '縮小版のほうが小さい');
    await bundle.cleanup();
    transport.client.destroy();
  } finally { store.close(); rmSync(dir,{recursive:true,force:true}); }
});

test('history keeps the bot\'s own replies without translations so follow-ups keep their context', async () => {
  const dir = mkdtempSync(join(tmpdir(),'tonarium-discord-'));
  const store = new Store(join(dir,'state.sqlite'));
  try {
    const transport = new DiscordTransport({discordChannelId:'feedback'},store);
    transport.client.user = {id:'bot-1'};
    const message = (id,author,content,time) => [id,{author,content,attachments:new Map(),createdTimestamp:time}];
    const thread = {
      isThread:() => true,
      messages:{fetch:async () => new Map([
        message('a',{id:'user-1',bot:false,username:'kokoa'},'地図を拡大したい',1),
        message('b',{id:'bot-1',bot:true,username:'tonarium'},'**ひより｜聞き取り**\nどの画面ですか？\n\n🌐 **翻訳 / Translations / 번역**\n🇺🇸 Which screen?',2),
        message('c',{id:'bot-1',bot:true,username:'tonarium'},'🌐 **kokoa の発言 / message / 메시지**\n🇺🇸 I want to zoom',3),
        message('d',{id:'other-bot',bot:true,username:'other'},'関係ない通知',4)
      ])},
      fetchStarterMessage:async () => null
    };
    transport.client.channels.fetch = async () => thread;
    const history = await transport.history('thread-1');
    assert.equal(history,'kokoa: 地図を拡大したい\nBot(tonarium): **ひより｜聞き取り**\nどの画面ですか？');
    transport.client.destroy();
  } finally { store.close(); rmSync(dir,{recursive:true,force:true}); }
});

test('a thread message records its author for later mentions', async () => {
  const dir = mkdtempSync(join(tmpdir(),'tonarium-discord-'));
  const store = new Store(join(dir,'state.sqlite'));
  try {
    const transport = new DiscordTransport({discordChannelId:'feedback'},store);
    transport.onFeedback = async () => {};
    await transport.handleFeedback('thread-1','要望','12345678901234568','12345678901234567');
    assert.equal(store.getKv('last-author:thread-1'),'12345678901234567');
    transport.client.destroy();
  } finally { store.close(); rmSync(dir,{recursive:true,force:true}); }
});

test('instruction questions mention the starter and thread names show status emoji', async () => {
  const dir = mkdtempSync(join(tmpdir(),'tonarium-discord-'));
  const store = new Store(join(dir,'state.sqlite'));
  try {
    const names = [];
    const fetcher = async (_url,options) => {
      if (options.method === 'PATCH') {
        names.push(JSON.parse(options.body).name);
        return {ok:true,status:200};
      }
      return {ok:true,json:async () => ({name:'⏳ 二段ジャンプ'})};
    };
    const transport = new DiscordTransport({discordToken:'set'},store,null,fetcher);
    transport.client.user = {id:'bot-1'};
    const rest = fakeRest();
    transport.poster = new Poster(rest,null);
    const thread = {
      name:'⏳ 二段ジャンプ',ownerId:'bot-1',isThread:() => true,
      fetchStarterMessage:async () => ({author:{id:'12345678901234567',bot:false}}),
      setName:async name => { thread.name = name; }
    };
    transport.client.channels.fetch = async () => thread;
    store.create('thread-1','二段ジャンプ');
    store.update('thread-1',{status:'waiting_info'});
    store.setKv('awaiting-instruction:thread-1','1');
    const ownerId = await transport.threadOwnerId('thread-1');
    await transport.say('thread-1','次の指示をください',{mentionUserId:ownerId,as:'pm'});
    await transport.setThreadStatus('thread-1');
    assert.deepEqual(names,['🙋 指示待ち｜二段ジャンプ']);
    assert.match(rest.posts[0].body.content,/^<@12345678901234567>/);
    assert.deepEqual(rest.posts[0].body.allowed_mentions,{users:['12345678901234567']});
    transport.client.destroy();
  } finally { store.close(); rmSync(dir,{recursive:true,force:true}); }
});
