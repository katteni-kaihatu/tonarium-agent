import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
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
