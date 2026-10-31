import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { REST } from 'discord.js';
import { getConfig } from './config.js';
import { Store } from './store.js';
import { AI } from './ai.js';
import { GitHub } from './git.js';
import { Translator } from './translation.js';
import { MainRelease } from './main-release.js';
import { syncThreadStatus } from './thread-status.js';
import { acquireLock } from './lock.js';
import { Poster, setAvatarBaseUrl, setSpeechPolisher } from './poster.js';
import { SpeechPolisher } from './speech.js';
import { applySettings, aiHooks, decisionUserIds } from './settings.js';

const dryRun = process.argv.includes('--dry-run');
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const config = getConfig();
const store = new Store(join(root,'.data','state.sqlite'));
const lock = await acquireLock(join(root,'.data','release-main.lock'));
if (!lock) {
  console.log('Another main release is already running.');
  store.close();
  process.exit(0);
}
applySettings(store, config);
setAvatarBaseUrl(`${config.adminPublicUrl || 'https://tonarium-agent.kokopi.me'}/avatars`);
const ai = new AI(config, root, aiHooks(store));
setSpeechPolisher(new SpeechPolisher(ai, aiHooks(store), { cwd: root }));
const git = new GitHub(config,root);
const translator = new Translator(config,ai,root);
const rest = config.discordToken ? new REST({version:'10'}).setToken(config.discordToken) : null;
async function notify(text, { mention = false } = {}) {
  if (dryRun || !rest || !config.releaseChannelId) return;
  await new Poster(rest,translator).say(config.releaseChannelId,text,{as:'mainrelease',mentionUserIds:mention ? decisionUserIds(store, config) : []});
}

try {
  const release = new MainRelease(config,store,ai,git,notify,id => rest ? syncThreadStatus(config,store,id) : Promise.resolve());
  const result = await release.run({dryRun});
  console.log(`Main release: ${result.status}`);
} catch (error) {
  console.error('Main release failed:',error.message);
  process.exitCode = 1;
} finally { store.close(); await lock.release(); }
