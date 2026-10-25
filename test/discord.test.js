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
