import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { REST, Routes } from 'discord.js';
import { getConfig } from './config.js';
import { Store } from './store.js';
import { AI } from './ai.js';
import { GitHub } from './git.js';
import { Translator } from './translation.js';
import { Engine } from './engine.js';
import { syncThreadStatus } from './thread-status.js';
import { acquireLock } from './lock.js';
import { Poster, setAvatarBaseUrl } from './poster.js';
import { applySettings, aiHooks } from './settings.js';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const config = getConfig();
const store = new Store(join(root,'.data','state.sqlite'));
const lock = await acquireLock(join(root,'.data','release.lock'));
if (!lock) {
  console.log('Another release is already running.');
  store.close();
  process.exit(0);
}
applySettings(store, config);
setAvatarBaseUrl(`${config.adminPublicUrl || 'https://tonarium-agent.kokopi.me'}/avatars`);
const ai = new AI(config, root, aiHooks(store));
const git = new GitHub(config,root);
const translator = new Translator(config,ai,root);
const rest = new REST({version:'10'}).setToken(config.discordToken);
const poster = new Poster(rest,translator);
const discord = {
  async setThreadStatus(id) {
    return syncThreadStatus(config,store,id);
  },
  async threadOwnerId(id) {
    const thread = await rest.get(Routes.channel(id));
    const starter = await rest.get(Routes.channelMessage(thread.parent_id,id)).catch(() => null);
    return starter?.author && !starter.author.bot ? starter.author.id : null;
  },
  async say(id, text, options = {}) {
    return poster.say(id,text,options);
  }
};

try {
  const ready = store.byStatus(['pr_ready']).filter(row => row.pr_number);
  if (!ready.length) console.log('No PR is ready for release.');
  else {
    const engine = new Engine(config,store,ai,git,discord);
    const success = await engine.release(true);
    const latest = store.releases()[0];
    console.log(`Release ${latest?.id || ''}: ${latest?.status || (success ? 'merged' : 'failed')}`);
    if (!success) process.exitCode = 1;
  }
} finally { store.close(); await lock.release(); }
