import { roles } from './config.js';
import { existsSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { SnowflakeUtil } from 'discord.js';

const roleName = id => roles.find(role => role.id === id)?.name || id;
const asList = value => Array.isArray(value) ? value.map(String).filter(Boolean) : [];
const trim = (value, length = 1500) => String(value || '').slice(0, length);

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
    let snapshot, intakeRole, imageBundle;
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
      const similar = this.store.list().filter(row => row.id !== id && !['grouped','failed','merged','resolved_existing'].includes(row.status)).slice(0,50)
        .map(row => ({ id:row.id,title:row.title,summary:row.summary,status:row.status }));
      const result = await this.ai.ask(intakeRole.name, `Discord のフィードバックを聞き取る担当です。この作業コピーは発言時の ${this.config.baseBranch || 'main'} (${baseSha}) です。まず既存案件の似た声を探し、このリポジトリのコードと docs を読み、すでに実装済みの機能か調べてください。似た案件があれば duplicateOf にその正確な ID を入れます。既存機能で解決できるなら alreadyExists=true、evidencePath に確認したリポジトリ相対ファイルパスを入れ、使い方を reply で伝えます。機能が存在しても報告が不具合なら完了扱いにしません。断定できない場合は質問します。返す JSON: {"ready": boolean, "reply": "ユーザーへの自然な日本語の短い返信または質問", "title": "短い件名", "summary": "要約", "criteria": ["受け入れ条件"], "duplicateOf": "既存案件IDまたは空文字", "alreadyExists": boolean, "evidencePath": "リポジトリ相対パスまたは空文字"}。既出内容を繰り返して質問しないでください。\n\nスレッド名: ${ticket.title}\n${history}\n\n既存案件: ${JSON.stringify(similar)}`, { provider: this.config.intakeProvider, cwd: snapshot.path, repoReadOnly: true, images: imageBundle?.paths || [] });
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
      this.event(id, intakeRole.id, 'ready', '実装に必要な情報が揃いました');
      await this.plan(id, history);
    } catch (error) { await this.fail(id, intakeRole?.id || 'intake', error); }
    finally {
      if (imageBundle) await imageBundle.cleanup().catch(error => console.error('Could not clean up feedback images:',error));
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
      const result = await this.ai.ask(supportRole.name, `完了済みの Discord スレッドで、ユーザーが実装について質問しました。作業コピーの現在の main と関連 docs を読み、PR 情報も参考にして、実装の仕組みと数値・間隔を正確に説明してください。推測で断定せず、確認できたソースのパスを回答に含めてください。コード変更や新しいタスク化は不要です。最新の質問と、同時に送られた続きの発言をまとめて答えてください。返す JSON: {"answer":"日本語での分かりやすい回答"}。\n\n案件: ${JSON.stringify({title:ticket.title,summary:ticket.summary,pr:ticket.pr_number})}\nPR情報: ${JSON.stringify(pr)}\n最新の質問: ${JSON.stringify(question)}\n会話の文脈: ${history}`, {cwd:snapshot.path,repoReadOnly:true});
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
    let worktree;
    try {
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
      const task = `${this.store.getKv(`task:${id}`) || ticket.summary}\n\n受け入れ条件:\n${JSON.parse(ticket.criteria).map(x => `- ${x}`).join('\n')}\n\n追加の声:\n${linked.join('\n')}`;
      const report = await this.ai.code(worker.name, `${worktree.resumed ? '前回の未完了の差分が作業ツリーにあります。最初に git status と差分を読み、既存の変更を引き継いで完成させてください。\n\n' : ''}${task}`, worktree.path);
      if (/NEEDS_CLARIFICATION/i.test(report)) {
        this.store.update(id, { status: 'waiting_info', worker: null });
        await this.discord.say(id, `**${worker.name}｜実装**\n追加確認が必要です。${trim(report, 1200)}`);
        this.event(id, worker.id, 'question', trim(report, 500));
        return;
      }
      await this.git.test(worktree.path);
      await this.git.commitPush(worktree.path, worktree.branch, `feat(agent): ${ticket.title}`.slice(0, 100));
      const pr = await this.git.pr(ticket.title, `${issue ? `Closes #${issue}\n\n` : ''}${ticket.summary}\n\nFeedback base: ${baseSha}\nChecks: npm run typecheck, npm run build, npm run test:client, npm run test:sync\n\nDiscord thread: ${id}`, worktree.branch);
      this.store.update(id, { status: 'pr_ready', pr_number: pr, branch: worktree.branch, worker: null });
      this.event(id, worker.id, 'pr_ready', `PR #${pr} を検証済み。出荷待ち`);
      await this.discord.say(id, `**${worker.name}｜実装**\n変更とテストが完了しました。PR #${pr} を出荷待ちに入れました。`);
    } catch (error) { await this.fail(id, worker.id, error); }
    finally { if (worktree) await this.git.removeWorktree(worktree.path); }
  }
  async release(force = false) {
    if (this.releasing) return false;
    const ready = this.store.list().filter(row => row.status === 'pr_ready' && row.branch && row.pr_number);
    if (!ready.length) return false;
    if (!force && Date.now() - Math.min(...ready.map(row => row.updated_at)) < this.config.batchMs) return false;
    this.releasing = true;
    this.lastReleaseAttempt = Date.now();
    const releaseId = this.store.release('integrating', ready.map(row => row.id));
    let merged = 0;
    let finalSha = '';
    try {
      const selection = await this.ai.ask(roleName('release'), `出荷担当として今回 ${this.config.baseBranch || 'main'} にマージする PR を選んでください。既定では全部処理します。依存関係の理由で除外するものだけ省いてください。返す JSON: {"selectedIds": ["ticket id"], "notes": "短いマージ説明"}。\n\n候補: ${JSON.stringify(ready.map(x => ({id:x.id,title:x.title,summary:x.summary,pr:x.pr_number})))}`);
      const selected = [...new Set(asList(selection.selectedIds))].map(id => ready.find(row => row.id === id)).filter(Boolean);
      if (!selected.length) throw new Error('Release agent selected no PRs');
      this.store.updateRelease(releaseId, { tickets: JSON.stringify(selected.map(x => x.id)) });
      this.event(null,'release','batch',`${selected.length} 件の PR を確認: ${trim(selection.notes, 300)}`);
      for (const ticket of selected) {
        let worktree;
        try {
          const before = await this.git.prInfo(ticket.pr_number);
          if (before.state === 'MERGED') {
            await this.markMerged(ticket,before.mergeCommit?.oid || await this.git.baseHead());
            merged++;
            continue;
          }
          this.store.update(ticket.id, { status: 'integrating' });
          const integratedMain = await this.git.baseHead();
          await this.git.git(['fetch','origin',ticket.branch]);
          worktree = await this.git.worktree(`release-${releaseId}-${ticket.id}-${Date.now()}`,`origin/${ticket.branch}`);
          try { await this.git.mergeMainInto(worktree.path); }
          catch (mergeError) {
            const conflicts = (await this.git.git(['diff','--name-only','--diff-filter=U'],worktree.path)).stdout;
            if (!conflicts) throw mergeError;
            this.event(ticket.id,'integrator','conflict',`競合解決中: ${trim(conflicts, 300)}`);
            const report = await this.ai.code(roleName('integrator'), `現在 Git merge 中の競合を解決してください。競合マーカーを除去し、両方の変更を満たしてください。git add/commit/push は行わないでください。対象: ${ticket.title}。`, worktree.path, { provider: this.config.integrationProvider });
            await this.git.git(['add','-A'],worktree.path);
            await this.git.git(['commit','--no-edit'],worktree.path);
            this.event(ticket.id,'integrator','resolved',trim(report,300));
          }
          await this.git.test(worktree.path);
          const head = await this.git.pushBranch(worktree.path,ticket.branch);
          this.event(ticket.id,'integrator','verified',`最新 ${this.config.baseBranch || 'main'} と統合した状態でテスト完了: ${head.slice(0,8)}`);
          const checks = await this.git.waitForChecks(ticket.pr_number,head);
          this.event(ticket.id,'release','checks',`PR #${ticket.pr_number}: ${checks} 件の GitHub チェックを確認`);
          if (await this.git.baseHead() !== integratedMain) throw new Error(`${this.config.baseBranch || 'main'} changed during PR checks; retry integration against the latest commit`);
          const mergeSha = await this.git.mergePr(ticket.pr_number,head);
          finalSha = mergeSha || await this.git.baseHead();
          await this.markMerged(ticket,finalSha);
          merged++;
        } finally {
          if (worktree) await this.git.removeWorktree(worktree.path);
        }
      }
      finalSha = await this.git.baseHead();
      this.store.updateRelease(releaseId, { status: 'merged', commit_sha:finalSha, url:`https://github.com/${this.config.githubRepo}/tree/${this.config.baseBranch || 'main'}` });
      this.lastReleaseAttempt = 0;
      return true;
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
    await this.discord.say(id, `**${roleName(actor)}**\n処理を止めました。担当者が確認します。${trim(message, 500)}`).catch(() => {});
  }
}
