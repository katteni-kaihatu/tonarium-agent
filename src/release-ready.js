import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { REST, Routes } from 'discord.js';
import { getConfig } from './config.js';
import { Store } from './store.js';
import { AI } from './ai.js';
import { GitHub } from './git.js';
import { Translator } from './translation.js';
import { Engine } from './engine.js';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const config = getConfig();
const store = new Store(join(root,'.data','state.sqlite'));
const ai = new AI(config);
const git = new GitHub(config,root);
const translator = new Translator(config,ai,root);
const rest = new REST({version:'10'}).setToken(config.discordToken);
const discord = {
  async say(id, text) {
    let message = text;
    try {
      const translated = await translator.translate(text);
      message += `\n\n🌐 **翻訳 / Translations / 번역**\n🇯🇵 ${translated.ja}\n🇺🇸 ${translated.en}\n🇰🇷 ${translated.ko}`;
    } catch (error) { console.error('Release notification translation:',error); }
    for (let i = 0; i < message.length; i += 1900) {
      await rest.post(Routes.channelMessages(id), {body:{content:message.slice(i,i+1900),allowed_mentions:{parse:[]}}});
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
} finally { store.close(); }
