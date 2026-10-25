import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ChannelType, REST, Routes } from 'discord.js';
import { getConfig } from './config.js';
import { Store } from './store.js';
import { AI } from './ai.js';
import { GitHub } from './git.js';
import { Translator } from './translation.js';
import { Engine } from './engine.js';

const id = process.argv[2];
if (!/^\d{17,20}$/.test(id || '')) throw new Error('Pass a Discord thread ID');
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const config = getConfig();
const store = new Store(join(root,'.data','state.sqlite'));
const ai = new AI(config);
const git = new GitHub(config,root);
const translator = new Translator(config,ai,root);
const rest = new REST({version:'10'}).setToken(config.discordToken);
const discord = {
  async userMessage(threadId,messageId) {
    const message = await rest.get(Routes.channelMessage(threadId,messageId));
    return message.author?.bot ? '' : `${message.author?.username || 'user'}: ${message.content || '[添付のみ]'}${message.attachments?.length ? ` [添付: ${message.attachments.map(attachment => attachment.url).join(', ')}]` : ''}`;
  },
  async history(threadId) {
    const messages = await rest.get(Routes.channelMessages(threadId),{query:new URLSearchParams({limit:'100'})});
    return messages.filter(message => !message.author?.bot || message.content?.startsWith('🛠️ 修正依頼の引き継ぎ')).sort((a,b) => Date.parse(a.timestamp)-Date.parse(b.timestamp))
      .map(message => `${message.author?.username || 'user'}: ${message.content || '[添付のみ]'}`).join('\n').slice(-20_000);
  },
  async url(threadId) {
    const thread = await rest.get(Routes.channel(threadId));
    return `https://discord.com/channels/${thread.guild_id}/${threadId}`;
  },
  async createFollowUp(ticket,report,title) {
    const thread = await rest.post(Routes.threads(config.discordChannelId),{body:{name:`修正｜${title || ticket.title}`.slice(0,100),type:ChannelType.PublicThread,auto_archive_duration:1440}});
    const originalUrl = `https://discord.com/channels/${thread.guild_id}/${ticket.id}`;
    await rest.post(Routes.channelMessages(thread.id),{body:{content:`🛠️ 修正依頼の引き継ぎ\n元のフィードバック: ${originalUrl}\n元のPR: ${ticket.pr_number ? `#${ticket.pr_number}` : 'なし'}\n報告: ${report}`.slice(0,1900),allowed_mentions:{parse:[]}}});
    return {id:thread.id,url:`https://discord.com/channels/${thread.guild_id}/${thread.id}`};
  },
  async say(threadId,text) {
    let message = text;
    try {
      const translated = await translator.translate(text);
      message += `\n\n🌐 **翻訳 / Translations / 번역**\n🇯🇵 ${translated.ja}\n🇺🇸 ${translated.en}\n🇰🇷 ${translated.ko}`;
    } catch (error) { console.error('Answer translation:',error); }
    for (let offset = 0; offset < message.length; offset += 1900) {
      await rest.post(Routes.channelMessages(threadId),{body:{content:message.slice(offset,offset+1900),allowed_mentions:{parse:[]}}});
    }
  }
};

try {
  if (!store.get(id)) throw new Error(`Thread ${id} is not a known ticket`);
  const engine = new Engine(config,store,ai,git,discord);
  await engine.followUp(id);
  console.log(`Completed-thread follow-up checked for ${id}.`);
} finally { store.close(); }
