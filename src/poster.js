import { Routes } from 'discord.js';
import { roles } from './config.js';
import { translationLines, withTranslations } from './translation.js';

export const webhookNames = { agent:'Tonarium Agent', translation:'Tonarium Agent 通訳' };
// リポジトリは公開なので、Discord が取得できる GitHub の配信 URL を使う
export const avatarBaseUrl = 'https://raw.githubusercontent.com/katteni-kaihatu/tonarium-agent/main/public/avatars';
const threadTypes = new Set([10,11,12]);
const retryAfterMs = 10 * 60_000;

export function roleIdentity(id) {
  const role = roles.find(entry => entry.id === id);
  return role ? { username:`${role.name}｜${role.job}`, avatarURL:`${avatarBaseUrl}/${role.id}.png` } : null;
}

export function chunk(text, limit = 1900) {
  const result = [];
  for (let i = 0; i < text.length; i += limit) result.push(text.slice(i, i + limit));
  return result;
}

export const discordId = value => /^\d{17,20}$/.test(String(value || '')) ? String(value) : '';

// 担当と参加者の翻訳を、それぞれの名前とアイコンで投稿する。Webhook を使えない環境では Bot 本人の投稿に戻す
export class Poster {
  constructor(rest, translator = null) {
    Object.assign(this,{rest,translator});
    this.targets = new Map();
    this.hooks = new Map();
    this.unavailableUntil = new Map();
  }
  async target(channelId) {
    if (!this.targets.has(channelId)) {
      const channel = await this.rest.get(Routes.channel(channelId));
      this.targets.set(channelId,threadTypes.has(channel.type) ? {parentId:channel.parent_id,threadId:channelId} : {parentId:channelId,threadId:''});
    }
    return this.targets.get(channelId);
  }
  async webhooks(parentId, create = false) {
    if (this.hooks.has(parentId) && (!create || Object.values(this.hooks.get(parentId)).every(Boolean))) return this.hooks.get(parentId);
    if (Date.now() < (this.unavailableUntil.get(parentId) || 0)) return this.hooks.get(parentId) || {};
    try {
      const existing = await this.rest.get(Routes.channelWebhooks(parentId));
      const found = {};
      for (const [kind,name] of Object.entries(webhookNames)) {
        let hook = existing.find(entry => entry.name === name && entry.token);
        if (!hook && create) hook = await this.rest.post(Routes.channelWebhooks(parentId),{body:{name}});
        found[kind] = hook ? {id:hook.id,token:hook.token} : null;
      }
      this.hooks.set(parentId,found);
      return found;
    } catch (error) {
      this.unavailableUntil.set(parentId,Date.now() + retryAfterMs);
      console.error('Discord webhooks unavailable; posting as the bot:',error.message);
      return this.hooks.get(parentId) || {};
    }
  }
  async webhookIds(channelId) {
    try {
      const hooks = await this.webhooks((await this.target(channelId)).parentId);
      return {agent:hooks.agent?.id || '',translation:hooks.translation?.id || ''};
    } catch { return {agent:'',translation:''}; }
  }
  async execute(channelId, kind, content, { username, avatarURL, mentionUserId = '' }) {
    const {parentId,threadId} = await this.target(channelId);
    const hook = (await this.webhooks(parentId,true))[kind];
    if (!hook) return false;
    for (const part of chunk(content)) {
      await this.rest.post(Routes.webhook(hook.id,hook.token),{
        auth:false,
        query:new URLSearchParams(threadId ? {thread_id:threadId,wait:'true'} : {wait:'true'}),
        body:{content:part,username:username.slice(0,80),avatar_url:avatarURL,allowed_mentions:mentionUserId && part.includes(`<@${mentionUserId}>`) ? {users:[mentionUserId]} : {parse:[]}}
      });
    }
    return true;
  }
  async raw(channelId, content, mentionUserId = '') {
    for (const part of chunk(content)) {
      await this.rest.post(Routes.channelMessages(channelId),{body:{content:part,allowed_mentions:mentionUserId && part.includes(`<@${mentionUserId}>`) ? {users:[mentionUserId]} : {parse:[]}}});
    }
  }
  async translate(text) {
    if (!this.translator) return null;
    try { return await this.translator.translate(text); }
    catch (error) { console.error('Translation failed:',error); return null; }
  }
  async say(channelId, text, { as = '', mentionUserId = '' } = {}) {
    const mention = discordId(mentionUserId) ? `<@${mentionUserId}> ` : '';
    const body = withTranslations(text,await this.translate(text));
    const identity = roleIdentity(as);
    if (identity) {
      try { if (await this.execute(channelId,'agent',mention + body,{...identity,mentionUserId})) return; }
      catch (error) { console.error('Webhook post failed; posting as the bot:',error.message); }
    }
    await this.raw(channelId,`${mention}${identity ? `**${identity.username}**\n` : ''}${body}`,mentionUserId);
  }
  async relay(channelId, text, { username, avatarURL }) {
    const lines = translationLines(text,await this.translate(text));
    if (!lines) return;
    try { if (await this.execute(channelId,'translation',lines,{username,avatarURL})) return; }
    catch (error) { console.error('Webhook post failed; posting as the bot:',error.message); }
    await this.raw(channelId,`🌐 **${username}**\n${lines}`);
  }
}
