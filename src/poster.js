import { Routes, escapeMarkdown } from 'discord.js';
import { roles } from './config.js';
import { translationLines, withTranslations } from './translation.js';

export const webhookNames = { agent:'Tonarium Agent', translation:'Tonarium Agent 通訳' };
// アイコンは管理画面で差し替えられるよう、ダッシュボード自身が /avatars/ で配信する。
// Discord は Webhook の avatar_url を投稿ごとに取得するので、push なしで反映される
export let avatarBaseUrl = 'https://tonarium-agent.kokopi.me/avatars';
export function setAvatarBaseUrl(url) {
  if (url) avatarBaseUrl = String(url).replace(/\/+$/,'');
  return avatarBaseUrl;
}
// 発話の添削（speech.js の SpeechPolisher）。エントリーポイントが起動時に差し込む。
// 未設定なら添削なしで従来どおり送る。人格は判断には混ぜず、送信直前の文章だけを整える
export let speechPolisher = null;
export function setSpeechPolisher(polisher) {
  speechPolisher = polisher || null;
  return speechPolisher;
}
const threadTypes = new Set([10,11,12]);
const retryAfterMs = 10 * 60_000;

export function roleIdentity(id) {
  const role = roles.find(entry => entry.id === id);
  return role ? { username:`${role.name}｜${role.job}`, avatarURL:`${avatarBaseUrl}/${role.avatarId || role.id}.png`, roleId: role.id, personaId: role.personaId ?? null, name: role.name } : null;
}

export function chunk(text, limit = 1900) {
  const result = [];
  for (let i = 0; i < text.length; i += limit) result.push(text.slice(i, i + limit));
  return result;
}

export const discordId = value => /^\d{17,20}$/.test(String(value || '')) ? String(value) : '';

// 単一指定（mentionUserId）と複数指定（mentionUserIds）をまとめて有効な ID の配列にする
const mentionIds = (single, list) => [...new Set([single, ...(Array.isArray(list) ? list : [])].map(discordId).filter(Boolean))];
// 本文に実際に含まれるメンションだけを通知対象にする
const allowedMentions = (ids, part) => {
  const users = ids.filter(id => part.includes(`<@${id}>`));
  return users.length ? { users } : { parse: [] };
};

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
  async botId() {
    this.botUserId ||= (await this.rest.get(Routes.user('@me'))).id;
    return this.botUserId;
  }
  // 自分が作った Webhook だけを使う。トークンを読めないものは使えないので作り直し、起動のたびに増えないようにする
  async webhooks(parentId, create = false) {
    const cached = this.hooks.get(parentId);
    if (cached && (!create || (cached.agent && cached.translation))) return cached;
    if (Date.now() < (this.unavailableUntil.get(parentId) || 0)) return cached || {};
    try {
      const botId = await this.botId();
      const owned = (await this.rest.get(Routes.channelWebhooks(parentId))).filter(entry => entry.user?.id === botId || entry.application_id === botId);
      const found = {ids:{}};
      for (const [kind,name] of Object.entries(webhookNames)) {
        const same = owned.filter(entry => entry.name === name);
        let hook = same.find(entry => entry.token);
        if (!hook && create) {
          for (const stale of same) await this.rest.delete(Routes.webhook(stale.id)).catch(() => {});
          hook = await this.rest.post(Routes.channelWebhooks(parentId),{body:{name}});
        }
        found[kind] = hook ? {id:hook.id,token:hook.token} : null;
        found.ids[kind] = new Set([...same.map(entry => entry.id),...(hook ? [hook.id] : [])]);
      }
      this.hooks.set(parentId,found);
      return found;
    } catch (error) {
      this.unavailableUntil.set(parentId,Date.now() + retryAfterMs);
      console.error('Discord webhooks unavailable; posting as the bot:',error.message);
      return cached || {};
    }
  }
  // 別プロセスが同時に作ると同名の Webhook が増えるので、履歴では同名のものをすべて自分の投稿として扱う
  async webhookIds(channelId) {
    try {
      const hooks = await this.webhooks((await this.target(channelId)).parentId);
      return {agent:hooks.ids?.agent || new Set(),translation:hooks.ids?.translation || new Set()};
    } catch { return {agent:new Set(),translation:new Set()}; }
  }
  async execute(channelId, kind, content, { username, avatarURL, mentionUserId = '', mentionUserIds = [] }) {
    const ids = mentionIds(mentionUserId, mentionUserIds);
    const {parentId,threadId} = await this.target(channelId);
    const hook = (await this.webhooks(parentId,true))[kind];
    if (!hook) return false;
    const parts = chunk(content);
    for (const [index,part] of parts.entries()) {
      try {
        await this.rest.post(Routes.webhook(hook.id,hook.token),{
          auth:false,
          query:new URLSearchParams(threadId ? {thread_id:threadId,wait:'true'} : {wait:'true'}),
          body:{content:part,username:username.slice(0,80),avatar_url:avatarURL,allowed_mentions:allowedMentions(ids,part)}
        });
      } catch (error) {
        // 消された Webhook は次の投稿で作り直す
        if (error.status === 404 || error.code === 10015) this.hooks.delete(parentId);
        if (index === 0) throw error;
        // 途中まで投稿済みなら、全文を Bot で送り直すと重複するので残りだけ送る
        await this.raw(channelId,parts.slice(index).join(''),ids);
        return true;
      }
    }
    return true;
  }
  async raw(channelId, content, mention = '') {
    const ids = mentionIds('', Array.isArray(mention) ? mention : [mention]);
    for (const part of chunk(content)) {
      await this.rest.post(Routes.channelMessages(channelId),{body:{content:part,allowed_mentions:allowedMentions(ids,part)}});
    }
  }
  async translate(text) {
    if (!this.translator) return null;
    try { return await this.translator.translate(text); }
    catch (error) { console.error('Translation failed:',error); return null; }
  }
  async say(channelId, text, { as = '', mentionUserId = '', mentionUserIds = [] } = {}) {
    const ids = mentionIds(mentionUserId, mentionUserIds);
    const mention = ids.length ? `${ids.map(id => `<@${id}>`).join(' ')} ` : '';
    const identity = roleIdentity(as);
    // 送る文章が確定した後に、人格プロンプトで口調だけを添削する（判断には影響しない）。
    // 添削側が失敗を握りつぶして原文を返す設計だが、念のためここでも原文に倒す
    let spoken = text;
    if (identity && speechPolisher) {
      try { spoken = await speechPolisher.polish(text, identity); }
      catch (error) { console.error('Speech polish failed; sending the original text:', error.message); }
    }
    const body = withTranslations(spoken,await this.translate(spoken));
    if (identity) {
      try { if (await this.execute(channelId,'agent',mention + body,{...identity,mentionUserIds:ids})) return; }
      catch (error) { console.error('Webhook post failed; posting as the bot:',error.message); }
    }
    await this.raw(channelId,`${mention}${identity ? `**${identity.username}**\n` : ''}${body}`,ids);
  }
  async relay(channelId, text, { username, avatarURL }) {
    const lines = translationLines(text,await this.translate(text));
    if (!lines) return;
    try { if (await this.execute(channelId,'translation',lines,{username,avatarURL})) return; }
    catch (error) { console.error('Webhook post failed; posting as the bot:',error.message); }
    await this.raw(channelId,`🌐 **${escapeMarkdown(username)}**\n${lines}`);
  }
}
