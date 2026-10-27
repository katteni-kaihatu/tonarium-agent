import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { REST, Routes } from 'discord.js';
import { getConfig } from './config.js';
import { Store } from './store.js';
import { AI } from './ai.js';
import { GitHub } from './git.js';
import { Translator } from './translation.js';
import { MainRelease } from './main-release.js';
import { syncThreadStatus } from './thread-status.js';
import { acquireLock } from './lock.js';

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
const ai = new AI(config);
const git = new GitHub(config,root);
const translator = new Translator(config,ai,root);
const rest = config.discordToken ? new REST({version:'10'}).setToken(config.discordToken) : null;
async function notify(text, { mention = false } = {}) {
  if (dryRun || !rest || !config.releaseChannelId) return;
  let message = text;
  try {
    const translated = await translator.translate(text);
    message += `\n\n🌐 **翻訳 / Translations / 번역**\n🇯🇵 ${translated.ja}\n🇺🇸 ${translated.en}\n🇰🇷 ${translated.ko}`;
  } catch (error) { console.error('Release notification translation:',error); }
  const mentionId = mention && /^\d{17,20}$/.test(config.decisionMentionId) ? config.decisionMentionId : '';
  message = `${mentionId ? `<@${mentionId}> ` : ''}${message}`;
  for (let i = 0; i < message.length; i += 1900) {
    const part = message.slice(i,i+1900);
    await rest.post(Routes.channelMessages(config.releaseChannelId),{body:{content:part,allowed_mentions:mentionId && part.includes(`<@${mentionId}>`) ? {users:[mentionId]} : {parse:[]}}});
  }
}

try {
  const release = new MainRelease(config,store,ai,git,notify,id => rest ? syncThreadStatus(config,store,id) : Promise.resolve());
  const result = await release.run({dryRun});
  console.log(`Main release: ${result.status}`);
} catch (error) {
  console.error('Main release failed:',error.message);
  process.exitCode = 1;
} finally { store.close(); await lock.release(); }
