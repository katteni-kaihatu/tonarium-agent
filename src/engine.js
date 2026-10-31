import { roles } from './config.js';
import { existsSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { SnowflakeUtil } from 'discord.js';
import { userFacingChanges } from './ai.js';
import { decisionUserIds, isDecisionUser, customizedMemberIds } from './settings.js';

const roleName = id => roles.find(role => role.id === id)?.name || id;
const asList = value => Array.isArray(value) ? value.map(String).filter(Boolean) : [];
const trim = (value, length = 1500) => String(value || '').slice(0, length);
const discordId = value => /^\d{17,20}$/.test(String(value || '')) ? String(value) : '';
const statusEvents = new Set(['intake_started','question','decision','decision_answer','ready','queued','coding','retry_scheduled','release_retry','pr_ready','integrating','merged','existing','grouped','failed','needs_instruction','proposal','declined','round_started','main_released']);
const doneStatuses = ['grouped','failed','merged','resolved_existing','declined'];
const beforePrStatuses = ['intake','waiting_info','proposal','planning','decision','queued','coding'];
const verdicts = ['implement','propose','decline','decision'];
// 見送りへの異議と判断基準に当たる変更は、依頼者が自分で通せないよう決定者の回答だけで進める
const restrictedKinds = ['appeal','guardrail'];
const roundKeys = id => ['task','purpose','failure-count','retry-count:@:code','retry-count:@:publish','failed-review-count','failed-review-after','retry-stage','retry-instruction','release-instruction','release-failure-count','release-pm-repairs','release-retry-after','awaiting-instruction','awaiting-instruction-stage','proposal','decline','decision-kind','addenda','pending-followup','main-released','user-changes']
  .map(key => key.includes('@') ? key.replace('@',id) : `${key}:${id}`);

export class Engine {
  constructor(config, store, ai, git, discord, onChange = () => {}) {
    Object.assign(this, { config, store, ai, git, discord, onChange });
    this.active = new Set();
    this.pendingFeedback = new Set();
    this.busyWorkers = new Set();
    this.roleBusy = new Map();
    this.roleWaiters = new Map();
    this.releasing = false;
    this.lastReleaseAttempt = 0;
    this.timer = null;
    this.threadStatusUpdates = new Map();
    this.deferRounds = false;
    this.random = Math.random;
  }
  // 担当者選びの優先順: デフォルトから変わっているメンバーを先に、
  // 各グループの中はランダム。一人目に固定で寄らないようにするための並び
  prioritizedRoles(job) {
    const all = roles.filter(role => role.job === job);
    let changed = new Set();
    try { changed = customizedMemberIds(this.store); } catch { changed = new Set(); }
    const shuffle = list => {
      const copy = [...list];
      for (let i = copy.length - 1; i > 0; i--) {
        const j = Math.floor(this.random() * (i + 1));
        [copy[i], copy[j]] = [copy[j], copy[i]];
      }
      return copy;
    };
    return [...shuffle(all.filter(role => changed.has(role.id))), ...shuffle(all.filter(role => !changed.has(role.id)))];
  }
  pickFreeRole(job) {
    return this.prioritizedRoles(job).find(role => !this.roleBusy.has(role.id)) || null;
  }
  event(id, actor, kind, text) {
    this.store.event(id, roleName(actor), kind, text);
    this.onChange();
    if (id && statusEvents.has(kind) && this.discord.setThreadStatus) {
      this.store.setKv(`thread-status-dirty:${id}`,'1');
      this.queueThreadStatus(id);
    }
  }
  queueThreadStatus(id) {
    if (this.discord.setThreadStatus) {
      const previous = this.threadStatusUpdates.get(id) || Promise.resolve();
      const update = previous.then(() => this.discord.setThreadStatus(id))
        .catch(error => {
          this.store.setKv(`thread-status-retry-after:${id}`,Date.now() + 30_000);
          console.error('Could not update Discord thread status:',error);
        })
        .finally(() => { if (this.threadStatusUpdates.get(id) === update) this.threadStatusUpdates.delete(id); });
      this.threadStatusUpdates.set(id,update);
    }
  }
  async acquireRole(job, ticketId) {
    const candidates = roles.filter(role => role.job === job);
    if (!candidates.length) throw new Error(`No ${job} agent is configured`);
    const free = this.pickFreeRole(job);
    if (!free) return new Promise(resolve => {
      const queue = this.roleWaiters.get(job) || [];
      queue.push({ ticketId, resolve });
      this.roleWaiters.set(job,queue);
    });
    this.roleBusy.set(free.id,ticketId);
    this.onChange();
    return free;
  }
  releaseRole(role) {
    this.roleBusy.delete(role.id);
    // 解放されたロールが人数変更で消えていたら、そのロールは二度と渡さない。
    // 待機案件には現在のメンバーの空きロールを割り直す
    this.serveWaiters(role.job);
    this.onChange();
  }
  serveWaiters(job) {
    const queue = this.roleWaiters.get(job);
    if (!queue) return;
    while (queue.length) {
      const free = this.pickFreeRole(job);
      if (!free) break;
      const next = queue.shift();
      this.roleBusy.set(free.id,next.ticketId);
      next.resolve(free);
    }
    if (!queue.length) this.roleWaiters.delete(job);
  }
  // 管理画面でメンバーが差し替わった直後に呼ぶ。消えたロールの使用中印を落とし、
  // 待機案件を現在の空きロールへ割り直す（稼働中の担当そのものは止めない）
  reconcileRoles() {
    const valid = new Set(roles.map(role => role.id));
    for (const id of [...this.roleBusy.keys()]) if (!valid.has(id)) this.roleBusy.delete(id);
    for (const job of [...this.roleWaiters.keys()]) this.serveWaiters(job);
    this.onChange();
  }
  // 返事を待って止まるときだけ相手に通知し、進捗報告では通知しない
  post(id, as, text, options = {}) {
    return this.discord.say(id,text,{...options,as});
  }
  async askUser(id, as, text, { to = 'author' } = {}) {
    const author = discordId(this.store.getKv(`last-author:${id}`));
    const owner = discordId(await this.discord.threadOwnerId?.(id).catch(() => null));
    const mentionUserId = (to === 'owner' ? owner || author : author || owner) || '';
    return this.discord.say(id,text,{mentionUserId,as});
  }
  // 聞き取りで未確認のまま残った事項。PM・リード・実装へ引き継ぎ、
  // 同じ質問の繰り返しと、未確認の前提への無自覚な依存を防ぐ
  unknowns(id) {
    try { return asList(JSON.parse(this.store.getKv(`unknowns:${id}`) || '[]')); }
    catch { return []; }
  }
  addenda(id) {
    try { return asList(JSON.parse(this.store.getKv(`addenda:${id}`) || '[]').map(entry => entry?.text)); }
    catch { return []; }
  }
  addAddendum(id, messageId, text) {
    let list = [];
    try { list = JSON.parse(this.store.getKv(`addenda:${id}`) || '[]'); } catch { /* start over */ }
    if (!text || list.some(entry => entry?.messageId === messageId)) return false;
    list.push({messageId,text:trim(text,1500)});
    this.store.setKv(`addenda:${id}`,JSON.stringify(list.slice(-20)));
    return true;
  }
  async latestUserText(id) {
    const ticket = this.store.get(id);
    if (!ticket?.last_message_id) return '';
    return await this.discord.userMessage?.(id,ticket.last_message_id).catch(() => '') || '';
  }
  // 同じ発言に二度返事をしないための印。完了後の質問が使う answered_message_id とは分ける
  acknowledge(id) {
    const messageId = this.store.get(id)?.last_message_id;
    if (!messageId || this.store.getKv(`acked:${id}`) === messageId) return '';
    this.store.setKv(`acked:${id}`,messageId);
    return messageId;
  }
  async roundContext(id) {
    const ticket = this.store.get(id);
    const rounds = this.store.rounds(id);
    const parent = ticket?.parent_ticket_id ? this.store.get(ticket.parent_ticket_id) : null;
    const latestPr = rounds.at(-1)?.pr_number || parent?.pr_number;
    const pr = latestPr ? await this.git.prDetails?.(latestPr).catch(() => null) : null;
    if (!rounds.length && !parent) return '';
    return JSON.stringify({
      previousRounds:rounds.map(round => ({round:round.round,title:round.title,summary:trim(round.summary,800),criteria:JSON.parse(round.criteria || '[]'),pr:round.pr_number,status:round.status})),
      parent:parent && {id:parent.id,title:parent.title,summary:trim(parent.summary,800),status:parent.status,pr:parent.pr_number},
      latestPr:pr && {number:latestPr,title:pr.title,body:trim(pr.body,2000),files:(pr.files || []).slice(0,60)}
    });
  }
  async start() {
    this.store.recover();
    this.discord.onFeedback = id => this.receive(id);
    this.discord.onDecision = (id, text, author, channelId) => this.decision(id, text, author, channelId);
    if (!this.config.discordToken) return;
    await this.discord.start();
    if (this.store.getKv('thread-status-label-version') !== '1') {
      for (const ticket of this.store.list()) this.store.setKv(`thread-status-dirty:${ticket.id}`,'1');
      this.store.setKv('thread-status-label-version','1');
    }
    for (const ticket of this.store.byStatus(['intake'])) {
      this.store.setKv(`intake-retry-after:${ticket.id}`,Date.now() + 5 * 60_000);
      queueMicrotask(() => this.receive(ticket.id));
    }
    for (const ticket of this.store.byStatus(['merged','resolved_existing'])) {
      const completed = this.store.latestEvent(ticket.id,ticket.status === 'merged' ? 'merged' : 'existing');
      if (ticket.last_message_id && ticket.last_message_id !== ticket.answered_message_id && completed && SnowflakeUtil.timestampFrom(ticket.last_message_id) > completed.created_at) queueMicrotask(() => this.receive(ticket.id));
    }
    this.timer = setInterval(() => this.tick().catch(error => console.error('scheduler', error)), 15_000);
    await this.tick();
  }
  async stop() { clearInterval(this.timer); await this.discord.stop(); }
  async receive(id) {
    const ticket = this.store.get(id);
    if (!ticket) return;
    const status = ticket.status;
    if (status === 'waiting_info' && this.store.getKv(`awaiting-instruction-stage:${id}`) === 'release') return this.releaseInstruction(id);
    if (['merged','resolved_existing'].includes(status)) return this.followUp(id);
    if (status === 'declined') return this.appeal(id);
    if (status === 'decision') return this.threadDecision(id);
    if (status === 'failed') return this.resumeStopped(id);
    if (status === 'grouped') return this.groupedMessage(id);
    if (['queued','coding','pr_ready','integrating'].includes(status)) return this.duringWork(id);
    return this.feedback(id);
  }
  async duringWork(id) {
    const ticket = this.store.get(id);
    if (!this.acknowledge(id)) return;
    const text = await this.latestUserText(id);
    if (['queued','coding'].includes(ticket.status)) {
      this.addAddendum(id,ticket.last_message_id,text);
      this.event(id,'pm','addendum',trim(text || '追加の発言',300));
      await this.post(id, 'pm', `追加の内容を受け取りました。${ticket.status === 'coding' ? '実装中の作業に、PR を作る前に反映します。' : '実装を始めるときに一緒に渡します。'}`);
      return;
    }
    this.store.setKv(`pending-followup:${id}`,'1');
    this.event(id,'pm','followup_deferred',trim(text || '追加の発言',300));
    await this.post(id, 'pm', `PR #${ticket.pr_number} は ${this.config.baseBranch || 'develop'} へのマージ作業中です。マージが終わったらこの発言を確認して、続けて対応します。`);
  }
  async groupedMessage(id) {
    const ticket = this.store.get(id);
    const parent = ticket.parent_ticket_id ? this.store.get(ticket.parent_ticket_id) : null;
    if (!parent || !beforePrStatuses.includes(parent.status)) {
      this.store.update(id,{status:'intake'});
      this.event(id,'pm','reopened',`まとめ先「${parent?.title || '不明'}」の作業が進んでいるため、この案件として聞き取りを再開`);
      return this.feedback(id);
    }
    if (!this.acknowledge(id)) return;
    const text = await this.latestUserText(id);
    const url = await this.discord.url?.(id).catch(() => '') || id;
    this.addAddendum(parent.id,ticket.last_message_id,text && `${url} から: ${text}`);
    this.event(parent.id,'pm','addendum',trim(text || '追加の発言',300));
    await this.post(id, 'pm', `この声は「${parent.title}」にまとめています。追加の内容をまとめ先の作業に渡しました。`);
  }
  async resumeStopped(id) {
    if (this.active.has(id)) { this.pendingFeedback.add(id); return; }
    this.store.setKv(`awaiting-instruction:${id}`,'1');
    this.store.setKv(`awaiting-instruction-stage:${id}`,'code');
    this.store.update(id,{status:'waiting_info'});
    this.event(id,'pm','resumed_by_user','停止中の案件にスレ主から発言があったため、指示として聞き取る');
    return this.feedback(id);
  }
  async threadDecision(id) {
    const ticket = this.store.get(id);
    if (!this.acknowledge(id)) return;
    const author = this.store.getKv(`last-author:${id}`) || '';
    const text = await this.latestUserText(id);
    if (!this.restrictedDecision(id) || isDecisionUser(this.store,this.config,author)) return this.decision(id,text,author,id);
    const url = ticket.decision_thread_id ? await this.discord.url?.(ticket.decision_thread_id).catch(() => '') : '';
    await this.post(id, 'pm', `この判断は決定者に確認しています。回答が出たらこのスレッドでお知らせします。${url ? `\n判断用の投稿: ${url}` : ''}`);
  }
  async releaseInstruction(id) {
    if (this.active.has(id)) return;
    this.active.add(id);
    let role;
    try {
      const ticket = this.store.get(id);
      if (!ticket || ticket.status !== 'waiting_info') return;
      const answer = await this.discord.userMessage?.(id,ticket.last_message_id) || await this.discord.history(id);
      role = await this.acquireRole('PM',id);
      const decision = await this.ai.ask(role.name, `出荷検証が2回失敗して停止したPRについて、スレ主から回答がありました。保留・中止の指示なら retry=false。修正または再試行の指示なら retry=true とし、統合担当への具体的な指示を書いてください。返す JSON: {"retry":boolean,"instruction":"統合担当への指示","reason":"判断理由"}。\n\n案件: ${ticket.title}\nPR #${ticket.pr_number}\n失敗: ${ticket.error}\nスレ主の回答: ${answer}`, {provider:this.config.intakeProvider || 'codex',cwd:this.config.repo,repoReadOnly:true,timeoutMs:2*60_000,roleId:role.id});
      if (decision.retry !== true) {
        await this.post(id, role.id, `出荷を保留します。${trim(decision.reason || '再開する場合は、このスレッドで指示してください。',500)}`);
        return;
      }
      this.store.setKv(`release-instruction:${id}`,trim(decision.instruction || answer,1500));
      this.store.setKv(`release-failure-count:${id}`,0);
      this.store.setKv(`release-pm-repairs:${id}`,0);
      this.store.setKv(`awaiting-instruction:${id}`,'0');
      this.store.setKv(`awaiting-instruction-stage:${id}`,'');
      this.store.setKv(`release-retry-after:${id}`,0);
      this.store.update(id,{status:'pr_ready',error:null,answered_message_id:ticket.last_message_id});
      this.event(id,role.id,'pr_ready',`スレ主の指示を受け、PR #${ticket.pr_number} の修正と再検証を再開`);
      await this.post(id, role.id, `指示を受け取りました。PR #${ticket.pr_number} を修正・再検証します。`);
      await this.tick();
    } catch (error) {
      this.event(id,role?.id || 'pm','instruction_warning',trim(error.message,500));
      await this.post(id, role?.id || 'pm', `回答の処理に失敗しました。もう一度指示してください。${trim(error.message,300)}`).catch(() => {});
    } finally {
      if (role) this.releaseRole(role);
      this.active.delete(id);
    }
  }
  async feedback(id) {
    if (this.active.has(id)) { this.pendingFeedback.add(id); return; }
    this.active.add(id);
    let snapshot, intakeRole, imageBundle, parentImageBundle, phase = 'intake';
    try {
      const ticket = this.store.get(id);
      if (!ticket || !['intake','waiting_info','proposal'].includes(ticket.status)) return;
      intakeRole = await this.acquireRole('聞き取り',id);
      this.store.update(id,{status:'intake'});
      this.event(id,intakeRole.id,'intake_started','聞き取りを開始');
      const baseSha = ticket.base_sha || await this.git.baseHead();
      if (!ticket.base_sha) this.store.update(id, { base_sha:baseSha });
      const history = await this.discord.history(id);
      if (!history.trim()) return;
      snapshot = await this.git.snapshotWorktree(`intake-${id}-${Date.now()}`,baseSha);
      try { imageBundle = await this.discord.downloadImages?.(id); }
      catch (error) { this.event(id,intakeRole.id,'image_warning',trim(error.message,300)); }
      if (ticket.parent_ticket_id) {
        try { parentImageBundle = await this.discord.downloadImages?.(ticket.parent_ticket_id); }
        catch (error) { this.event(id,intakeRole.id,'image_warning',trim(error.message,300)); }
      }
      const similar = this.store.list().filter(row => row.id !== id && !doneStatuses.includes(row.status)).slice(0,50)
        .map(row => ({ id:row.id,title:row.title,summary:row.summary,status:row.status }));
      const context = await this.roundContext(id);
      const proposal = ticket.status === 'proposal' ? this.store.getKv(`proposal:${id}`) || '' : '';
      const addenda = this.addenda(id);
      const result = await this.ai.ask(intakeRole.name, `Discord の要望・不具合報告を聞き取る担当です。この作業コピーは発言時の ${this.config.baseBranch || 'develop'} (${baseSha}) です。依頼文の条件をそのまま案件にせず、依頼者が困っている場面と実現したいことを汲み取ります。
1. 既存案件に同じ声があれば duplicateOf にその正確な ID を入れます。
2. このリポジトリのコードと docs を読み、既存機能で解決できるなら alreadyExists=true、evidencePath に確認したリポジトリ相対ファイルパスを入れ、使い方を reply で伝えます。機能が存在しても報告が不具合なら完了扱いにしません。
3. 目的（誰が・どの場面で・何に困っているか）と期待結果が分かれば ready=true にします。条件だけ分かって目的が分からないとき、または再現条件が必要な不具合で情報が足りないときは、次に必要なことを一つだけ聞きます。質問には答えやすいように選択肢を付け（端末・ブラウザ・発生画面などの定型項目は特に）、分からなければ分からないと答えてよいことも伝えてください。不明な点を推測で埋めて ready にしないでください。既出の内容を繰り返して質問しないでください。
4. 前回までの対応・提案・追加の発言があれば、それを前提に今回の分を整理します。提案への返答なら、合意した内容を summary に入れて ready=true にします。
5. この時点で未確認の事項（質問したが答えがなかったもの、確認できなかった前提）は unknowns に入れます。後工程が同じ質問を繰り返さず、未確認の前提を自覚して進めるための引き継ぎです。未確認がなければ空配列にします。
返す JSON: {"ready": boolean, "reply": "ユーザーへの自然な日本語の短い返信または質問", "title": "短い件名", "purpose": "依頼者の目的", "summary": "背景と期待結果", "criteria": ["受け入れ条件"], "unknowns": ["未確認事項"], "duplicateOf": "既存案件IDまたは空文字", "alreadyExists": boolean, "evidencePath": "リポジトリ相対パスまたは空文字"}。

スレッド名: ${ticket.title}
${context ? `前回までの対応: ${context}\n` : ''}${proposal ? `PM の提案（返答待ち）: ${proposal}\n` : ''}${addenda.length ? `追加の発言: ${JSON.stringify(addenda)}\n` : ''}会話:
${history}

既存案件: ${JSON.stringify(similar)}`, { provider: this.config.intakeProvider, cwd: snapshot.path, repoReadOnly: true, roleId: intakeRole.id, images: [...(imageBundle?.paths || []),...(parentImageBundle?.paths || [])] });
      const purpose = trim(result.purpose,500);
      const update = { title: trim(result.title || ticket.title, 100), summary: trim(`${purpose ? `目的: ${purpose}\n` : ''}${result.summary || ''}`, 3000), criteria: JSON.stringify(asList(result.criteria)) };
      this.store.update(id, update);
      if (purpose) this.store.setKv(`purpose:${id}`,purpose);
      this.store.setKv(`unknowns:${id}`, JSON.stringify(asList(result.unknowns).slice(0, 10)));
      const duplicate = similar.find(row => row.id === String(result.duplicateOf));
      if (duplicate) {
        this.store.update(id, { status:'grouped', parent_ticket_id:duplicate.id });
        this.event(id,intakeRole.id,'grouped',`${duplicate.title} と同じ要望としてまとめました`);
        await this.post(id, intakeRole.id, trim(result.reply || `「${duplicate.title}」と同じ方向の声としてまとめました。追加の観点も開発担当へ渡します。`));
        return;
      }
      const evidence = String(result.evidencePath || '').replace(/\\/g,'/');
      const evidenceFile = resolve(snapshot.path,evidence);
      const insideRepo = evidence && !isAbsolute(evidence) && !relative(snapshot.path,evidenceFile).startsWith('..');
      if (result.alreadyExists && insideRepo && existsSync(evidenceFile)) {
        this.store.update(id, { status:'resolved_existing', answered_message_id:this.store.get(id).last_message_id });
        this.event(id,intakeRole.id,'existing',`既存機能で対応: ${evidence}`);
        await this.post(id, intakeRole.id, trim(result.reply || 'この機能はすでにあります。'));
        return;
      }
      if (!result.ready) {
        this.store.update(id, { status: 'waiting_info' });
        this.event(id, intakeRole.id, 'question', trim(result.reply || '追加情報を待っています'));
        await this.askUser(id, intakeRole.id, trim(result.reply || '詳しい状況を教えてください。'));
        return;
      }
      if (result.reply) await this.post(id, intakeRole.id, trim(result.reply));
      this.store.update(id, { status: 'planning' });
      if (ticket.status === 'waiting_info' && this.store.getKv(`awaiting-instruction:${id}`) === '1') {
        this.store.setKv(`awaiting-instruction:${id}`,'0');
        this.store.setKv(`failure-count:${id}`,0);
        this.store.setKv(`retry-count:${id}:code`,0);
        this.store.setKv(`retry-count:${id}:publish`,0);
        this.store.setKv(`failed-review-count:${id}`,0);
      }
      this.event(id, intakeRole.id, 'ready', '実装に必要な情報が揃いました');
      phase = 'planning';
      await this.plan(id, history, '', { cwd:snapshot.path, proposal });
    } catch (error) { await this.fail(id, phase === 'planning' ? 'pm' : intakeRole?.id || 'intake', error); }
    finally {
      if (imageBundle) await imageBundle.cleanup().catch(error => console.error('Could not clean up feedback images:',error));
      if (parentImageBundle) await parentImageBundle.cleanup().catch(error => console.error('Could not clean up parent feedback images:',error));
      if (snapshot) await this.git.removeWorktree(snapshot.path);
      if (intakeRole) this.releaseRole(intakeRole);
      this.active.delete(id);
      this.onChange();
      if (this.pendingFeedback.delete(id)) queueMicrotask(() => this.receive(id));
    }
  }
  async followUp(id) {
    if (this.active.has(id)) { this.pendingFeedback.add(id); return; }
    this.active.add(id);
    let snapshot, supportRole;
    try {
      const ticket = this.store.get(id);
      if (!ticket || !['merged','resolved_existing'].includes(ticket.status)) return;
      const messageId = ticket.last_message_id;
      if (!messageId || messageId === ticket.answered_message_id) return;
      const busy = roles.filter(role => role.job === '実装案内').every(role => this.roleBusy.has(role.id));
      if (busy) await this.post(id, 'support', `確認の順番待ちです。少しお待ちください。`).catch(() => {});
      supportRole = await this.acquireRole('実装案内',id);
      const question = await this.discord.userMessage(id,messageId);
      if (!question) return;
      const history = await this.discord.history(id);
      const baseSha = await this.git.baseHead();
      snapshot = await this.git.snapshotWorktree(`support-${id}-${Date.now()}`,baseSha);
      const pr = ticket.pr_number ? await this.git.prDetails(ticket.pr_number).catch(() => null) : null;
      const context = await this.roundContext(id);
      const result = await this.ai.ask(supportRole.name, `完了済みの Discord スレッドへの新しい発言を判断してください。現在の ${this.config.baseBranch || 'develop'} と関連 docs、PR 情報を読みます。実装の質問なら action="answer" として確認できたソースのパスを含む正確な説明を返します。新しい不具合・回帰・追加の改修依頼なら action="new_fix" とします。このスレッドで続けて対応するので、ここまでの会話と前回の対応を前提に、今回の依頼を title と summary にまとめます。再現手順など必要な情報が足りないなら action="clarify" として短く質問します。既に質問済みの内容を繰り返し聞かないでください。コード変更は不要です。返す JSON: {"action":"answer|new_fix|clarify","answer":"回答または確認質問","title":"今回の対応の短い件名","summary":"不具合や要望と期待結果の要約"}。\n\n今回の案件: ${JSON.stringify({title:ticket.title,summary:ticket.summary,pr:ticket.pr_number,round:ticket.round || 1})}\nPR情報: ${JSON.stringify(pr)}\n${context ? `前回までの対応: ${context}\n` : ''}最新の発言: ${JSON.stringify(question)}\n会話の文脈: ${history}`, {cwd:snapshot.path,repoReadOnly:true,roleId:supportRole.id});
      if (result.action === 'new_fix') {
        const previousPr = ticket.pr_number;
        this.startRound(id,messageId,result);
        await this.post(id, supportRole.id, `${previousPr ? `前回の対応（PR #${previousPr}）` : 'ここまでの内容'}を引き継いで、このスレッドで続けて対応します。`);
        if (!this.deferRounds) this.pendingFeedback.add(id);
        return;
      }
      const answer = trim(result.answer,4000);
      if (!answer) throw new Error('Implementation answer was empty');
      if (result.action === 'clarify') await this.askUser(id, supportRole.id, answer);
      else await this.post(id, supportRole.id, answer);
      this.store.update(id,{answered_message_id:messageId});
      this.event(id,supportRole.id,'answered',trim(question,300));
    } catch (error) {
      this.event(id,supportRole?.id || 'support','answer_failed',trim(error.message,500));
      await this.post(id, supportRole?.id || 'support', `実装内容の確認中に問題が起きました。少し後で再度質問してください。`).catch(() => {});
    } finally {
      if (snapshot) await this.git.removeWorktree(snapshot.path);
      if (supportRole) this.releaseRole(supportRole);
      this.active.delete(id);
      this.onChange();
      if (this.pendingFeedback.delete(id)) queueMicrotask(() => this.receive(id));
    }
  }
  startRound(id, messageId, result) {
    const ticket = this.store.get(id);
    const round = (ticket.round || 1) + 1;
    this.store.archiveRound(ticket);
    for (const key of roundKeys(id)) this.store.setKv(key,'');
    this.store.update(id,{status:'intake',round,title:trim(result.title || ticket.title,100),summary:trim(result.summary,3000),criteria:'[]',issue_number:null,pr_number:null,branch:null,worker:null,base_sha:null,merged_branch:null,error:null,decision_thread_id:null,answered_message_id:messageId});
    this.event(id,'support','round_started',`${ticket.pr_number ? `PR #${ticket.pr_number} の` : ''}対応を引き継いで ${round} 回目の対応を開始`);
  }
  async appeal(id) {
    if (this.active.has(id)) { this.pendingFeedback.add(id); return; }
    const ticket = this.store.get(id);
    const messageId = ticket?.last_message_id;
    if (!messageId || messageId === ticket.answered_message_id) return;
    this.active.add(id);
    let role;
    try {
      const text = await this.latestUserText(id);
      if (!text) return;
      role = await this.acquireRole('PM',id);
      const reason = this.store.getKv(`decline:${id}`) || '';
      const result = await this.ai.ask(role.name, `見送った案件のスレッドに新しい発言がありました。見送りへの異議・再検討の依頼なら action="appeal"、見送り理由を受けて別の形の依頼に変えたものなら action="revise"、了承やお礼など対応が要らないなら action="none" にします。返す JSON: {"action":"appeal|revise|none","reply":"ユーザーへの短い返信"}。\n\n案件: ${ticket.title}\n見送り理由: ${reason}\n新しい発言: ${JSON.stringify(text)}`, {provider:this.config.intakeProvider || 'codex',cwd:this.config.repo,repoReadOnly:true,timeoutMs:2*60_000,roleId:role.id});
      this.store.update(id,{answered_message_id:messageId});
      if (result.action === 'revise') {
        this.store.update(id,{status:'intake'});
        this.store.setKv(`decline:${id}`,'');
        this.event(id,role.id,'reopened','見送り後の発言を新しい形の依頼として聞き取り直す');
        this.pendingFeedback.add(id);
        return;
      }
      if (result.action === 'appeal') {
        if (!decisionUserIds(this.store,this.config).length) {
          await this.post(id, role.id, `見送りへの異議を判断する決定者が設定されていないため、受け付けられません。運用担当に連絡してください。`);
          return;
        }
        await this.askDecision(id,`見送った依頼に異議が出ました。実装を進めるか、見送りを維持するかを決めてください。\n見送り理由: ${trim(reason,800)}\n依頼者の発言: ${trim(text,800)}`,'appeal');
        return;
      }
      if (result.reply) await this.post(id, role.id, trim(result.reply,1000));
    } catch (error) {
      this.event(id,role?.id || 'pm','appeal_warning',trim(error.message,500));
      await this.post(id, role?.id || 'pm', `発言の確認中に問題が起きました。少し後でもう一度書いてください。`).catch(() => {});
    } finally {
      if (role) this.releaseRole(role);
      this.active.delete(id);
      this.onChange();
      if (this.pendingFeedback.delete(id)) queueMicrotask(() => this.receive(id));
    }
  }
  async pmReview(input, cwd, candidates = []) {
    const decided = input.decisionAnswer ? input.appeal
      ? '決定者が見送りへの異議に回答しました。決定者の回答に従ってください。実装を認める回答なら decline にしないでください。'
      : '人の判断への回答があります。その回答を前提に判断してください。' : '';
    return this.ai.ask(roleName('pm'), `次の声を開発案件として判断してください。作業コピーは受付時点の ${this.config.baseBranch || 'develop'} です。コードと docs を読み、既存の設計・開発方針・判断基準に照らして決めます。
- verdict="implement": 目的に合い、方針に沿うので実装する。implementationTask に依頼者の目的と、既存の仕組みのどこを広げて実現するかを書く。
- verdict="propose": 依頼の条件どおりより目的に合う作り方がある、または解釈が複数ある。proposal に推定した目的と具体的な案（3つまで、推奨を明記）を書き、依頼者の返答を待つ。規模が大きい・複数の仕組みにまたがる・既存の挙動を変える複雑な案件は、条件どおりに作る場合でも propose にし、proposal に計画（目的、やること／やらないこと、進め方、影響範囲、未確認事項とその扱い）を書いて依頼者の承認を待ちます。承認されるまで実装には進みません。
- verdict="decline": 判断基準の「断る」に当たる、または方針から大きく外れる。reason に理由、proposal に方針内の代案（あれば）を書く。
- verdict="decision": 製品として人が決めるべき判断が残る。decisionQuestion に問いと選択肢を書く。単なる実装上の選択は自分で決める。
似た既存案件があれば duplicateOf に正確な ID を入れる。${decided}${input.proposal ? '前回の提案への依頼者の返答が会話にあります。合意された案なら implement に、返答に合わせて案を直すなら propose にしてください。' : ''}
返す JSON: {"verdict":"implement|propose|decline|decision","duplicateOf":"既存IDまたは空文字","purpose":"推定した目的","reason":"判断理由","proposal":"提案または代案","decisionQuestion":"判断すべき内容と選択肢","title":"短い件名","summary":"背景と期待結果","criteria":["観測可能な受け入れ条件"],"implementationTask":"実装担当への具体的な指示"}。

現案件: ${JSON.stringify(input)}
既存案件: ${JSON.stringify(candidates)}`, {cwd,repoReadOnly:true,roleId:'pm'});
  }
  async plan(id, history, decisionAnswer = '', { cwd = '', proposal = '', appeal = false } = {}) {
    let snapshot;
    try {
      if (!cwd) {
        snapshot = await this.git.snapshotWorktree(`plan-${id}-${Date.now()}`,this.store.get(id)?.base_sha || await this.git.baseHead());
        cwd = snapshot.path;
      }
      await this.planIn(id,history,decisionAnswer,cwd,proposal,appeal);
    } finally { if (snapshot) await this.git.removeWorktree(snapshot.path); }
  }
  async planIn(id, history, decisionAnswer, cwd, proposal, appeal) {
    const ticket = this.store.get(id);
    const candidates = this.store.list().filter(row => row.id !== id && !doneStatuses.includes(row.status))
      .map(row => ({ id: row.id, title: row.title, summary: row.summary, status: row.status })).slice(0, 50);
    const context = await this.roundContext(id);
    const result = await this.pmReview({id,title:ticket.title,summary:ticket.summary,criteria:ticket.criteria,history,decisionAnswer,appeal,proposal,previous:context,addenda:this.addenda(id),unknowns:this.unknowns(id)},cwd,candidates);
    const duplicate = candidates.find(row => row.id === String(result.duplicateOf));
    if (duplicate) {
      this.store.update(id, { status: 'grouped', parent_ticket_id: duplicate.id, summary: trim(result.summary || ticket.summary, 3000) });
      this.event(id, 'pm', 'grouped', `${duplicate.title} に統合`);
      await this.post(id, 'pm', `この声は既存の「${duplicate.title}」にまとめました。追加の観点として開発担当へ渡します。`);
      return;
    }
    const verdict = verdicts.includes(result.verdict) ? result.verdict : result.needsDecision ? 'decision' : 'implement';
    const purpose = trim(result.purpose || this.store.getKv(`purpose:${id}`),500);
    const summary = trim(result.summary || ticket.summary, 3000);
    const criteria = asList(result.criteria).slice(0, 12);
    this.store.update(id, { title: trim(result.title || ticket.title, 100), summary, criteria: JSON.stringify(criteria) });
    if (purpose) this.store.setKv(`purpose:${id}`,purpose);
    this.event(id, 'pm', 'planned', trim(`${verdict}: ${result.reason || result.implementationTask || summary}`, 500));
    if (verdict === 'decline') {
      const reason = trim(result.reason || '開発方針から外れるため',1000);
      this.store.setKv(`decline:${id}`,reason);
      this.store.update(id,{status:'declined',answered_message_id:this.store.get(id).last_message_id});
      this.event(id,'pm','declined',reason);
      await this.askUser(id, 'pm', `この依頼は見送ります。${reason}${result.proposal ? `\n代わりの案: ${trim(result.proposal,1000)}` : ''}\n見送りに異議がある場合は、このスレッドに理由を書いてください。決定者が判断します。`,{to:'owner'});
      return;
    }
    if (verdict === 'propose') {
      const text = trim(result.proposal || result.reason,2000);
      this.store.setKv(`proposal:${id}`,text);
      this.store.update(id,{status:'proposal'});
      this.event(id,'pm','proposal',trim(text,500));
      await this.askUser(id, 'pm', `${text}\nこの方向で進めてよいか、別の案がよいかを、このスレッドで返信してください。`,{to:'owner'});
      return;
    }
    if (verdict === 'decision') {
      await this.askDecision(id, trim(result.decisionQuestion || 'この仕様をどう決めますか？'));
      return;
    }
    this.store.setKv(`proposal:${id}`,'');
    const leadRole = await this.acquireRole('開発リード',id);
    let lead;
    try { lead = await this.ai.ask(leadRole.name, `開発リードとして、PM の方針を実装担当への作業指示に落とします。作業コピーのコードを読み、関連する既存の仕組み、変更するファイル、壊しやすい既存機能を確認してください。受け入れ条件を満たすためだけの特別扱いやハードコードは指示しません。未確認事項（unknowns）がある場合は、その前提を作業指示に明示し、推測で決めずコード調査で確かめる順序にしてください。製品判断の不足があれば needsDecision=true。返す JSON: {"needsDecision": boolean, "decisionQuestion": "不足している判断", "task": "実装担当への明確な作業指示（目的、方針、変更箇所、確認方法）", "risk": "主な注意点"}。\n\n案件: ${JSON.stringify({title:result.title,purpose,summary,criteria,implementationTask:result.implementationTask,decisionAnswer,unknowns:this.unknowns(id)})}`, {cwd,repoReadOnly:true,roleId:leadRole.id});
    } finally { this.releaseRole(leadRole); }
    if (lead.needsDecision) {
      await this.askDecision(id, trim(lead.decisionQuestion || '開発方針を確認してください'));
      return;
    }
    this.store.update(id, { status: 'queued', error: null });
    this.store.setKv(`task:${id}`, trim(lead.task || result.implementationTask || summary, 12000));
    this.event(id, leadRole.id, 'queued', trim(lead.risk || '実装担当へ割り当て待ち', 500));
    await this.post(id, leadRole.id, `案件として受け付けました。${criteria.length ? `受け入れ条件: ${criteria.join(' / ')}` : ''}`);
    await this.tick();
  }
  restrictedDecision(id) {
    return restrictedKinds.includes(this.store.getKv(`decision-kind:${id}`)) && decisionUserIds(this.store,this.config).length > 0;
  }
  async askDecision(id, question, kind = 'decision') {
    this.store.setKv(`decision-kind:${id}`,kind);
    const ticket = this.store.update(id, { status: 'decision' });
    const decider = decisionUserIds(this.store,this.config)[0] || '';
    const fallback = decider || discordId(this.store.getKv(`last-author:${id}`)) || discordId(await this.discord.threadOwnerId?.(id).catch(() => null));
    const decisionThread = await this.discord.decision(ticket, question, {mentionUserId:fallback});
    this.store.update(id, { decision_thread_id: decisionThread || null });
    this.event(id, 'pm', 'decision', question);
    if (decisionThread) await this.post(id, 'pm', `${kind === 'appeal' ? '見送りへの異議を決定者に確認しています。' : '判断が必要な点をフォーラムにまとめました。'}回答後に続行します。`);
  }
  async decision(id, text, author, channelId = '') {
    if (this.active.has(id)) return;
    const ticket = this.store.get(id);
    if (ticket?.status !== 'decision') return;
    const appeal = this.store.getKv(`decision-kind:${id}`) === 'appeal';
    if (this.restrictedDecision(id) && !isDecisionUser(this.store,this.config,author)) {
      await this.post(channelId || ticket.decision_thread_id || id, 'pm', `この判断は決定者の回答で決めます。決定者の回答を待っています。`).catch(() => {});
      return;
    }
    this.active.add(id);
    try {
      this.store.update(id, { status: 'planning', decision_thread_id: null });
      this.store.setKv(`decision-kind:${id}`,'');
      this.event(id, 'pm', 'decision_answer', `${author}: ${trim(text, 300)}`);
      await this.plan(id, await this.discord.history(id), text, {appeal});
    } catch (error) { await this.fail(id, 'pm', error); }
    finally {
      this.active.delete(id);
      if (this.pendingFeedback.delete(id)) queueMicrotask(() => this.receive(id));
    }
  }
  async tick() {
    for (const ticket of this.store.list().filter(row => this.store.getKv(`thread-status-dirty:${row.id}`) === '1'
      && Date.now() >= Number(this.store.getKv(`thread-status-retry-after:${row.id}`) || 0)).slice(0,5)) {
      if (!this.threadStatusUpdates.has(ticket.id)) this.queueThreadStatus(ticket.id);
    }
    for (const ticket of this.store.byStatus(['merged']).filter(row => this.store.getKv(`pending-followup:${row.id}`) === '1' && !this.active.has(row.id))) {
      this.store.setKv(`pending-followup:${ticket.id}`,'');
      this.receive(ticket.id).catch(error => console.error('deferred follow-up', error));
    }
    for (const ticket of this.store.byStatus(['intake']).filter(row => !this.active.has(row.id) && Date.now() - row.updated_at > 60_000
      && Date.now() >= Number(this.store.getKv(`intake-retry-after:${row.id}`) || 0)).slice(0,3)) {
      this.store.setKv(`intake-retry-after:${ticket.id}`,Date.now() + 5 * 60_000);
      this.receive(ticket.id).catch(error => console.error('intake recovery', error));
    }
    const failed = this.store.byStatus(['failed']).find(row => !this.active.has(row.id)
      && Number(this.store.getKv(`failed-review-count:${row.id}`) || 0) < 3
      && Date.now() >= Number(this.store.getKv(`failed-review-after:${row.id}`) || 0));
    if (failed) {
      this.active.add(failed.id);
      this.reviewFailed(failed.id).finally(() => {
        this.active.delete(failed.id);
        this.onChange();
        if (this.pendingFeedback.delete(failed.id)) queueMicrotask(() => this.receive(failed.id));
      });
    }
    for (const worker of this.prioritizedRoles('実装').slice(0, this.config.maxWorkers)) {
      if (this.busyWorkers.has(worker.id)) continue;
      const ticket = this.store.byStatus(['queued']).find(row => !this.active.has(row.id));
      if (!ticket) continue;
      this.busyWorkers.add(worker.id);
      this.active.add(ticket.id);
      this.implement(ticket.id, worker).finally(() => { this.busyWorkers.delete(worker.id); this.active.delete(ticket.id); this.onChange(); });
    }
    const ready = this.store.byStatus(['pr_ready']);
    if (this.config.autoRelease && !this.releasing && ready.length && Date.now() - this.lastReleaseAttempt > 60_000 && Date.now() - Math.min(...ready.map(row => row.updated_at)) >= this.config.batchMs) {
      this.release().catch(error => console.error('release', error));
    }
  }
  taskText(id, ticket, previous, retryStage, retryInstruction) {
    const purpose = this.store.getKv(`purpose:${id}`);
    const linked = this.store.list().filter(row => row.parent_ticket_id === id && row.status === 'grouped').map(row => row.summary);
    const addenda = this.addenda(id);
    const unknowns = this.unknowns(id);
    return `${purpose ? `依頼者の目的: ${purpose}\n\n` : ''}${this.store.getKv(`task:${id}`) || ticket.summary}\n\n受け入れ条件:\n${JSON.parse(ticket.criteria).map(x => `- ${x}`).join('\n')}${unknowns.length ? `\n\n未確認事項（聞き取りで確認できなかった点。推測で決めず、まずコードや再現で確かめる。聞き取りで質問済みの内容をそのまま聞き直さない）:\n${unknowns.map(x => `- ${x}`).join('\n')}` : ''}${linked.length ? `\n\n追加の声:\n${linked.join('\n')}` : ''}${addenda.length ? `\n\nスレッドでの追加の発言（目的に照らして取り込み、矛盾するなら NEEDS_CLARIFICATION で質問）:\n${addenda.map(x => `- ${x}`).join('\n')}` : ''}${previous?.error && retryStage !== 'publish' ? `\n\n前回の失敗を修正してください:\n${trim(previous.error,1500)}` : ''}${retryInstruction && retryStage !== 'publish' ? `\n\nPM からの再作業指示:\n${retryInstruction}` : ''}`;
  }
  async designReview(id, ticket, task, path) {
    if (!this.git.reviewDiff) return null;
    let role;
    try {
      const diff = await this.git.reviewDiff(path);
      if (!diff.trim()) return null;
      role = await this.acquireRole('開発リード',id);
      return await this.ai.ask(role.name, `実装担当の差分を、案件の目的・開発方針・判断基準に照らして確認してください。受け入れ条件を満たすためだけの特別扱いやハードコード、既存の仕組みと重複する新しい仕組み、目的に関係ない変更、判断基準の「断る」に当たる変更、変更履歴（changelog/・shared/changelog.ts）の編集を探します。返す JSON: {"approve":boolean,"guardrailViolation":boolean,"issues":["実装担当が直すべき点"],"summary":"短い所見"}。\n\n案件: ${JSON.stringify({title:ticket.title,summary:ticket.summary,criteria:JSON.parse(ticket.criteria || '[]')})}\n作業指示:\n${trim(task,6000)}\n\n差分:\n${diff}`, {guide:'review',cwd:path,repoReadOnly:true,timeoutMs:5*60_000,roleId:role.id});
    } catch (error) {
      this.event(id,role?.id || 'lead','review_warning',trim(error.message,300));
      return null;
    } finally { if (role) this.releaseRole(role); }
  }
  prBody(ticket, issue, baseSha, changes, threadUrl, reviewNote = '') {
    const criteria = JSON.parse(ticket.criteria || '[]').map(x => `- ${x}`).join('\n');
    return `## 利用者向けの変更\n\n${(changes.length ? changes : ['（実装担当の報告なし。差分から確認してください）']).map(x => `- ${x}`).join('\n')}\n\n## 背景と目的\n\n${ticket.summary}\n${criteria ? `\n受け入れ条件:\n${criteria}\n` : ''}\nDiscord thread: ${threadUrl || ticket.id}\n\n## 確認したこと\n\nnpm ci, npm run typecheck, npm run build, npm run test:client, npm run test:sync（Tonarium Agent が実行）\nFeedback base: ${baseSha}${reviewNote ? `\n\n設計レビューの指摘（実装担当が修正済み、再レビューなし）:\n${reviewNote}` : ''}${issue ? `\n\nCloses #${issue}` : ''}`;
  }
  async implement(id, worker) {
    let worktree, completed = false, stage = 'code';
    try {
      const previous = this.store.get(id);
      const retryStage = this.store.getKv(`retry-stage:${id}`);
      const retryInstruction = this.store.getKv(`retry-instruction:${id}`);
      const ticket = this.store.update(id, { status: 'coding', worker: worker.id, error: null });
      this.event(id, worker.id, 'coding', '専用 worktree で実装を開始');
      await this.git.prepare();
      const baseSha = ticket.base_sha || await this.git.baseHead();
      if (!ticket.base_sha) this.store.update(id, { base_sha:baseSha });
      const threadUrl = await this.discord.url?.(id).catch(() => '') || '';
      const issue = ticket.issue_number || await this.git.issue(ticket.title, `Discord feedback: ${threadUrl}\nBase ${this.config.baseBranch || 'develop'}: ${baseSha}\n\n${ticket.summary}\n\nAcceptance criteria:\n${JSON.parse(ticket.criteria).map(x => `- ${x}`).join('\n')}`).catch(error => { this.event(id,'pm','issue_warning',error.message); return null; });
      if (issue) this.store.update(id, { issue_number: issue });
      worktree = await this.git.resumeTaskWorktree(id) || await this.git.worktree(`task-${id}-${Date.now()}`,baseSha);
      if (worktree.resumed) this.event(id,worker.id,'resumed',`前回の作業ツリーから実装を再開: ${worktree.branch}`);
      const task = this.taskText(id,ticket,previous,retryStage,retryInstruction);
      let reviewNote = '';
      if (retryStage === 'publish') {
        stage = 'publish';
        this.event(id,'pm','retry',`実装とテスト済みの ${worktree.branch} を再送します`);
        await this.git.pushWithRetry(worktree.path,worktree.branch,(attempt,error) => this.event(id,'pm','push_retry',`GitHub push 再試行 ${attempt}: ${trim(error.message,300)}`));
      } else {
        let used = this.addenda(id).length;
        let report = await this.ai.code(worker.name, `${worktree.resumed ? '前回の未完了の差分が作業ツリーにあります。最初に git status と差分を読み、既存の変更を引き継いで完成させてください。\n\n' : ''}${task}`, worktree.path, { roleId: worker.id });
        for (let pass = 0; pass < 2 && !/NEEDS_CLARIFICATION/i.test(report) && this.addenda(id).length > used; pass++) {
          const added = this.addenda(id).slice(used);
          used += added.length;
          this.event(id,worker.id,'addendum_applied',`実装中に届いた発言 ${added.length} 件を反映`);
          report = await this.ai.code(worker.name, `実装中にスレッドで次の発言が届きました。作業ツリーの差分を引き継ぎ、目的に照らして取り込んでください。矛盾する場合は NEEDS_CLARIFICATION で質問してください。\n\n${added.map(x => `- ${x}`).join('\n')}\n\n元の依頼:\n${task}`, worktree.path, { roleId: worker.id });
        }
        if (/NEEDS_CLARIFICATION/i.test(report)) {
          this.store.update(id, { status: 'waiting_info', worker: null });
          this.event(id, worker.id, 'question', trim(report, 500));
          await this.askUser(id, worker.id, `追加確認が必要です。${trim(report, 1200)}`);
          return;
        }
        const review = await this.designReview(id,ticket,task,worktree.path);
        if (review?.guardrailViolation) {
          this.store.update(id,{worker:null});
          this.event(id,'lead','review_blocked',trim(review.summary || asList(review.issues).join(' / '),500));
          await this.askDecision(id,`設計レビューで、判断基準に当たる変更が見つかりました。進め方を決めてください。\n${trim(asList(review.issues).join('\n') || review.summary,1500)}`,'guardrail');
          return;
        }
        if (review && review.approve !== true && asList(review.issues).length) {
          this.event(id,'lead','review_changes',trim(asList(review.issues).join(' / '),500));
          report = await this.ai.code(worker.name, `開発リードの設計レビューで次の指摘がありました。作業ツリーの差分を引き継いで直してください。\n\n${asList(review.issues).map(x => `- ${x}`).join('\n')}\n\n元の依頼:\n${task}`, worktree.path, { roleId: worker.id });
          reviewNote = asList(review.issues).map(x => `- ${x}`).join('\n');
        }
        this.store.setKv(`user-changes:${id}`,JSON.stringify(userFacingChanges(report)));
        const restored = await this.git.restoreChangelog?.(worktree.path,baseSha) || [];
        if (restored.length) this.event(id,worker.id,'changelog_restored',`変更履歴は main 反映時に作るため取り消し: ${trim(restored.join(', '),300)}`);
        await this.git.test(worktree.path);
        stage = 'publish';
        await this.git.commitPush(worktree.path, worktree.branch, `feat(agent): ${ticket.title}`.slice(0, 100), (attempt,error) => this.event(id,'pm','push_retry',`GitHub push 再試行 ${attempt}: ${trim(error.message,300)}`));
      }
      let changes = [];
      try { changes = asList(JSON.parse(this.store.getKv(`user-changes:${id}`) || '[]')); } catch { /* fall back to the summary */ }
      const pr = await this.git.findPr(worktree.branch) || await this.git.pr(ticket.title, this.prBody(this.store.get(id),issue,baseSha,changes,threadUrl,reviewNote), worktree.branch);
      if (!pr) throw new Error(`Could not find or create PR for ${worktree.branch}`);
      this.store.update(id, { status: 'pr_ready', pr_number: pr, branch: worktree.branch, worker: null });
      this.store.setKv(`retry-stage:${id}`,'');
      this.store.setKv(`retry-instruction:${id}`,'');
      this.event(id, worker.id, 'pr_ready', `PR #${pr} を検証済み。出荷待ち`);
      completed = true;
      await this.post(id, worker.id, `変更とテストが完了しました。PR #${pr} を出荷待ちに入れました。`).catch(error => this.event(id,worker.id,'discord_warning',trim(error.message,300)));
    } catch (error) {
      const retryStage = stage === 'publish' && /^git (?:add|commit|status)\b/.test(error.message) ? 'code' : stage;
      const priorFailures = Math.max(Number(this.store.getKv(`failure-count:${id}`) || 0),Number(this.store.getKv(`retry-count:${id}:code`) || 0),Number(this.store.getKv(`retry-count:${id}:publish`) || 0));
      const failures = priorFailures + 1;
      this.store.setKv(`failure-count:${id}`,failures);
      if (failures >= 2) {
        await this.askUserAfterFailures(id,error);
        return;
      }
      let scheduled = false;
      if (worktree) {
        try { scheduled = await this.pmRetry(id,error,retryStage,worktree); }
        catch (reviewError) { this.event(id,'pm','retry_review_warning',trim(reviewError.message,300)); }
      }
      if (!scheduled) await this.fail(id, worker.id, error);
    }
    finally { if (completed && worktree) await this.git.removeWorktree(worktree.path); }
  }
  async pmRetry(id, error, stage, worktree) {
    const key = `retry-count:${id}:${stage}`;
    const attempt = Number(this.store.getKv(key) || 0);
    if (attempt >= (stage === 'publish' ? 3 : 2)) return false;
    const role = await this.acquireRole('PM',id);
    let decision;
    try {
      decision = await this.ai.ask(role.name, `実装案件で失敗が起きました。作業ツリーの状態とエラーを確認し、同じ作業を再試行する価値があるか判断してください。GitHub への一時的な push 失敗なら再試行を選びます。コードやテストの失敗なら、修正の具体的な指示を付けます。認証・権限など人の操作が必要なら停止します。返す JSON: {"retry":boolean,"reason":"判断理由","instruction":"実装担当への修正指示"}。\n\n案件: ${this.store.get(id)?.title}\n段階: ${stage}\n失敗: ${trim(error.message,1500)}`, {provider:this.config.intakeProvider || 'codex',cwd:worktree.path,repoReadOnly:true,timeoutMs:2*60_000,roleId:role.id});
    } catch (reviewError) {
      this.event(id,role.id,'retry_review_warning',trim(reviewError.message,300));
      decision = {retry:stage === 'publish',reason:'GitHub への送信を再試行します',instruction:''};
    } finally { this.releaseRole(role); }
    if (decision.retry !== true) return false;
    this.store.setKv(key,attempt + 1);
    this.store.setKv(`retry-stage:${id}`,stage);
    this.store.setKv(`retry-instruction:${id}`,trim(decision.instruction,1000));
    this.store.update(id,{status:'queued',branch:worktree.branch,worker:null,error:trim(error.message,2000)});
    this.event(id,'pm','retry_scheduled',`${stage === 'publish' ? 'GitHub への送信' : '実装・検証'}を再試行 (${attempt + 1}回目): ${trim(decision.reason,300)}`);
    await this.post(id, role.id, `${stage === 'publish' ? 'GitHub への送信' : '実装・検証'}で問題が起きたため、作業ツリーを残して再試行します。${trim(decision.reason,300)}`).catch(() => {});
    return true;
  }
  async reviewFailed(id) {
    const ticket = this.store.get(id);
    if (!ticket || ticket.status !== 'failed') return;
    const failures = Math.max(Number(this.store.getKv(`failure-count:${id}`) || 0),Number(this.store.getKv(`retry-count:${id}:code`) || 0),Number(this.store.getKv(`retry-count:${id}:publish`) || 0));
    if (failures >= 2) {
      await this.askUserAfterFailures(id,new Error(ticket.error || '実装に失敗しました'));
      return;
    }
    const countKey = `failed-review-count:${id}`;
    const count = Number(this.store.getKv(countKey) || 0) + 1;
    this.store.setKv(countKey,count);
    this.store.setKv(`failed-review-after:${id}`,Date.now() + 60_000);
    let role;
    try {
      role = await this.acquireRole('PM',id);
      const worktree = await this.git.resumeTaskWorktree(id).catch(() => null);
      const decision = await this.ai.ask(role.name, `停止した開発案件を確認してください。残っている作業ツリーの差分とエラーを読み、再試行で修復できるなら retry=true にして具体的な修正指示を書いてください。新しい ${this.config.baseBranch || 'develop'} が進んだことによる履歴や競合の失敗なら、元の変更を保持したまま統合するよう指示します。認証や製品判断など人の対応が必要なら retry=false にしてください。返す JSON: {"retry":boolean,"reason":"判断理由","instruction":"実装担当への修正指示"}。\n\n案件: ${ticket.title}\n失敗: ${trim(ticket.error,1500)}\n再検討: ${count}/3`, {provider:this.config.intakeProvider || 'codex',cwd:worktree?.path || this.config.repo,repoReadOnly:true,timeoutMs:2*60_000,roleId:role.id});
      if (decision.retry !== true) {
        this.store.setKv(countKey,3);
        this.event(id,role.id,'needs_attention',trim(decision.reason || '人の確認が必要です',500));
        await this.askUser(id, role.id, `再試行を止めました。${trim(decision.reason || '人の確認が必要です',500)}\n次の方針をこのスレッドに書いてもらえれば、作業ツリーを引き継いで再開します。`,{to:'owner'}).catch(() => {});
        return;
      }
      this.store.setKv(`retry-stage:${id}`,'code');
      this.store.setKv(`retry-instruction:${id}`,trim(decision.instruction,1000));
      this.store.update(id,{status:'queued',worker:null});
      this.event(id,role.id,'retry_scheduled',`停止案件を再開 (${count}/3): ${trim(decision.reason,500)}`);
      await this.post(id, role.id, `作業ツリーを引き継いで再試行します。${trim(decision.reason,400)}`).catch(() => {});
    } catch (error) {
      this.event(id,role?.id || 'pm','retry_review_warning',trim(error.message,500));
    } finally {
      if (role) this.releaseRole(role);
    }
  }
  async askUserAfterFailures(id,error,stage = 'code') {
    const message = trim(error?.message || error,2000);
    this.store.setKv(`awaiting-instruction:${id}`,'1');
    this.store.setKv(`awaiting-instruction-stage:${id}`,stage);
    this.store.setKv(`failed-review-count:${id}`,3);
    let role, question = stage === 'release'
      ? `PR #${this.store.get(id)?.pr_number} のWebチェックがPMによる修正後も失敗したため、出荷を止めました。修正して再開するか、保留するかを指示してください。`
      : '同じ案件で2回失敗しました。作業ツリーは保存しています。続けるために、次に試す修正方針か、いったん保留にするかを指示してください。';
    this.store.update(id,{status:'waiting_info',worker:null,error:message,answered_message_id:this.store.get(id)?.last_message_id});
    try {
      role = await this.acquireRole('PM',id);
      const worktree = stage === 'release' ? null : await this.git.resumeTaskWorktree(id).catch(() => null);
      const prompt = stage === 'release'
        ? `同じPRの出荷検証がPMによる修正後も失敗しました。自動再試行を止めました。CIエラーとPRの状態から、スレ主に修正・再開か保留かを選んでもらう具体的な質問を一つ作ってください。技術的な原因を短く説明します。返す JSON: {"question":"ユーザーへの質問"}。\n\n案件: ${this.store.get(id)?.title}\nPR #${this.store.get(id)?.pr_number}\n失敗: ${message}`
        : `同じ案件が2回失敗しました。自動再試行は止めます。残っている作業ツリーと失敗内容を調べ、ユーザーが次の方針を指示できる具体的な質問を一つ作ってください。技術的な原因は短く説明し、実装の詳細が分からない人にも選べる案を添えます。返す JSON: {"question":"ユーザーへの質問"}。\n\n案件: ${this.store.get(id)?.title}\n失敗: ${message}`;
      const result = await this.ai.ask(role.name,prompt,{provider:this.config.intakeProvider || 'codex',cwd:worktree?.path || this.config.repo,repoReadOnly:true,timeoutMs:2*60_000,roleId:role.id});
      question = trim(result.question || question,1000);
    } catch (reviewError) {
      this.event(id,role?.id || 'pm','retry_review_warning',trim(reviewError.message,500));
    } finally {
      if (role) this.releaseRole(role);
    }
    this.event(id,'pm','needs_instruction',question);
    const ownerId = await this.discord.threadOwnerId?.(id).catch(() => null);
    await this.post(id, 'pm', question,{mentionUserId:ownerId}).catch(error => this.event(id,'pm','discord_warning',trim(error.message,300)));
  }
  async pmReviewReleaseFailure(ticket,error,worktreePath = '') {
    const id = ticket.id;
    const repairs = Number(this.store.getKv(`release-pm-repairs:${id}`) || 0);
    if (repairs >= 2) return this.askUserAfterFailures(id,error,'release');
    let role;
    try {
      role = await this.acquireRole('PM',id);
      const details = await this.git.failedCheckDetails?.(ticket.pr_number).catch(() => '') || '';
      const decision = await this.ai.ask(role.name, `出荷段階で同じPRが2回以上失敗しています。CIログとエラーと作業ツリーのコードを調べ、統合担当が修正できるなら retry=true とし、具体的な修正指示を書いてください。変更なしの再実行だけは指示しないでください。製品判断や認証など人の判断が必要なら retry=false にしてください。返す JSON: {"retry":boolean,"instruction":"統合担当への修正指示","reason":"判断理由"}。\n\n案件: ${ticket.title}\nPR #${ticket.pr_number}\nエラー: ${trim(error.message,2000)}\nCIログ: ${trim(details,10000)}\nPMによる修正指示: ${repairs}/2`, {provider:this.config.intakeProvider || 'codex',cwd:worktreePath || this.config.repo,repoReadOnly:true,timeoutMs:2*60_000,roleId:role.id});
      if (decision.retry === true && String(decision.instruction || '').trim()) {
        this.store.setKv(`release-pm-repairs:${id}`,repairs + 1);
        this.store.setKv(`release-instruction:${id}`,trim(decision.instruction,1500));
        this.store.update(id,{status:'pr_ready',error:trim(error.message,2000)});
        this.store.setKv(`release-retry-after:${id}`,Date.now() + 30_000);
        this.event(id,role.id,'release_retry',`PMがCI失敗を調査し、統合担当に修正を指示 (${repairs + 1}/2): ${trim(decision.reason,300)}`);
        await this.post(id, role.id, `PR #${ticket.pr_number} の失敗を確認しました。統合担当に修正と再検証を指示します。${trim(decision.reason,400)}`).catch(() => {});
        return;
      }
    } catch (reviewError) {
      this.event(id,role?.id || 'pm','retry_review_warning',trim(reviewError.message,500));
    } finally {
      if (role) this.releaseRole(role);
    }
    await this.askUserAfterFailures(id,error,'release');
  }
  async release(force = false) {
    if (this.releasing) return false;
    const ready = this.store.byStatus(['pr_ready']).filter(row => row.branch && row.pr_number && Date.now() >= Number(this.store.getKv(`release-retry-after:${row.id}`) || 0)).sort((a,b) => a.updated_at - b.updated_at || a.created_at - b.created_at || a.id.localeCompare(b.id));
    if (!ready.length) return false;
    if (!force && Date.now() - Math.min(...ready.map(row => row.updated_at)) < this.config.batchMs) return false;
    this.releasing = true;
    this.lastReleaseAttempt = Date.now();
    const releaseId = this.store.release('integrating', ready.map(row => row.id));
    let merged = 0, failedTickets = 0;
    let finalSha = '';
    try {
      let notes = '';
      try {
        const review = await this.ai.ask(roleName('release'), `出荷担当として、出荷待ちの PR の依存関係と注意点を確認してください。各 PR は個別に検証し、通るものを順にマージします。返す JSON: {"notes":"短いマージ説明"}。\n\n候補: ${JSON.stringify(ready.map(x => ({id:x.id,title:x.title,summary:x.summary,pr:x.pr_number})))}`, { roleId: 'release' });
        notes = trim(review.notes,300);
      } catch (error) { this.event(null,'release','selection_warning',`出荷前レビュー失敗。PR の個別検証を続行: ${trim(error.message,300)}`); }
      this.store.updateRelease(releaseId, { tickets: JSON.stringify(ready.map(x => x.id)) });
      this.event(null,'release','batch',`${ready.length} 件の PR を個別に確認: ${notes}`);
      for (const ticket of ready) {
        let worktree;
        try {
          const before = await this.git.prInfo(ticket.pr_number);
          if (before.state === 'MERGED') {
            await this.markMerged(ticket,before.mergeCommit?.oid || await this.git.baseHead(),before.baseRefName || this.config.baseBranch);
            merged++;
            continue;
          }
          if (before.baseRefName && before.baseRefName !== this.config.baseBranch) {
            await this.git.retargetPr(ticket.pr_number);
            this.event(ticket.id,'release','retargeted',`PR #${ticket.pr_number} の宛先を ${this.config.baseBranch} に変更`);
          }
          this.store.update(ticket.id, { status: 'integrating' });
          this.event(ticket.id,'integrator','integrating',`PR #${ticket.pr_number} を最新 ${this.config.baseBranch || 'develop'} と統合中`);
          const integratedMain = await this.git.baseHead();
          await this.git.git(['fetch','origin',ticket.branch]);
          worktree = await this.git.worktree(`release-${releaseId}-${ticket.id}-${Date.now()}`,`origin/${ticket.branch}`);
          try { await this.git.mergeMainInto(worktree.path); }
          catch (mergeError) {
            const conflicts = (await this.git.git(['diff','--name-only','--diff-filter=U'],worktree.path)).stdout;
            if (!conflicts) throw mergeError;
            this.event(ticket.id,'integrator','conflict',`競合解決中: ${trim(conflicts, 300)}`);
            const report = await this.ai.code(roleName('integrator'), `現在 Git merge 中の競合を解決してください。競合マーカーを除去し、両方の変更を満たしてください。git add/commit/push は行わないでください。対象: ${ticket.title}。`, worktree.path, { provider: this.config.integrationProvider, reportChanges:false ,roleId:'integrator'});
            await this.git.git(['add','-A'],worktree.path);
            await this.git.git(['commit','--no-edit'],worktree.path);
            this.event(ticket.id,'integrator','resolved',trim(report,300));
          }
          const restored = await this.git.restoreChangelog?.(worktree.path,integratedMain) || [];
          if (restored.length) {
            await this.git.git(['add','-A'],worktree.path);
            await this.git.git(['commit','-m','chore: leave changelog to the main release'],worktree.path);
            this.event(ticket.id,'integrator','changelog_restored',`変更履歴は main 反映時に作るため取り消し: ${trim(restored.join(', '),300)}`);
          }
          await this.testAndRepairIntegration(ticket,worktree.path);
          const head = await this.git.pushBranch(worktree.path,ticket.branch);
          this.event(ticket.id,'integrator','verified',`最新 ${this.config.baseBranch || 'develop'} と統合した状態でテスト完了: ${head.slice(0,8)}`);
          const checks = await this.git.waitForChecks(ticket.pr_number,head);
          this.event(ticket.id,'release','checks',`PR #${ticket.pr_number}: ${checks} 件の GitHub チェックを確認`);
          if (await this.git.baseHead() !== integratedMain) throw new Error(`${this.config.baseBranch || 'develop'} changed during PR checks; retry integration against the latest commit`);
          const mergeSha = await this.git.mergePr(ticket.pr_number,head);
          finalSha = mergeSha || await this.git.baseHead();
          await this.markMerged(ticket,finalSha);
          merged++;
        } catch (error) {
          failedTickets++;
          const key = `release-failure-count:${ticket.id}`;
          const stored = this.store.getKv(key);
          const earlier = stored === undefined
            ? this.store.events(5000).filter(row => row.ticket_id === ticket.id && row.kind === 'release_retry').length
            : Number(stored) || 0;
          const failures = Math.min(1,earlier) + 1;
          this.store.setKv(key,failures);
          if (failures >= 2) {
            await this.pmReviewReleaseFailure(ticket,error,worktree?.path);
          } else {
            this.store.update(ticket.id,{status:'pr_ready',error:trim(error.message,2000)});
            this.store.setKv(`release-retry-after:${ticket.id}`,Date.now() + 90_000);
            this.event(ticket.id,'release','release_retry',`この PR は90秒後に再試行します。ほかの PR を先に処理します: ${trim(error.message,500)}`);
          }
        } finally {
          if (worktree) await this.git.removeWorktree(worktree.path);
        }
      }
      finalSha = await this.git.baseHead();
      this.store.updateRelease(releaseId, { status: failedTickets ? merged ? 'partial' : 'failed' : 'merged', commit_sha:finalSha, url:`https://github.com/${this.config.githubRepo}/tree/${this.config.baseBranch || 'develop'}` });
      this.lastReleaseAttempt = 0;
      return merged > 0;
    } catch (error) {
      this.store.updateRelease(releaseId, { status: merged ? 'partial' : 'failed', commit_sha:finalSha || null, error: trim(error.message, 2000) });
      for (const ticket of ready) if (this.store.get(ticket.id)?.status === 'integrating') this.store.update(ticket.id, { status: 'pr_ready' });
      this.event(null,'release','failed',error.message);
      return false;
    } finally {
      this.releasing = false;
      this.onChange();
    }
  }
  async testAndRepairIntegration(ticket,path) {
    let repaired = false;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await this.git.test(path);
        if (repaired) {
          await this.git.git(['add','-A'],path);
          await this.git.git(['commit','-m',`fix: integrate ${ticket.title}`.slice(0,100)],path);
        }
        return;
      } catch (error) {
        if (attempt === 2) throw error;
        this.event(ticket.id,'pm','repair_requested',`統合後の検証失敗を修正 (${attempt + 1}/2): ${trim(error.message,400)}`);
        const instruction = this.store.getKv(`release-instruction:${ticket.id}`);
        const report = await this.ai.code(roleName('integrator'), `最新 ${this.config.baseBranch || 'develop'} と PR の統合後、検証に失敗しました。現在の作業ツリーの差分を保持し、次のエラーを修正してください。git add/commit/push は行わないでください。案件: ${ticket.title}。${instruction ? `スレ主の指示: ${trim(instruction,1500)}。` : ''}エラー: ${trim(error.message,1500)}`, path, {provider:this.config.integrationProvider,reportChanges:false,timeoutMs:15*60_000,roleId:'integrator'});
        const status = await this.git.git(['status','--porcelain'],path);
        if (!status.stdout) throw new Error('Integrator made no changes to repair the failed check');
        this.event(ticket.id,'integrator','repair_applied',trim(report,300));
        repaired = true;
      }
    }
  }
  async markMerged(ticket,sha,branch = this.config.baseBranch || 'develop') {
    this.store.setKv(`release-instruction:${ticket.id}`,'');
    this.store.setKv(`release-failure-count:${ticket.id}`,0);
    this.store.setKv(`release-pm-repairs:${ticket.id}`,0);
    const current = this.store.get(ticket.id);
    // マージ作業中に届いた発言は、マージ後に完了後の質問として拾うため既読にしない
    const deferred = this.store.getKv(`pending-followup:${ticket.id}`) === '1';
    this.store.update(ticket.id, { status:'merged', merged_branch:branch, error:null, answered_message_id:deferred ? current.answered_message_id : current.last_message_id });
    this.event(ticket.id,'release','merged',`PR #${ticket.pr_number} を ${branch} へマージ: ${sha?.slice(0,8) || ''}`);
    await this.threadStatusUpdates.get(ticket.id);
    if (ticket.issue_number) await this.git.closeIssue(ticket.issue_number, `PR #${ticket.pr_number} merged into ${branch}`).catch(error => this.event(ticket.id,'release','issue_warning',error.message));
    await this.post(ticket.id, 'release', `PR #${ticket.pr_number} のチェックを確認し、${branch} にマージしました。${sha ? `\nマージ commit: ${sha.slice(0,8)}` : ''}`).catch(error => this.event(ticket.id,'release','discord_warning',error.message));
  }
  async fail(id, actor, error) {
    const message = trim(error?.message || error, 2000);
    this.store.update(id, { status: 'failed', error: message, worker: null });
    this.event(id, actor, 'failed', message);
    await this.post(id, actor, `処理を止めました。PMが原因を確認し、再試行を判断します。${trim(message, 500)}`).catch(() => {});
  }
}
