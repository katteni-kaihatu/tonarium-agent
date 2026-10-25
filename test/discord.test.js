import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { DiscordTransport } from '../src/discord.js';

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

test('user and bot messages are displayed in three languages', async () => {
  const dir = mkdtempSync(join(tmpdir(),'tonarium-discord-'));
  const store = new Store(join(dir,'state.sqlite'));
  try {
    const translator = {translate:async () => ({ja:'こんにちは',en:'Hello',ko:'안녕하세요'})};
    const transport = new DiscordTransport({discordChannelId:'channel-1',discordToken:'set'},store,translator);
    const sent = [];
    transport.client.channels.fetch = async () => ({send:async payload => sent.push(payload.content)});
    await transport.translateUser({id:'msg-1',content:'Hello',author:{username:'kokoa'}},'thread-1');
    await transport.say('thread-1','どうされました？');
    assert.match(sent[0],/🇯🇵 こんにちは/);
    assert.match(sent[0],/🇰🇷 안녕하세요/);
    assert.match(sent[1],/どうされました？/);
    assert.match(sent[1],/🇺🇸 Hello/);
    transport.client.destroy();
  } finally { store.close(); rmSync(dir,{recursive:true,force:true}); }
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

test('repair threads retain the original bug report for intake', async () => {
  const dir = mkdtempSync(join(tmpdir(),'tonarium-discord-'));
  const store = new Store(join(dir,'state.sqlite'));
  try {
    const transport = new DiscordTransport({discordChannelId:'feedback'},store);
    transport.client.user = {id:'bot-1'};
    const sent = [];
    const thread = {
      id:'repair-1',guildId:'guild-1',isThread:() => true,
      send:async payload => sent.push(payload.content),
      messages:{fetch:async () => new Map([['seed',{author:{id:'bot-1',bot:true,username:'bot'},content:sent[0],attachments:new Map(),createdTimestamp:1}]])},
      fetchStarterMessage:async () => null
    };
    transport.client.channels.fetch = async id => id === 'feedback'
      ? {threads:{create:async () => thread}} : thread;
    const result = await transport.createFollowUp({id:'original-1',title:'サムネイル',pr_number:94},'利用者: 更新されない','更新停止');
    assert.equal(result.id,'repair-1');
    assert.match(await transport.history('repair-1'),/更新されない/);
    assert.match(sent[0],/#94/);
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
    const sent = [];
    const thread = {
      name:'⏳ 二段ジャンプ',ownerId:'bot-1',isThread:() => true,
      fetchStarterMessage:async () => ({author:{id:'12345678901234567',bot:false}}),
      send:async payload => sent.push(payload),
      setName:async name => { thread.name = name; }
    };
    transport.client.channels.fetch = async () => thread;
    store.create('thread-1','二段ジャンプ');
    store.update('thread-1',{status:'waiting_info'});
    store.setKv('awaiting-instruction:thread-1','1');
    const ownerId = await transport.threadOwnerId('thread-1');
    await transport.say('thread-1','次の指示をください',{mentionUserId:ownerId});
    await transport.setThreadStatus('thread-1');
    assert.deepEqual(names,['🙋 指示待ち｜二段ジャンプ']);
    assert.match(sent[0].content,/^<@12345678901234567>/);
    assert.deepEqual(sent[0].allowedMentions,{users:['12345678901234567']});
    transport.client.destroy();
  } finally { store.close(); rmSync(dir,{recursive:true,force:true}); }
});
