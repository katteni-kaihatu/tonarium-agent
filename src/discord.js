import { Client, GatewayIntentBits, ChannelType } from 'discord.js';

function chunk(text, limit = 1900) {
  const result = [];
  for (let i = 0; i < text.length; i += limit) result.push(text.slice(i, i + limit));
  return result;
}

export class DiscordTransport {
  constructor(config, store) {
    this.config = config;
    this.store = store;
    this.client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] });
    this.onFeedback = null;
    this.onDecision = null;
  }
  async start() {
    if (!this.config.discordToken) return false;
    this.client.on('threadCreate', async (thread, newlyCreated) => {
      if (!newlyCreated || thread.parentId !== this.config.discordChannelId) return;
      await this.handleFeedback(thread.id, thread.name, '').catch(error => console.error('threadCreate', error));
    });
    this.client.on('messageCreate', async message => {
      if (message.author.bot || !message.channel?.isThread()) return;
      const ticket = this.store.list().find(row => row.decision_thread_id === message.channelId);
      if (ticket) {
        await this.onDecision?.(ticket.id, message.content, message.author.id).catch(error => console.error('decision', error));
        return;
      }
      if (message.channel.parentId !== this.config.discordChannelId) return;
      await this.handleFeedback(message.channelId, message.channel.name, message.id).catch(error => console.error('messageCreate', error));
    });
    await this.client.login(this.config.discordToken);
    const channel = await this.client.channels.fetch(this.config.discordChannelId);
    if (!channel || !('threads' in channel)) throw new Error('DISCORD_CHANNEL_ID is not a text channel with threads');
    const active = await channel.threads.fetchActive();
    for (const thread of active.threads.values()) {
      if (!this.store.get(thread.id)) await this.handleFeedback(thread.id,thread.name,'');
    }
    return true;
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
    return [...messages.values()].filter(message => !message.author.bot).sort((a,b) => a.createdTimestamp - b.createdTimestamp)
      .map(message => `${message.author.username}: ${message.content || '[添付のみ]'}${message.attachments.size ? ` [添付: ${[...message.attachments.values()].map(x => x.url).join(', ')}]` : ''}`).join('\n').slice(-20_000);
  }
  async say(threadId, text) {
    if (!this.config.discordToken) return;
    const thread = await this.client.channels.fetch(threadId);
    for (const part of chunk(text)) await thread.send({ content: part, allowedMentions: { parse: [] } });
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
      message: { content: `${mention}**${ticket.title}**\n${ticket.summary}\n\n**確認したいこと**\n${question}\n\n元のフィードバック: https://discord.com/channels/${forum.guildId}/${ticket.id}`, allowedMentions: this.config.decisionMentionId ? { users: [this.config.decisionMentionId] } : { parse: [] } }
    });
    return post.id;
  }
  async stop() { this.client.destroy(); }
}
