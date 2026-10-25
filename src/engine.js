import { roles } from './config.js';
import { existsSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { SnowflakeUtil } from 'discord.js';

const roleName = id => roles.find(role => role.id === id)?.name || id;
const asList = value => Array.isArray(value) ? value.map(String).filter(Boolean) : [];
const trim = (value, length = 1500) => String(value || '').slice(0, length);
const statusEmoji = { question:'❓', decision:'❓', ready:'📝', queued:'⏳', coding:'🛠️', retry_scheduled:'🔄', release_retry:'🔄', pr_ready:'🧪', integrating:'🔀', merged:'✅', existing:'✅', grouped:'🔗', failed:'⚠️', needs_instruction:'🙋' };

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
  }
  event(id, actor, kind, text) {
    this.store.event(id, roleName(actor), kind, text);
    this.onChange();
    if (id && statusEmoji[kind]) this.discord.setThreadStatus?.(id,statusEmoji[kind]).catch(error => console.error('Could not update Discord thread status:',error));
  }
  async acquireRole(job, ticketId) {
    const candidates = roles.filter(role => role.job === job);
    if (!candidates.length) throw new Error(`No ${job} agent is configured`);
    const free = candidates.find(role => !this.roleBusy.has(role.id));
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
    const next = this.roleWaiters.get(role.job)?.shift();
    if (next) {
      this.roleBusy.set(role.id,next.ticketId);
      next.resolve(role);
    } else this.roleBusy.delete(role.id);
    this.onChange();
  }
  async start() {
    this.store.recover();
    this.discord.onFeedback = id => this.receive(id);
    this.discord.onDecision = (id, text, author) => this.decision(id, text, author);
    if (!this.config.discordToken) return;
    await this.discord.start();
    for (const ticket of this.store.list().filter(row => row.status === 'intake')) queueMicrotask(() => this.receive(ticket.id));
    for (const ticket of this.store.list().filter(row => ['merged','resolved_existing'].includes(row.status))) {
      const completed = this.store.latestEvent(ticket.id,ticket.status === 'merged' ? 'merged' : 'existing');
      if (ticket.last_message_id && ticket.last_message_id !== ticket.answered_message_id && completed && SnowflakeUtil.timestampFrom(ticket.last_message_id) > completed.created_at) queueMicrotask(() => this.receive(ticket.id));
    }
    this.timer = setInterval(() => this.tick().catch(error => console.error('scheduler', error)), 15_000);
    await this.tick();
  }
  async stop() { clearInterval(this.timer); await this.discord.stop(); }
  async receive(id) {
    const status = this.store.get(id)?.status;
    return ['merged','resolved_existing'].includes(status) ? this.followUp(id) : this.feedback(id);
  }
  async feedback(id) {
    if (this.active.has(id)) { this.pendingFeedback.add(id); return; }
    this.active.add(id);
    let snapshot, intakeRole, imageBundle, parentImageBundle, phase = 'intake';
    try {
      const ticket = this.store.get(id);
      if (!ticket || !['intake','waiting_info','decision'].includes(ticket.status)) return;
      if (ticket.status === 'decision' && ticket.decision_thread_id) return;
      intakeRole = await this.acquireRole('聞き取り',id);
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
      const similar = this.store.list().filter(row => row.id !== id && !['grouped','failed','merged','resolved_existing'].includes(row.status)).slice(0,50)
        .map(row => ({ id:row.id,title:row.title,summary:row.summary,status:row.status }));
      const result = await this.ai.ask(intakeRole.name, `Discord のフィードバックを聞き取る担当です。この作業コピーは発言時の ${this.config.baseBranch || 'main'} (${baseSha}) です。まず既存案件の似た声を探し、このリポジトリのコードと docs を読み、すでに実装済みの機能か調べてください。似た案件があれば duplicateOf にその正確な ID を入れます。既存機能で解決できるなら alreadyExists=true、evidencePath に確認したリポジトリ相対ファイルパスを入れ、使い方を reply で伝えます。機能が存在しても報告が不具合なら完了扱いにしません。元案件への追加のバグ報告なら、その不具合を新しい修正案件として扱ってください。断定できない場合は質問します。返す JSON: {"ready": boolean, "reply": "ユーザーへの自然な日本語の短い返信または質問", "title": "短い件名", "summary": "要約", "criteria": ["受け入れ条件"], "duplicateOf": "既存案件IDまたは空文字", "alreadyExists": boolean, "evidencePath": "リポジトリ相対パスまたは空文字"}。既出内容を繰り返して質問しないでください。\n\nスレッド名: ${ticket.title}\n元案件: ${ticket.parent_ticket_id || 'なし'}\n${history}\n\n既存案件: ${JSON.stringify(similar)}`, { provider: this.config.intakeProvider, cwd: snapshot.path, repoReadOnly: true, images: [...(imageBundle?.paths || []),...(parentImageBundle?.paths || [])] });
      const update = { title: trim(result.title || ticket.title, 100), summary: trim(result.summary, 3000), criteria: JSON.stringify(asList(result.criteria)) };
      this.store.update(id, update);
      const duplicate = similar.find(row => row.id === String(result.duplicateOf));
      if (duplicate) {
        this.store.update(id, { status:'grouped', parent_ticket_id:duplicate.id });
        this.event(id,intakeRole.id,'grouped',`${duplicate.title} と同じ要望としてまとめました`);
        await this.discord.say(id, `**${intakeRole.name}｜聞き取り**\n${trim(result.reply || `「${duplicate.title}」と同じ方向の声としてまとめました。追加の観点も開発担当へ渡します。`)}`);
        return;
      }
      const evidence = String(result.evidencePath || '').replace(/\\/g,'/');
      const evidenceFile = resolve(snapshot.path,evidence);
      const insideRepo = evidence && !isAbsolute(evidence) && !relative(snapshot.path,evidenceFile).startsWith('..');
      if (result.alreadyExists && insideRepo && existsSync(evidenceFile)) {
        this.store.update(id, { status:'resolved_existing', answered_message_id:this.store.get(id).last_message_id });
        this.event(id,intakeRole.id,'existing',`既存機能で対応: ${evidence}`);
        await this.discord.say(id, `**${intakeRole.name}｜聞き取り**\n${trim(result.reply || 'この機能はすでにあります。')}`);
        return;
      }
      if (result.reply) await this.discord.say(id, `**${intakeRole.name}｜聞き取り**\n${trim(result.reply)}`);
      if (!result.ready) {
        this.store.update(id, { status: 'waiting_info' });
        this.event(id, intakeRole.id, 'question', trim(result.reply || '追加情報を待っています'));
        return;
      }
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
      await this.plan(id, history);
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
      supportRole = await this.acquireRole('実装案内',id);
      const question = await this.discord.userMessage(id,messageId);
      if (!question) return;
      const history = await this.discord.history(id);
      const mainSha = await this.git.baseHead();
      snapshot = await this.git.snapshotWorktree(`support-${id}-${Date.now()}`,mainSha);
      const pr = ticket.pr_number ? await this.git.prDetails(ticket.pr_number).catch(() => null) : null;
      const result = await this.ai.ask(supportRole.name, `完了済みの Discord スレッドへの新しい発言を判断してください。現在の main と関連 docs、PR 情報を読みます。実装の質問なら action="answer" として確認できたソースのパスを含む正確な説明を返します。新しい不具合・回帰・修正依頼なら action="new_fix" とし、元案件とは別の修正案件にします。再現手順など必要な情報が足りないなら action="clarify" として元スレッドで短く質問します。既に質問済みの内容を繰り返し聞かないでください。コード変更は不要です。返す JSON: {"action":"answer|new_fix|clarify","answer":"回答または確認質問","title":"新規修正の短い件名","summary":"不具合と期待結果の要約"}。\n\n元案件: ${JSON.stringify({title:ticket.title,summary:ticket.summary,pr:ticket.pr_number})}\nPR情報: ${JSON.stringify(pr)}\n最新の発言: ${JSON.stringify(question)}\n会話の文脈: ${history}`, {cwd:snapshot.path,repoReadOnly:true});
      if (result.action === 'new_fix') {
        const key = `followup:${id}:${messageId}`;
        let childId = this.store.getKv(key);
        let childUrl = childId ? await this.discord.url(childId) : '';
        if (!childId) {
          const child = await this.discord.createFollowUp(ticket,question,trim(result.title || `${ticket.title}の不具合`,90));
          childId = child.id;
          childUrl = child.url;
          this.store.setKv(key,childId);
        }
        this.store.create(childId,trim(result.title || `${ticket.title}の不具合`,100));
        this.store.update(childId,{parent_ticket_id:id,summary:trim(result.summary || question,3000),base_sha:mainSha});
        await this.discord.say(id, `**${supportRole.name}｜実装案内**\n新しい修正案件として受け付けました: ${childUrl}`);
        this.store.update(id,{answered_message_id:messageId});
        this.event(id,supportRole.id,'followup_created',`修正案件 ${childId} を作成`);
        await this.receive(childId);
        return;
      }
      const answer = trim(result.answer,4000);
      if (!answer) throw new Error('Implementation answer was empty');
      await this.discord.say(id, `**${supportRole.name}｜実装案内**\n${answer}`);
      this.store.update(id,{answered_message_id:messageId});
      this.event(id,supportRole.id,'answered',trim(question,300));
    } catch (error) {
      this.event(id,supportRole?.id || 'support','answer_failed',trim(error.message,500));
      await this.discord.say(id, `**${supportRole?.name || roleName('support')}｜実装案内**\n実装内容の確認中に問題が起きました。少し後で再度質問してください。`).catch(() => {});
    } finally {
      if (snapshot) await this.git.removeWorktree(snapshot.path);
      if (supportRole) this.releaseRole(supportRole);
      this.active.delete(id);
      this.onChange();
      if (this.pendingFeedback.delete(id)) queueMicrotask(() => this.receive(id));
    }
  }
  async plan(id, history, decisionAnswer = '') {
    const ticket = this.store.get(id);
    const candidates = this.store.list().filter(row => row.id !== id && !['grouped','failed','merged','resolved_existing'].includes(row.status))
      .map(row => ({ id: row.id, title: row.title, summary: row.summary, status: row.status })).slice(0, 50);
    const result = await this.ai.ask(roleName('pm'), `次の声を開発案件に整理してください。似た既存案件があれば duplicateOf に正確な ID を入れてください。人の製品判断が必要なら needsDecision=true として、問いを明確にしてください。単なる実装上の選択は自分で判断してください。返す JSON: {"duplicateOf": "既存IDまたは空文字", "needsDecision": boolean, "decisionQuestion": "判断すべき内容と選択肢", "title": "短い件名", "summary": "背景と期待結果", "criteria": ["観測可能な受け入れ条件"], "implementationTask": "実装担当への具体的な指示"}。\n\n現案件: ${JSON.stringify({id,title:ticket.title,summary:ticket.summary,criteria:ticket.criteria,history,decisionAnswer})}\n既存案件: ${JSON.stringify(candidates)}`);
    const duplicate = candidates.find(row => row.id === String(result.duplicateOf));
    if (duplicate) {
      this.store.update(id, { status: 'grouped', parent_ticket_id: duplicate.id, summary: trim(result.summary || ticket.summary, 3000) });
      this.event(id, 'pm', 'grouped', `${duplicate.title} に統合`);
      await this.discord.say(id, `**${roleName('pm')}｜PM**\nこの声は既存の「${duplicate.title}」にまとめました。追加の観点として開発担当へ渡します。`);
      return;
    }
    const summary = trim(result.summary || ticket.summary, 3000);
    const criteria = asList(result.criteria).slice(0, 12);
    this.store.update(id, { title: trim(result.title || ticket.title, 100), summary, criteria: JSON.stringify(criteria) });
    this.event(id, 'pm', 'planned', trim(result.implementationTask || summary, 500));
    if (result.needsDecision) {
      await this.askDecision(id, trim(result.decisionQuestion || 'この仕様をどう決めますか？'));
      return;
    }
    const leadRole = await this.acquireRole('開発リード',id);
    let lead;
    try { lead = await this.ai.ask(leadRole.name, `開発リードとして作業範囲と受け入れ条件を確認してください。製品判断の不足があれば needsDecision=true。返す JSON: {"needsDecision": boolean, "decisionQuestion": "不足している判断", "task": "実装担当への明確な作業指示", "risk": "主な注意点"}。\n\n案件: ${JSON.stringify({title:result.title,summary,criteria,implementationTask:result.implementationTask,decisionAnswer})}`);
    } finally { this.releaseRole(leadRole); }
    if (lead.needsDecision) {
      await this.askDecision(id, trim(lead.decisionQuestion || '開発方針を確認してください'));
      return;
    }
    this.store.update(id, { status: 'queued', error: null });
    this.store.setKv(`task:${id}`, trim(lead.task || result.implementationTask || summary, 12000));
    this.event(id, leadRole.id, 'queued', trim(lead.risk || '実装担当へ割り当て待ち', 500));
    await this.discord.say(id, `**${leadRole.name}｜開発リード**\n案件として受け付けました。${criteria.length ? `受け入れ条件: ${criteria.join(' / ')}` : ''}`);
    await this.tick();
  }
  async askDecision(id, question) {
    const ticket = this.store.update(id, { status: 'decision' });
    const decisionThread = await this.discord.decision(ticket, question);
    this.store.update(id, { decision_thread_id: decisionThread || null });
    this.event(id, 'pm', 'decision', question);
    if (decisionThread) await this.discord.say(id, `**${roleName('pm')}｜PM**\n判断が必要な点をフォーラムにまとめました。回答後に続行します。`);
  }
  async decision(id, text, author) {
    if (this.active.has(id)) return;
    this.active.add(id);
    try {
      const ticket = this.store.get(id);
      if (ticket?.status !== 'decision') return;
      this.store.update(id, { status: 'planning', decision_thread_id: null });
      this.event(id, 'pm', 'decision_answer', `${author}: ${trim(text, 300)}`);
      await this.plan(id, await this.discord.history(id), text);
    } catch (error) { await this.fail(id, 'pm', error); }
    finally { this.active.delete(id); }
  }
  async tick() {
    const failed = this.store.list().reverse().find(row => row.status === 'failed' && !this.active.has(row.id)
      && Number(this.store.getKv(`failed-review-count:${row.id}`) || 0) < 3
      && Date.now() >= Number(this.store.getKv(`failed-review-after:${row.id}`) || 0));
    if (failed) {
      this.active.add(failed.id);
      this.reviewFailed(failed.id).finally(() => { this.active.delete(failed.id); this.onChange(); });
    }
    for (const worker of roles.filter(role => role.job === '実装').slice(0, this.config.maxWorkers)) {
      if (this.busyWorkers.has(worker.id)) continue;
      const ticket = this.store.list().reverse().find(row => row.status === 'queued' && !this.active.has(row.id));
      if (!ticket) continue;
      this.busyWorkers.add(worker.id);
      this.active.add(ticket.id);
      this.implement(ticket.id, worker).finally(() => { this.busyWorkers.delete(worker.id); this.active.delete(ticket.id); this.onChange(); });
    }
    const ready = this.store.list().filter(row => row.status === 'pr_ready');
    if (this.config.autoRelease && !this.releasing && ready.length && Date.now() - this.lastReleaseAttempt > 60_000 && Date.now() - Math.min(...ready.map(row => row.updated_at)) >= this.config.batchMs) {
      this.release().catch(error => console.error('release', error));
    }
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
      const issue = ticket.issue_number || await this.git.issue(ticket.title, `Discord feedback: ${await this.discord.url(id)}\nBase ${this.config.baseBranch || 'main'}: ${baseSha}\n\n${ticket.summary}\n\nAcceptance criteria:\n${JSON.parse(ticket.criteria).map(x => `- ${x}`).join('\n')}`).catch(error => { this.event(id,'pm','issue_warning',error.message); return null; });
      if (issue) this.store.update(id, { issue_number: issue });
      worktree = await this.git.resumeTaskWorktree(id) || await this.git.worktree(`task-${id}-${Date.now()}`,baseSha);
      if (worktree.resumed) this.event(id,worker.id,'resumed',`前回の作業ツリーから実装を再開: ${worktree.branch}`);
      const linked = this.store.list().filter(row => row.parent_ticket_id === id).map(row => row.summary);
      const task = `${this.store.getKv(`task:${id}`) || ticket.summary}\n\n受け入れ条件:\n${JSON.parse(ticket.criteria).map(x => `- ${x}`).join('\n')}\n\n追加の声:\n${linked.join('\n')}${previous?.error && retryStage !== 'publish' ? `\n\n前回の失敗を修正してください:\n${trim(previous.error,1500)}` : ''}${retryInstruction && retryStage !== 'publish' ? `\n\nPM からの再作業指示:\n${retryInstruction}` : ''}`;
      if (retryStage === 'publish') {
        stage = 'publish';
        this.event(id,'pm','retry',`実装とテスト済みの ${worktree.branch} を再送します`);
        await this.git.pushWithRetry(worktree.path,worktree.branch,(attempt,error) => this.event(id,'pm','push_retry',`GitHub push 再試行 ${attempt}: ${trim(error.message,300)}`));
      } else {
        const report = await this.ai.code(worker.name, `${worktree.resumed ? '前回の未完了の差分が作業ツリーにあります。最初に git status と差分を読み、既存の変更を引き継いで完成させてください。\n\n' : ''}${task}`, worktree.path);
        if (/NEEDS_CLARIFICATION/i.test(report)) {
          this.store.update(id, { status: 'waiting_info', worker: null });
          await this.discord.say(id, `**${worker.name}｜実装**\n追加確認が必要です。${trim(report, 1200)}`);
          this.event(id, worker.id, 'question', trim(report, 500));
          return;
        }
        await this.git.test(worktree.path);
        stage = 'publish';
        await this.git.commitPush(worktree.path, worktree.branch, `feat(agent): ${ticket.title}`.slice(0, 100), (attempt,error) => this.event(id,'pm','push_retry',`GitHub push 再試行 ${attempt}: ${trim(error.message,300)}`));
      }
      const pr = await this.git.findPr(worktree.branch) || await this.git.pr(ticket.title, `${issue ? `Closes #${issue}\n\n` : ''}${ticket.summary}\n\nFeedback base: ${baseSha}\nChecks: npm run typecheck, npm run build, npm run test:client, npm run test:sync\n\nDiscord thread: ${id}`, worktree.branch);
      if (!pr) throw new Error(`Could not find or create PR for ${worktree.branch}`);
      this.store.update(id, { status: 'pr_ready', pr_number: pr, branch: worktree.branch, worker: null });
      this.store.setKv(`retry-stage:${id}`,'');
      this.store.setKv(`retry-instruction:${id}`,'');
      this.event(id, worker.id, 'pr_ready', `PR #${pr} を検証済み。出荷待ち`);
      completed = true;
      await this.discord.say(id, `**${worker.name}｜実装**\n変更とテストが完了しました。PR #${pr} を出荷待ちに入れました。`).catch(error => this.event(id,worker.id,'discord_warning',trim(error.message,300)));
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
      decision = await this.ai.ask(role.name, `実装案件で失敗が起きました。作業ツリーの状態とエラーを確認し、同じ作業を再試行する価値があるか判断してください。GitHub への一時的な push 失敗なら再試行を選びます。コードやテストの失敗なら、修正の具体的な指示を付けます。認証・権限など人の操作が必要なら停止します。返す JSON: {"retry":boolean,"reason":"判断理由","instruction":"実装担当への修正指示"}。\n\n案件: ${this.store.get(id)?.title}\n段階: ${stage}\n失敗: ${trim(error.message,1500)}`, {provider:this.config.intakeProvider || 'codex',cwd:worktree.path,repoReadOnly:true,timeoutMs:2*60_000});
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
    await this.discord.say(id, `**${role.name}｜PM**\n${stage === 'publish' ? 'GitHub への送信' : '実装・検証'}で問題が起きたため、作業ツリーを残して再試行します。${trim(decision.reason,300)}`).catch(() => {});
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
      const decision = await this.ai.ask(role.name, `停止した開発案件を確認してください。残っている作業ツリーの差分とエラーを読み、再試行で修復できるなら retry=true にして具体的な修正指示を書いてください。新しい main が進んだことによる履歴や競合の失敗なら、元の変更を保持したまま統合するよう指示します。認証や製品判断など人の対応が必要なら retry=false にしてください。返す JSON: {"retry":boolean,"reason":"判断理由","instruction":"実装担当への修正指示"}。\n\n案件: ${ticket.title}\n失敗: ${trim(ticket.error,1500)}\n再検討: ${count}/3`, {provider:this.config.intakeProvider || 'codex',cwd:worktree?.path || this.config.repo,repoReadOnly:true,timeoutMs:2*60_000});
      if (decision.retry !== true) {
        this.store.setKv(countKey,3);
        this.event(id,role.id,'needs_attention',trim(decision.reason || '人の確認が必要です',500));
        await this.discord.say(id, `**${role.name}｜PM**\n再試行を止めました。${trim(decision.reason || '人の確認が必要です',500)}`).catch(() => {});
        return;
      }
      this.store.setKv(`retry-stage:${id}`,'code');
      this.store.setKv(`retry-instruction:${id}`,trim(decision.instruction,1000));
      this.store.update(id,{status:'queued',worker:null});
      this.event(id,role.id,'retry_scheduled',`停止案件を再開 (${count}/3): ${trim(decision.reason,500)}`);
      await this.discord.say(id, `**${role.name}｜PM**\n作業ツリーを引き継いで再試行します。${trim(decision.reason,400)}`).catch(() => {});
    } catch (error) {
      this.event(id,role?.id || 'pm','retry_review_warning',trim(error.message,500));
    } finally {
      if (role) this.releaseRole(role);
    }
  }
  async askUserAfterFailures(id,error) {
    const message = trim(error?.message || error,2000);
    this.store.setKv(`awaiting-instruction:${id}`,'1');
    this.store.setKv(`failed-review-count:${id}`,3);
    let role, question = '同じ案件で2回失敗しました。作業ツリーは保存しています。続けるために、次に試す修正方針か、いったん保留にするかを指示してください。';
    try {
      role = await this.acquireRole('PM',id);
      const worktree = await this.git.resumeTaskWorktree(id).catch(() => null);
      const result = await this.ai.ask(role.name, `同じ案件が2回失敗しました。自動再試行は止めます。残っている作業ツリーと失敗内容を調べ、ユーザーが次の方針を指示できる具体的な質問を一つ作ってください。技術的な原因は短く説明し、実装の詳細が分からない人にも選べる案を添えます。返す JSON: {"question":"ユーザーへの質問"}。\n\n案件: ${this.store.get(id)?.title}\n失敗: ${message}`, {provider:this.config.intakeProvider || 'codex',cwd:worktree?.path || this.config.repo,repoReadOnly:true,timeoutMs:2*60_000});
      question = trim(result.question || question,1000);
    } catch (reviewError) {
      this.event(id,role?.id || 'pm','retry_review_warning',trim(reviewError.message,500));
    } finally {
      if (role) this.releaseRole(role);
    }
    this.store.update(id,{status:'waiting_info',worker:null,error:message});
    this.event(id,'pm','needs_instruction',question);
    const ownerId = await this.discord.threadOwnerId?.(id).catch(() => null);
    await this.discord.say(id,`**${roleName('pm')}｜PM 🙋**\n${question}`,{mentionUserId:ownerId}).catch(error => this.event(id,'pm','discord_warning',trim(error.message,300)));
  }
  async release(force = false) {
    if (this.releasing) return false;
    const ready = this.store.list().filter(row => row.status === 'pr_ready' && row.branch && row.pr_number && Date.now() >= Number(this.store.getKv(`release-retry-after:${row.id}`) || 0)).sort((a,b) => a.updated_at - b.updated_at || a.created_at - b.created_at || a.id.localeCompare(b.id));
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
        const review = await this.ai.ask(roleName('release'), `出荷担当として、出荷待ちの PR の依存関係と注意点を確認してください。各 PR は個別に検証し、通るものを順にマージします。返す JSON: {"notes":"短いマージ説明"}。\n\n候補: ${JSON.stringify(ready.map(x => ({id:x.id,title:x.title,summary:x.summary,pr:x.pr_number})))}`);
        notes = trim(review.notes,300);
      } catch (error) { this.event(null,'release','selection_warning',`出荷前レビュー失敗。PR の個別検証を続行: ${trim(error.message,300)}`); }
      this.store.updateRelease(releaseId, { tickets: JSON.stringify(ready.map(x => x.id)) });
      this.event(null,'release','batch',`${ready.length} 件の PR を個別に確認: ${notes}`);
      for (const ticket of ready) {
        let worktree;
        try {
          const before = await this.git.prInfo(ticket.pr_number);
          if (before.state === 'MERGED') {
            await this.markMerged(ticket,before.mergeCommit?.oid || await this.git.baseHead());
            merged++;
            continue;
          }
          this.store.update(ticket.id, { status: 'integrating' });
          this.event(ticket.id,'integrator','integrating',`PR #${ticket.pr_number} を最新 main と統合中`);
          const integratedMain = await this.git.baseHead();
          await this.git.git(['fetch','origin',ticket.branch]);
          worktree = await this.git.worktree(`release-${releaseId}-${ticket.id}-${Date.now()}`,`origin/${ticket.branch}`);
          try { await this.git.mergeMainInto(worktree.path); }
          catch (mergeError) {
            const conflicts = (await this.git.git(['diff','--name-only','--diff-filter=U'],worktree.path)).stdout;
            if (!conflicts) throw mergeError;
            this.event(ticket.id,'integrator','conflict',`競合解決中: ${trim(conflicts, 300)}`);
            const report = await this.ai.code(roleName('integrator'), `現在 Git merge 中の競合を解決してください。競合マーカーを除去し、両方の変更を満たしてください。git add/commit/push は行わないでください。対象: ${ticket.title}。`, worktree.path, { provider: this.config.integrationProvider, requireChangelog:false });
            await this.git.git(['add','-A'],worktree.path);
            await this.git.git(['commit','--no-edit'],worktree.path);
            this.event(ticket.id,'integrator','resolved',trim(report,300));
          }
          if (await this.git.changelogCheck?.(worktree.path,integratedMain) === 'missing') {
            this.event(ticket.id,'pm','changelog_missing','変更履歴がないため統合担当へ追記を指示');
            const report = await this.ai.code(roleName('integrator'), `この PR の変更だけを確認し、shared/changelog.ts の先頭に新しい日付・見出し・本文の項目を1件追加してください。変更対象は shared/changelog.ts だけです。案件: ${ticket.title}。概要: ${ticket.summary}`, worktree.path, {provider:this.config.integrationProvider,timeoutMs:5*60_000});
            const dirty = (await this.git.git(['status','--porcelain'],worktree.path)).stdout.split('\n').filter(Boolean);
            if (!dirty.length || dirty.some(line => line.slice(3) !== 'shared/changelog.ts')) throw new Error('Changelog repair changed unexpected files or no files');
            if (await this.git.changelogCheck(worktree.path,integratedMain) !== 'ok') throw new Error('Changelog repair did not add a valid entry');
            await this.git.git(['add','shared/changelog.ts'],worktree.path);
            await this.git.git(['commit','-m',`docs: record ${ticket.title}`.slice(0,100)],worktree.path);
            this.event(ticket.id,'integrator','changelog_fixed',trim(report,300));
          }
          await this.testAndRepairIntegration(ticket,worktree.path);
          const head = await this.git.pushBranch(worktree.path,ticket.branch);
          this.event(ticket.id,'integrator','verified',`最新 ${this.config.baseBranch || 'main'} と統合した状態でテスト完了: ${head.slice(0,8)}`);
          const checks = await this.git.waitForChecks(ticket.pr_number,head);
          this.event(ticket.id,'release','checks',`PR #${ticket.pr_number}: ${checks} 件の GitHub チェックを確認`);
          if (await this.git.baseHead() !== integratedMain) throw new Error(`${this.config.baseBranch || 'main'} changed during PR checks; retry integration against the latest commit`);
          const mergeSha = await this.git.mergePr(ticket.pr_number,head);
          finalSha = mergeSha || await this.git.baseHead();
          await this.markMerged(ticket,finalSha);
          merged++;
        } catch (error) {
          failedTickets++;
          this.store.update(ticket.id,{status:'pr_ready',error:trim(error.message,2000)});
          this.store.setKv(`release-retry-after:${ticket.id}`,Date.now() + 90_000);
          this.event(ticket.id,'release','release_retry',`この PR は90秒後に再試行します。ほかの PR を先に処理します: ${trim(error.message,500)}`);
        } finally {
          if (worktree) await this.git.removeWorktree(worktree.path);
        }
      }
      finalSha = await this.git.baseHead();
      this.store.updateRelease(releaseId, { status: failedTickets ? merged ? 'partial' : 'failed' : 'merged', commit_sha:finalSha, url:`https://github.com/${this.config.githubRepo}/tree/${this.config.baseBranch || 'main'}` });
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
        const report = await this.ai.code(roleName('integrator'), `最新 main と PR の統合後、検証に失敗しました。現在の作業ツリーの差分を保持し、次のエラーを修正してください。git add/commit/push は行わないでください。案件: ${ticket.title}。エラー: ${trim(error.message,1500)}`, path, {provider:this.config.integrationProvider,requireChangelog:false,timeoutMs:15*60_000});
        const status = await this.git.git(['status','--porcelain'],path);
        if (!status.stdout) throw new Error('Integrator made no changes to repair the failed check');
        this.event(ticket.id,'integrator','repair_applied',trim(report,300));
        repaired = true;
      }
    }
  }
  async markMerged(ticket,sha) {
    this.store.update(ticket.id, { status:'merged', answered_message_id:this.store.get(ticket.id).last_message_id });
    this.event(ticket.id,'release','merged',`PR #${ticket.pr_number} を ${this.config.baseBranch || 'main'} へマージ: ${sha?.slice(0,8) || ''}`);
    if (ticket.issue_number) await this.git.closeIssue(ticket.issue_number, `PR #${ticket.pr_number} merged into ${this.config.baseBranch || 'main'}`).catch(error => this.event(ticket.id,'release','issue_warning',error.message));
    await this.discord.say(ticket.id, `**${roleName('release')}｜出荷**\nPR #${ticket.pr_number} のチェックを確認し、${this.config.baseBranch || 'main'} にマージしました。${sha ? `\nマージ commit: ${sha.slice(0,8)}` : ''}`).catch(error => this.event(ticket.id,'release','discord_warning',error.message));
  }
  async fail(id, actor, error) {
    const message = trim(error?.message || error, 2000);
    this.store.update(id, { status: 'failed', error: message, worker: null });
    this.event(id, actor, 'failed', message);
    await this.discord.say(id, `**${roleName(actor)}**\n処理を止めました。PMが原因を確認し、再試行を判断します。${trim(message, 500)}`).catch(() => {});
  }
}
