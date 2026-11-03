import { Client, GatewayIntentBits, ChannelType } from 'discord.js';
import { Poster } from './poster.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { syncThreadStatus } from './thread-status.js';
import { decisionUserIds } from './settings.js';

const execFileAsync = promisify(execFile);
// 画像の視覚入力は寸法でコストが決まるため、大きな画像は渡す前に縮小して節約する。
// 変換は外部ツール（ImageMagick → ffmpeg の順で探す）に頼り、無い環境や失敗時は
// 原寸のまま渡す（節約はベストエフォートで、聞き取り自体は止めない）
const RESIZE_THRESHOLD_BYTES = 300 * 1024;
const RESIZE_MAX_EDGE = 1568;
let resizerPromise = null;
function detectResizer() {
  if (!resizerPromise) resizerPromise = (async () => {
    for (const command of ['magick', 'ffmpeg']) {
      try { await execFileAsync(command, ['-version'], { timeout: 5_000 }); return command; }
      catch { /* 次の候補へ */ }
    }
    return '';
  })();
  return resizerPromise;
}
async function resizedCopy(inputPath, outputPath) {
  const tool = await detectResizer();
  if (!tool) return false;
  try {
    if (tool === 'magick') await execFileAsync('magick', [inputPath, '-resize', `${RESIZE_MAX_EDGE}x${RESIZE_MAX_EDGE}>`, '-quality', '82', outputPath], { timeout: 20_000 });
    else await execFileAsync('ffmpeg', ['-y', '-loglevel', 'error', '-i', inputPath, '-vf', `scale='min(${RESIZE_MAX_EDGE},iw)':'min(${RESIZE_MAX_EDGE},ih)':force_original_aspect_ratio=decrease`, '-q:v', '3', outputPath], { timeout: 20_000 });
    const result = await stat(outputPath).catch(() => null);
    return Boolean(result?.size);
  } catch { return false; }
}

const legacyTranslationBlock = '\n\n🌐 **翻訳 / Translations / 번역**';
const translationBlock = /\n\n(?=(?:🇯🇵|🇺🇸|🇰🇷) )/u;

const stickerFormats = { 1:'png', 2:'png', 4:'gif' }; // 3 は Lottie（JSON）で画像としては扱えない
// スタンプの画像 URL。Lottie はラスタ画像が CDN に無いので、Discord のメディアプロキシの PNG プレビューで代替する（ベストエフォート）
export function stickerImageURL(sticker) {
  if (!sticker?.id) return '';
  const extension = stickerFormats[sticker.format];
  if (extension) return `https://cdn.discordapp.com/stickers/${sticker.id}.${extension}`;
  return `https://media.discordapp.net/stickers/${sticker.id}.png`;
}

const customEmojiPattern = /^<(a?):([\p{L}\p{N}_]{2,32}):(\d{17,20})>$/u;
// 書記素が1つだけで、それが絵文字（国旗・合体絵文字・キーボード絵文字を含む）かどうか
function isSingleUnicodeEmoji(text) {
  try {
    const segments = [...new Intl.Segmenter(undefined,{granularity:'grapheme'}).segment(text)];
    if (segments.length !== 1) return false;
  } catch { return false; }
  return /^(?:\p{Extended_Pictographic}|\p{Regional_Indicator}\p{Regional_Indicator}|[#*0-9]️⃣)/u.test(text);
}

// 本文の無い・本文が絵文字だけの発言について、翻訳ではなく見た目を移すための情報を返す。
// 移せる絵文字（Unicode／このサーバーのカスタム絵文字）は content のまま、
// 移せないカスタム絵文字とスタンプは imageURL で返す。対象でなければ null
export function standaloneVisual(message, localEmojiIds = new Set()) {
  const content = String(message?.content || '').trim();
  const stickers = message?.stickers?.size ? [...message.stickers.values()] : (Array.isArray(message?.stickers) ? message.stickers : []);
  if (!content && stickers.length === 1) {
    const imageURL = stickerImageURL(stickers[0]);
    return imageURL ? { kind:'sticker', imageURL, label:String(stickers[0].name || 'スタンプ') } : null;
  }
  if (!content) return null;
  const custom = content.match(customEmojiPattern);
  if (custom) {
    const [,animated,name,id] = custom;
    if (localEmojiIds.has(id)) return { kind:'emoji', content, label:name };
    return { kind:'emoji', imageURL:`https://cdn.discordapp.com/emojis/${id}.${animated ? 'gif' : 'png'}`, label:name };
  }
  if (isSingleUnicodeEmoji(content)) return { kind:'emoji', content, label:content };
  return null;
}

// 翻訳の併記は同じ内容の繰り返しなので、AI に渡す会話から外す
export function historyLine(message, botId, webhooks = {}) {
  const webhookId = message.webhookId || message.webhook_id || '';
  if (webhookId && webhooks.translation?.has(webhookId)) return '';
  const own = message.author?.id === botId || Boolean(webhookId && webhooks.agent?.has(webhookId));
  if (message.author?.bot && !own) return '';
  const content = String(message.content || '');
  if (own && content.startsWith('🌐 **')) return '';
  const text = own ? content.split(legacyTranslationBlock)[0].split(translationBlock)[0].trim() : content;
  const stickers = message.stickers?.size ? [...message.stickers.values()].map(sticker => sticker.name).filter(Boolean) : [];
  const attachments = message.attachments?.size ? ` [添付: ${[...message.attachments.values()].map(x => x.url).join(', ')}]` : '';
  return `${own ? `Bot(${message.author.username})` : message.author?.username || 'user'}: ${text || (stickers.length ? `[スタンプ: ${stickers.join(', ')}]` : '[添付のみ]')}${attachments}`;
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
    // 原投稿の ID → 翻訳コピー投稿 {channelId, messageId}。リアクション転送で対応付けるために保持する
    this.relayedMessages = new Map();
    this.poster = null;
  }
  get speaker() {
    this.poster ||= new Poster(this.client.rest,this.translator);
    return this.poster;
  }
  async start() {
    if (!this.config.discordToken) return false;
    this.client.on('threadCreate', async (thread, newlyCreated) => {
      if (!newlyCreated || thread.parentId !== this.config.discordChannelId) return;
      if (this.pendingStarts.has(thread.id) || this.ownThreads.has(thread.id) || thread.ownerId === this.client.user?.id) return;
      const starter = await thread.fetchStarterMessage().catch(() => null);
      await Promise.all([
        starter && !starter.author.bot ? this.translateUser(starter,thread.id) : Promise.resolve(),
        this.handleFeedback(thread.id, thread.name, '', starter && !starter.author.bot ? starter.author.id : thread.ownerId).catch(error => console.error('threadCreate', error))
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
        await this.onDecision?.(ticket.id, message.content, message.author.id, message.channelId).catch(error => console.error('decision', error));
        return;
      }
      if (message.channel.parentId !== this.config.discordChannelId) return;
      await Promise.all([
        this.translateUser(message,message.channelId),
        this.handleFeedback(message.channelId, message.channel.name, message.id, message.author.id).catch(error => console.error('messageCreate', error))
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
        this.handleFeedback(thread.id, thread.name, message.id, message.author.id)
      ]);
    } finally { this.pendingStarts.delete(message.id); }
  }
  async handleFeedback(threadId, title, messageId, authorId = '') {
    const existing = this.store.get(threadId);
    if (existing && existing.last_message_id === messageId && messageId) return;
    this.store.create(threadId, title, messageId);
    if (messageId) this.store.update(threadId, { last_message_id: messageId });
    if (/^\d{17,20}$/.test(authorId || '')) this.store.setKv(`last-author:${threadId}`,authorId);
    await this.onFeedback?.(threadId);
  }
  async history(threadId) {
    const thread = await this.client.channels.fetch(threadId);
    if (!thread?.isThread()) throw new Error(`Thread ${threadId} not found`);
    const messages = await thread.messages.fetch({ limit: 100 });
    const starter = await thread.fetchStarterMessage().catch(() => null);
    if (starter) messages.set(starter.id,starter);
    const webhooks = await this.speaker.webhookIds(threadId);
    const history = [...messages.values()].sort((a,b) => a.createdTimestamp - b.createdTimestamp)
      .map(message => historyLine(message,this.client.user?.id,webhooks)).filter(Boolean).join('\n').slice(-20_000);
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
        let finalPath = path;
        if (bytes.length > RESIZE_THRESHOLD_BYTES) {
          const smallPath = join(dir,`image-${paths.length+1}-small.jpg`);
          if (await resizedCopy(path, smallPath)) {
            const small = await stat(smallPath).catch(() => null);
            if (small && small.size < bytes.length) finalPath = smallPath;
          }
        }
        paths.push(finalPath);
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
  localEmojiIds(message) {
    try {
      const guild = message?.guild || this.client.guilds?.cache?.get(message?.guildId);
      const cache = guild?.emojis?.cache;
      return new Set(cache?.keys ? [...cache.keys()] : []);
    } catch { return new Set(); }
  }
  async translateUser(message, threadId) {
    if (!this.config.discordToken || !this.translator || this.translatedMessageIds.has(message.id)) return;
    // スタンプ単体・絵文字単体の発言は翻訳する本文が無いので、見た目をそのまま移す
    const visual = standaloneVisual(message, this.localEmojiIds(message));
    if (!message.content?.trim() && !visual) return;
    this.translatedMessageIds.add(message.id);
    if (this.translatedMessageIds.size > 1000) this.translatedMessageIds.clear();
    try {
      const username = (message.member?.displayName || message.author.displayName || message.author.username || 'user').slice(0,80);
      const avatarURL = message.member?.displayAvatarURL?.({extension:'png',size:256}) || message.author.displayAvatarURL?.({extension:'png',size:256}) || '';
      const relayId = visual
        ? await this.speaker.relayVisual(threadId,{username,avatarURL,content:visual.content || '',imageURL:visual.imageURL || ''})
        : await this.speaker.relay(threadId,message.content,{username,avatarURL});
      if (relayId) {
        this.relayedMessages.set(message.id,{channelId:threadId,messageId:String(relayId)});
        if (this.relayedMessages.size > 1000) this.relayedMessages.clear();
      }
    } catch (error) { console.error('translation of user message', error); }
  }
  async say(threadId, text, { mentionUserId = '', as = '' } = {}) {
    if (!this.config.discordToken) return;
    return this.speaker.say(threadId,text,{mentionUserId,as});
  }
  async threadOwnerId(threadId) {
    const thread = await this.client.channels.fetch(threadId);
    const starter = await thread?.fetchStarterMessage?.().catch(() => null);
    if (starter?.author && !starter.author.bot) return starter.author.id;
    return thread?.ownerId && thread.ownerId !== this.client.user?.id ? thread.ownerId : null;
  }
  async setThreadStatus(threadId) {
    return syncThreadStatus(this.config,this.store,threadId,this.fetcher);
  }
  async url(threadId) {
    const thread = await this.client.channels.fetch(threadId);
    return `https://discord.com/channels/${thread.guildId}/${threadId}`;
  }
  async decision(ticket, question, { mentionUserId = '' } = {}) {
    if (!this.config.decisionForumId) {
      await this.say(ticket.id, `👥 判断が必要です。${question}\nこのスレッドで回答してください。`,{mentionUserId,as:'pm'});
      return '';
    }
    const forum = await this.client.channels.fetch(this.config.decisionForumId);
    if (forum?.type !== ChannelType.GuildForum) throw new Error('DISCORD_DECISION_FORUM_ID is not a Forum channel');
    const deciders = decisionUserIds(this.store, this.config);
    const mention = deciders.length ? `${deciders.map(id => `<@${id}>`).join(' ')} ` : '';
    const post = await forum.threads.create({
      name: `判断依頼｜${ticket.title}`.slice(0, 100),
      message: { content: `${mention}**${ticket.title}**\n元のフィードバック: https://discord.com/channels/${forum.guildId}/${ticket.id}`, allowedMentions: deciders.length ? { users: deciders } : { parse: [] } }
    });
    await this.say(post.id, `**背景**\n${ticket.summary}\n\n**確認したいこと**\n${question}`,{as:'pm'});
    return post.id;
  }
  async stop() { this.client.destroy(); }
}
