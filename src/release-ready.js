import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { open, readFile, rm, stat } from 'node:fs/promises';
import { REST, Routes } from 'discord.js';
import { getConfig } from './config.js';
import { Store } from './store.js';
import { AI } from './ai.js';
import { GitHub } from './git.js';
import { Translator } from './translation.js';
import { Engine } from './engine.js';
import { syncThreadStatus } from './thread-status.js';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const config = getConfig();
const store = new Store(join(root,'.data','state.sqlite'));
const lockPath = join(root,'.data','release.lock');
async function acquireLock() {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const handle = await open(lockPath,'wx');
      await handle.writeFile(String(process.pid));
      return handle;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const age = Date.now() - (await stat(lockPath)).mtimeMs;
      if (age < 10_000) return null;
      let alive = false;
      try { process.kill(Number(await readFile(lockPath,'utf8')),0); alive = true; }
      catch (checkError) { alive = checkError.code === 'EPERM'; }
      if (alive) return null;
      await rm(lockPath,{force:true});
    }
  }
  return null;
}
const lock = await acquireLock();
if (!lock) {
  console.log('Another release is already running.');
  store.close();
  process.exit(0);
}
const ai = new AI(config);
const git = new GitHub(config,root);
const translator = new Translator(config,ai,root);
const rest = new REST({version:'10'}).setToken(config.discordToken);
const discord = {
  async setThreadStatus(id) {
    return syncThreadStatus(config,store,id);
  },
  async threadOwnerId(id) {
    const thread = await rest.get(Routes.channel(id));
    const starter = await rest.get(Routes.channelMessage(thread.parent_id,id)).catch(() => null);
    return starter?.author && !starter.author.bot ? starter.author.id : null;
  },
  async say(id, text, {mentionUserId = ''} = {}) {
    let message = text;
    try {
      const translated = await translator.translate(text);
      message += `\n\n🌐 **翻訳 / Translations / 번역**\n🇯🇵 ${translated.ja}\n🇺🇸 ${translated.en}\n🇰🇷 ${translated.ko}`;
    } catch (error) { console.error('Release notification translation:',error); }
    const mention = /^\d{17,20}$/.test(mentionUserId) ? `<@${mentionUserId}> ` : '';
    message = mention + message;
    for (let i = 0; i < message.length; i += 1900) {
      const part = message.slice(i,i+1900);
      const allowed = mentionUserId && part.includes(mention) ? {users:[mentionUserId]} : {parse:[]};
      await rest.post(Routes.channelMessages(id), {body:{content:part,allowed_mentions:allowed}});
    }
  }
};

try {
  const ready = store.list().filter(row => row.status === 'pr_ready' && row.pr_number);
  if (!ready.length) console.log('No PR is ready for release.');
  else {
    const engine = new Engine(config,store,ai,git,discord);
    const success = await engine.release(true);
    const latest = store.releases()[0];
    console.log(`Release ${latest?.id || ''}: ${latest?.status || (success ? 'merged' : 'failed')}`);
    if (!success) process.exitCode = 1;
  }
} finally { store.close(); await lock.close(); await rm(lockPath,{force:true}); }
