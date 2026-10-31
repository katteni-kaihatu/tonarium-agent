import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ChannelType, REST, Routes } from 'discord.js';
import { getConfig } from './config.js';
import { Store } from './store.js';
import { AI } from './ai.js';
import { GitHub } from './git.js';
import { Translator } from './translation.js';
import { Engine } from './engine.js';
import { applySettings, aiHooks } from './settings.js';
import { setAvatarBaseUrl, setSpeechPolisher } from './poster.js';
import { SpeechPolisher } from './speech.js';
import { historyLine } from './discord.js';
import { Poster } from './poster.js';

const id = process.argv[2];
if (!/^\d{17,20}$/.test(id || '')) throw new Error('Pass a Discord thread ID');
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const config = getConfig();
const store = new Store(join(root,'.data','state.sqlite'));
applySettings(store, config);
setAvatarBaseUrl(`${config.adminPublicUrl || 'https://tonarium-agent.kokopi.me'}/avatars`);
const ai = new AI(config, root, aiHooks(store));
setSpeechPolisher(new SpeechPolisher(ai, aiHooks(store), { cwd: root }));
const git = new GitHub(config,root);
const translator = new Translator(config,ai,root);
const rest = new REST({version:'10'}).setToken(config.discordToken);
const poster = new Poster(rest,translator);
const discord = {
  async userMessage(threadId,messageId) {
    const message = await rest.get(Routes.channelMessage(threadId,messageId));
    return message.author?.bot ? '' : `${message.author?.username || 'user'}: ${message.content || '[添付のみ]'}${message.attachments?.length ? ` [添付: ${message.attachments.map(attachment => attachment.url).join(', ')}]` : ''}`;
  },
  async history(threadId) {
    const messages = await rest.get(Routes.channelMessages(threadId),{query:new URLSearchParams({limit:'100'})});
    const botId = (await rest.get(Routes.user('@me'))).id;
    const webhooks = await poster.webhookIds(threadId);
    return messages.sort((a,b) => Date.parse(a.timestamp)-Date.parse(b.timestamp))
      .map(message => historyLine({...message,attachments:new Map((message.attachments || []).map(attachment => [attachment.id,attachment]))},botId,webhooks)).filter(Boolean).join('\n').slice(-20_000);
  },
  async url(threadId) {
    const thread = await rest.get(Routes.channel(threadId));
    return `https://discord.com/channels/${thread.guild_id}/${threadId}`;
  },
  async threadOwnerId(threadId) {
    const thread = await rest.get(Routes.channel(threadId));
    const starter = await rest.get(Routes.channelMessage(thread.parent_id,threadId)).catch(() => null);
    return starter?.author && !starter.author.bot ? starter.author.id : thread.owner_id || null;
  },
  async say(threadId,text,options = {}) {
    return poster.say(threadId,text,options);
  }
};

try {
  if (!store.get(id)) throw new Error(`Thread ${id} is not a known ticket`);
  const engine = new Engine(config,store,ai,git,discord);
  // 続きの対応を始める場合は、常駐 Bot が聞き取りを引き継ぐ
  engine.deferRounds = true;
  await engine.followUp(id);
  console.log(`Completed-thread follow-up checked for ${id}.`);
} finally { store.close(); }
