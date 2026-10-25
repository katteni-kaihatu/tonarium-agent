import { Client, GatewayIntentBits, ChannelType, escapeMarkdown } from 'discord.js';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function chunk(text, limit = 1900) {
  const result = [];
  for (let i = 0; i < text.length; i += limit) result.push(text.slice(i, i + limit));
  return result;
}

export class DiscordTransport {
  constructor(config, store, translator = null, fetcher = fetch) {
    this.config = config;
    this.store = store;
    this.translator = translator;
    this.fetcher = fetcher;
    this.client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] });
    this.onFeedback = null;
    this.onDecision = null;
    this.pendingStarts = new Set();
    this.ownThreads = new Set();
    this.seedMessages = new Map();
    this.translatedMessageIds = new Set();
  }
  async start() {
    if (!this.config.discordToken) return false;
    this.client.on('threadCreate', async (thread, newlyCreated) => {
      if (!newlyCreated || thread.parentId !== this.config.discordChannelId) return;
      if (this.pendingStarts.has(thread.id) || this.ownThreads.has(thread.id) || thread.ownerId === this.client.user?.id) return;
      const starter = await thread.fetchStarterMessage().catch(() => null);
      await Promise.all([
        starter && !starter.author.bot ? this.translateUser(starter,thread.id) : Promise.resolve(),
        this.handleFeedback(thread.id, thread.name, '').catch(error => console.error('threadCreate', error))
      ]);
    });
    this.client.on('messageCreate', async message => {
      if (message.author.bot || message.system) return;
      if (message.channelId === this.config.discordChannelId && !message.channel?.isThread()) {
        await this.handleParentMessage(message).catch(error => console.error('parent message', error));
        return;
      }
      if (!message.channel?.isThread()) return;
      const ticket = this.store.list().find(row => row.decision_thread_id === message.channelId);
      if (ticket) {
        await this.translateUser(message,message.channelId);
        await this.onDecision?.(ticket.id, message.content, message.author.id).catch(error => console.error('decision', error));
        return;
      }
      if (message.channel.parentId !== this.config.discordChannelId) return;
      await Promise.all([
        this.translateUser(message,message.channelId),
        this.handleFeedback(message.channelId, message.channel.name, message.id).catch(error => console.error('messageCreate', error))
      ]);
    });
    await this.client.login(this.config.discordToken);
    const channel = await this.client.channels.fetch(this.config.discordChannelId);
    if (!channel || !('threads' in channel)) throw new Error('DISCORD_CHANNEL_ID is not a text channel with threads');
    return true;
  }
  async handleParentMessage(message) {
    if (message.hasThread) return;
    this.pendingStarts.add(message.id);
    try {
      const title = (message.content || '').trim().replace(/\s+/g,' ').slice(0,80) || `フィードバック ${message.id.slice(-6)}`;
      const thread = await message.startThread({ name:title, reason:'Tonarium feedback intake' });
      this.ownThreads.add(thread.id);
      if (this.ownThreads.size > 1000) this.ownThreads.clear();
      this.seedMessages.set(thread.id, `${message.author.username}: ${message.content || '[添付のみ]'}`);
      await Promise.all([
        this.translateUser(message,thread.id),
        this.handleFeedback(thread.id, thread.name, message.id)
      ]);
    } finally { this.pendingStarts.delete(message.id); }
  }
  async handleFeedback(threadId, title, messageId) {
    const existing = this.store.get(threadId);
    if (existing && existing.last_message_id === messageId && messageId) return;
    this.store.create(threadId, title, messageId);
    if (messageId) this.store.update(threadId, { last_message_id: messageId });
    await this.onFeedback?.(threadId);
  }
  async history(threadId) {
    const thread = await this.client.channels.fetch(threadId);
    if (!thread?.isThread()) throw new Error(`Thread ${threadId} not found`);
    const messages = await thread.messages.fetch({ limit: 100 });
    const starter = await thread.fetchStarterMessage().catch(() => null);
    if (starter) messages.set(starter.id,starter);
    const history = [...messages.values()].filter(message => !message.author.bot || (message.author.id === this.client.user?.id && message.content.startsWith('🛠️ 修正依頼の引き継ぎ'))).sort((a,b) => a.createdTimestamp - b.createdTimestamp)
      .map(message => `${message.author.username}: ${message.content || '[添付のみ]'}${message.attachments.size ? ` [添付: ${[...message.attachments.values()].map(x => x.url).join(', ')}]` : ''}`).join('\n').slice(-20_000);
    if (starter) this.seedMessages.delete(threadId);
    return history || this.seedMessages.get(threadId) || '';
  }
  async downloadImages(threadId) {
    const thread = await this.client.channels.fetch(threadId);
    const messages = await thread.messages.fetch({limit:100});
    const starter = await thread.fetchStarterMessage().catch(() => null);
    if (starter) messages.set(starter.id,starter);
    const attachments = [...messages.values()].filter(message => !message.author.bot).sort((a,b) => b.createdTimestamp-a.createdTimestamp)
      .flatMap(message => [...message.attachments.values()]).filter(attachment => attachment.size <= 10 * 1024 * 1024 &&
        (/^image\/(png|jpeg)$/i.test(attachment.contentType || '') || /\.(png|jpe?g)(?:\?|$)/i.test(attachment.url))).slice(0,4);
    if (!attachments.length) return {paths:[],cleanup:async () => {}};
    const dir = await mkdtemp(join(tmpdir(),'tonarium-feedback-images-'));
    const paths = [];
    for (const attachment of attachments) {
      try {
        const url = new URL(attachment.url);
        if (url.protocol !== 'https:' || !['cdn.discordapp.com','media.discordapp.net'].includes(url.hostname)) continue;
        const response = await this.fetcher(url,{signal:AbortSignal.timeout(15_000)});
        if (!response.ok || Number(response.headers.get('content-length') || 0) > 10 * 1024 * 1024) continue;
        const bytes = Buffer.from(await response.arrayBuffer());
        if (bytes.length > 10 * 1024 * 1024) continue;
        const png = bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
        const jpeg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
        if (!png && !jpeg) continue;
        const path = join(dir,`image-${paths.length+1}.${png ? 'png' : 'jpg'}`);
        await writeFile(path,bytes);
        paths.push(path);
      } catch (error) { console.error('Could not fetch Discord image:',error.message); }
    }
    return {paths,cleanup:() => rm(dir,{recursive:true,force:true})};
  }
  async userMessage(threadId, messageId) {
    const thread = await this.client.channels.fetch(threadId);
    const message = await thread.messages.fetch(messageId).catch(() => null) || await thread.fetchStarterMessage().catch(() => null);
    if (!message || message.id !== messageId || message.author.bot) return '';
    return `${message.author.username}: ${message.content || '[添付のみ]'}${message.attachments.size ? ` [添付: ${[...message.attachments.values()].map(attachment => attachment.url).join(', ')}]` : ''}`;
  }
  async createFollowUp(ticket, report, title) {
    const channel = await this.client.channels.fetch(this.config.discordChannelId);
    if (!channel?.threads) throw new Error('Feedback text channel is unavailable');
    const thread = await channel.threads.create({name:`修正｜${title || ticket.title}`.slice(0,100),type:ChannelType.PublicThread,reason:`Follow-up to feedback ${ticket.id}`});
    this.ownThreads.add(thread.id);
    const originalUrl = `https://discord.com/channels/${thread.guildId}/${ticket.id}`;
    await thread.send({content:`🛠️ 修正依頼の引き継ぎ\n元のフィードバック: ${originalUrl}\n元のPR: ${ticket.pr_number ? `#${ticket.pr_number}` : 'なし'}\n報告: ${report}`.slice(0,1900),allowedMentions:{parse:[]}});
    return {id:thread.id,url:`https://discord.com/channels/${thread.guildId}/${thread.id}`};
  }
  async sendRaw(threadId, text, mentionUserId = '') {
    if (!this.config.discordToken) return;
    const thread = await this.client.channels.fetch(threadId);
    for (const part of chunk(text)) await thread.send({ content: part, allowedMentions: mentionUserId && part.includes(`<@${mentionUserId}>`) ? { users: [mentionUserId] } : { parse: [] } });
  }
  async translateUser(message, threadId) {
    if (!this.translator || !message.content?.trim() || this.translatedMessageIds.has(message.id)) return;
    this.translatedMessageIds.add(message.id);
    if (this.translatedMessageIds.size > 1000) this.translatedMessageIds.clear();
    try {
      const result = await this.translator.translate(message.content);
      const name = escapeMarkdown(message.author.displayName || message.author.username || 'user').slice(0,80);
      await this.sendRaw(threadId, `🌐 **${name} の発言 / message / 메시지**\n🇯🇵 ${result.ja}\n🇺🇸 ${result.en}\n🇰🇷 ${result.ko}`);
    } catch (error) { console.error('translation of user message', error); }
  }
  async say(threadId, text, { mentionUserId = '' } = {}) {
    const mention = /^\d{17,20}$/.test(mentionUserId) ? `<@${mentionUserId}> ` : '';
    if (!this.translator) return this.sendRaw(threadId,mention + text,mentionUserId);
    try {
      const result = await this.translator.translate(text);
      return this.sendRaw(threadId, `${mention}${text}\n\n🌐 **翻訳 / Translations / 번역**\n🇯🇵 ${result.ja}\n🇺🇸 ${result.en}\n🇰🇷 ${result.ko}`,mentionUserId);
    } catch (error) {
      console.error('translation of bot message', error);
      return this.sendRaw(threadId,mention + text,mentionUserId);
    }
  }
  async threadOwnerId(threadId) {
    const thread = await this.client.channels.fetch(threadId);
    const starter = await thread?.fetchStarterMessage?.().catch(() => null);
    if (starter?.author && !starter.author.bot) return starter.author.id;
    return thread?.ownerId && thread.ownerId !== this.client.user?.id ? thread.ownerId : null;
  }
  async setThreadStatus(threadId,emoji) {
    const thread = await this.client.channels.fetch(threadId);
    if (!thread?.isThread?.()) return;
    const prefixes = ['❓','📝','⏳','🛠️','🔄','🧪','🔀','✅','🔗','⚠️','🙋'];
    const previous = prefixes.find(prefix => thread.name.startsWith(`${prefix} `));
    const title = previous ? thread.name.slice(previous.length + 1) : thread.name;
    const next = `${emoji} ${title}`.slice(0,100);
    if (thread.name !== next) await thread.setName(next);
  }
  async url(threadId) {
    const thread = await this.client.channels.fetch(threadId);
    return `https://discord.com/channels/${thread.guildId}/${threadId}`;
  }
  async decision(ticket, question) {
    if (!this.config.decisionForumId) {
      await this.say(ticket.id, `👥 判断が必要です。${question}`);
      return '';
    }
    const forum = await this.client.channels.fetch(this.config.decisionForumId);
    if (forum?.type !== ChannelType.GuildForum) throw new Error('DISCORD_DECISION_FORUM_ID is not a Forum channel');
    const mention = this.config.decisionMentionId ? `<@${this.config.decisionMentionId}> ` : '';
    const post = await forum.threads.create({
      name: `判断依頼｜${ticket.title}`.slice(0, 100),
      message: { content: `${mention}**${ticket.title}**\n元のフィードバック: https://discord.com/channels/${forum.guildId}/${ticket.id}`, allowedMentions: this.config.decisionMentionId ? { users: [this.config.decisionMentionId] } : { parse: [] } }
    });
    await this.say(post.id, `**背景**\n${ticket.summary}\n\n**確認したいこと**\n${question}`);
    return post.id;
  }
  async stop() { this.client.destroy(); }
}
