import { roles } from './config.js';
import { existsSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';

const roleName = id => roles.find(role => role.id === id)?.name || id;
const asList = value => Array.isArray(value) ? value.map(String).filter(Boolean) : [];
const trim = (value, length = 1500) => String(value || '').slice(0, length);

export class Engine {
  constructor(config, store, ai, git, discord, onChange = () => {}) {
    Object.assign(this, { config, store, ai, git, discord, onChange });
    this.active = new Set();
    this.pendingFeedback = new Set();
    this.busyWorkers = new Set();
    this.releasing = false;
    this.lastReleaseAttempt = 0;
    this.lastSetupWarning = 0;
    this.timer = null;
  }
  event(id, actor, kind, text) {
    this.store.event(id, roleName(actor), kind, text);
    this.onChange();
  }
  async start() {
    this.store.recover();
    this.discord.onFeedback = id => this.feedback(id);
    this.discord.onDecision = (id, text, author) => this.decision(id, text, author);
    if (!this.config.discordToken) return;
    await this.discord.start();
    for (const ticket of this.store.list().filter(row => row.status === 'intake')) queueMicrotask(() => this.feedback(ticket.id));
    this.timer = setInterval(() => this.tick().catch(error => console.error('scheduler', error)), 15_000);
    await this.tick();
  }
  async stop() { clearInterval(this.timer); await this.discord.stop(); }
  async feedback(id) {
    if (this.active.has(id)) { this.pendingFeedback.add(id); return; }
    this.active.add(id);
    try {
      const ticket = this.store.get(id);
      if (!ticket || !['intake','waiting_info','decision'].includes(ticket.status)) return;
      if (ticket.status === 'decision' && ticket.decision_thread_id) return;
      const history = await this.discord.history(id);
      const similar = this.store.list().filter(row => row.id !== id && !['grouped','failed'].includes(row.status)).slice(0,50)
        .map(row => ({ id:row.id,title:row.title,summary:row.summary,status:row.status }));
      const result = await this.ai.ask(roleName('intake'), `Discord のフィードバックを聞き取る担当です。まず既存案件の似た声を探し、このリポジトリのコードと docs を読み、すでに実装済みの機能か調べてください。似た案件があれば duplicateOf にその正確な ID を入れます。既存機能で解決できるなら alreadyExists=true、evidencePath に確認したリポジトリ相対ファイルパスを入れ、使い方を reply で伝えます。機能が存在しても報告が不具合なら完了扱いにしません。断定できない場合は質問します。返す JSON: {"ready": boolean, "reply": "ユーザーへの自然な日本語の短い返信または質問", "title": "短い件名", "summary": "要約", "criteria": ["受け入れ条件"], "duplicateOf": "既存案件IDまたは空文字", "alreadyExists": boolean, "evidencePath": "リポジトリ相対パスまたは空文字"}。既出内容を繰り返して質問しないでください。\n\nスレッド名: ${ticket.title}\n${history}\n\n既存案件: ${JSON.stringify(similar)}`, { cwd: this.config.repo, repoReadOnly: true });
      const update = { title: trim(result.title || ticket.title, 100), summary: trim(result.summary, 3000), criteria: JSON.stringify(asList(result.criteria)) };
      this.store.update(id, update);
      const duplicate = similar.find(row => row.id === String(result.duplicateOf));
      if (duplicate) {
        this.store.update(id, { status:'grouped', parent_ticket_id:duplicate.id });
        this.event(id,'intake','grouped',`${duplicate.title} と同じ要望としてまとめました`);
        await this.discord.say(id, `**${roleName('intake')}｜聞き取り**\n${trim(result.reply || `「${duplicate.title}」と同じ方向の声としてまとめました。追加の観点も開発担当へ渡します。`)}`);
        return;
      }
      const evidence = String(result.evidencePath || '').replace(/\\/g,'/');
      const evidenceFile = resolve(this.config.repo,evidence);
      const insideRepo = evidence && !isAbsolute(evidence) && !relative(this.config.repo,evidenceFile).startsWith('..');
      if (result.alreadyExists && insideRepo && existsSync(evidenceFile)) {
        this.store.update(id, { status:'resolved_existing' });
        this.event(id,'intake','existing',`既存機能で対応: ${evidence}`);
        await this.discord.say(id, `**${roleName('intake')}｜聞き取り**\n${trim(result.reply || 'この機能はすでにあります。')}`);
        return;
      }
      if (result.reply) await this.discord.say(id, `**${roleName('intake')}｜聞き取り**\n${trim(result.reply)}`);
      if (!result.ready) {
        this.store.update(id, { status: 'waiting_info' });
        this.event(id, 'intake', 'question', trim(result.reply || '追加情報を待っています'));
        return;
      }
      this.store.update(id, { status: 'planning' });
      this.event(id, 'intake', 'ready', '実装に必要な情報が揃いました');
      await this.plan(id, history);
    } catch (error) { await this.fail(id, 'intake', error); }
    finally {
      this.active.delete(id);
      this.onChange();
      if (this.pendingFeedback.delete(id)) queueMicrotask(() => this.feedback(id));
    }
  }
  async plan(id, history, decisionAnswer = '') {
    const ticket = this.store.get(id);
    const candidates = this.store.list().filter(row => row.id !== id && !['grouped','failed','deployed'].includes(row.status))
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
    const lead = await this.ai.ask(roleName('lead'), `開発リードとして作業範囲と受け入れ条件を確認してください。製品判断の不足があれば needsDecision=true。返す JSON: {"needsDecision": boolean, "decisionQuestion": "不足している判断", "task": "実装担当への明確な作業指示", "risk": "主な注意点"}。\n\n案件: ${JSON.stringify({title:result.title,summary,criteria,implementationTask:result.implementationTask,decisionAnswer})}`);
    if (lead.needsDecision) {
      await this.askDecision(id, trim(lead.decisionQuestion || '開発方針を確認してください'));
      return;
    }
    this.store.update(id, { status: 'queued', error: null });
    this.store.setKv(`task:${id}`, trim(lead.task || result.implementationTask || summary, 12000));
    this.event(id, 'lead', 'queued', trim(lead.risk || '実装担当へ割り当て待ち', 500));
    await this.discord.say(id, `**${roleName('lead')}｜開発リード**\n案件として受け付けました。${criteria.length ? `受け入れ条件: ${criteria.join(' / ')}` : ''}`);
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
    if (this.config.autoRelease && !this.releasing && ready.length && Date.now() - this.lastReleaseAttempt > 10 * 60_000 && Date.now() - Math.min(...ready.map(row => row.updated_at)) >= this.config.batchMs) {
      this.release().catch(error => console.error('release', error));
    }
  }
  async implement(id, worker) {
    let worktree;
    try {
      const ticket = this.store.update(id, { status: 'coding', worker: worker.id, error: null });
      this.event(id, worker.id, 'coding', '専用 worktree で実装を開始');
      await this.git.prepare();
      const issue = await this.git.issue(ticket.title, `Discord feedback: https://discord.com/channels/@me/${id}\n\n${ticket.summary}\n\nAcceptance criteria:\n${JSON.parse(ticket.criteria).map(x => `- ${x}`).join('\n')}`).catch(error => { this.event(id,'pm','issue_warning',error.message); return null; });
      if (issue) this.store.update(id, { issue_number: issue });
      worktree = await this.git.worktree(`task-${id}-${Date.now()}`);
      const linked = this.store.list().filter(row => row.parent_ticket_id === id).map(row => row.summary);
      const task = `${this.store.getKv(`task:${id}`) || ticket.summary}\n\n受け入れ条件:\n${JSON.parse(ticket.criteria).map(x => `- ${x}`).join('\n')}\n\n追加の声:\n${linked.join('\n')}`;
      const report = await this.ai.code(worker.name, task, worktree.path);
      if (/NEEDS_CLARIFICATION/i.test(report)) {
        this.store.update(id, { status: 'waiting_info', worker: null });
        await this.discord.say(id, `**${worker.name}｜実装**\n追加確認が必要です。${trim(report, 1200)}`);
        this.event(id, worker.id, 'question', trim(report, 500));
        return;
      }
      await this.git.test(worktree.path);
      await this.git.commitPush(worktree.path, worktree.branch, `feat(agent): ${ticket.title}`.slice(0, 100));
      const pr = await this.git.pr(ticket.title, `${issue ? `Closes #${issue}\n\n` : ''}${ticket.summary}\n\nChecks: npm run typecheck, npm run build, npm run test:client, npm run test:sync\n\nDiscord thread: ${id}`, worktree.branch);
      this.store.update(id, { status: 'pr_ready', pr_number: pr, branch: worktree.branch, worker: null });
      this.event(id, worker.id, 'pr_ready', `PR #${pr} を検証済み。出荷待ち`);
      await this.discord.say(id, `**${worker.name}｜実装**\n変更とテストが完了しました。PR #${pr} を出荷待ちに入れました。`);
    } catch (error) { await this.fail(id, worker.id, error); }
    finally { if (worktree) await this.git.removeWorktree(worktree.path); }
  }
  async release(force = false) {
    if (this.releasing) return false;
    const ready = this.store.list().filter(row => row.status === 'pr_ready' && row.branch);
    if (!ready.length) return false;
    if (!this.config.coolifyWebhook || !this.config.coolifyApiBase || !this.config.coolifyToken || !this.config.nightlyUrl) {
      if (Date.now() - this.lastSetupWarning > 60 * 60_000) {
        this.event(null,'release','setup','Coolify の URL・API 設定が揃うまで公開を保留');
        this.lastSetupWarning = Date.now();
      }
      return false;
    }
    if (!force && Date.now() - Math.min(...ready.map(row => row.updated_at)) < this.config.batchMs) return false;
    this.releasing = true;
    this.lastReleaseAttempt = Date.now();
    let worktree;
    const releaseId = this.store.release('integrating', ready.map(row => row.id));
    try {
      const selection = await this.ai.ask(roleName('release'), `出荷担当として同時に公開する PR を選んでください。既定では全部まとめます。依存関係の理由で除外するものだけ省いてください。返す JSON: {"selectedIds": ["ticket id"], "notes": "短い公開説明"}。\n\n候補: ${JSON.stringify(ready.map(x => ({id:x.id,title:x.title,summary:x.summary,pr:x.pr_number})))}`);
      const selected = ready.filter(row => asList(selection.selectedIds).includes(row.id));
      if (!selected.length) throw new Error('Release agent selected no PRs');
      this.store.updateRelease(releaseId, { tickets: JSON.stringify(selected.map(x => x.id)) });
      this.event(null,'release','batch',`${selected.length} 件を統合: ${trim(selection.notes, 300)}`);
      await this.git.prepare();
      worktree = await this.git.worktree(`release-${releaseId}-${Date.now()}`);
      for (const ticket of selected) {
        this.store.update(ticket.id, { status: 'integrating' });
        try {
          await this.git.mergeInto(worktree.path, ticket.branch);
        } catch (mergeError) {
          this.event(ticket.id,'integrator','conflict',`競合解決中: ${trim(mergeError.message, 300)}`);
          const report = await this.ai.code(roleName('integrator'), `現在 Git merge 中の競合を解決してください。競合マーカーを除去し、両方の変更を満たしてください。git add/commit/push は行わないでください。対象: ${ticket.title}。`, worktree.path, { provider: this.config.integrationProvider });
          await this.git.git(['add','-A'],worktree.path);
          await this.git.git(['commit','--no-edit'],worktree.path);
          this.event(ticket.id,'integrator','resolved',trim(report,300));
        }
      }
      await this.git.test(worktree.path);
      const sha = await this.git.pushNightly(worktree.path);
      this.store.updateRelease(releaseId, { status: 'deploying', commit_sha: sha });
      this.event(null,'integrator','verified',`${selected.length} 件の統合ビルドを検証: ${sha.slice(0,8)}`);
      const deploy = await this.deploy(sha);
      this.store.updateRelease(releaseId, { status: 'deployed', deployment_id: deploy.id, url: this.config.nightlyUrl });
      for (const ticket of selected) {
        this.store.update(ticket.id, { status: 'deployed' });
        this.event(ticket.id,'release','deployed',`${this.config.nightlyUrl} (${sha.slice(0,8)})`);
        if (ticket.issue_number) await this.git.closeIssue(ticket.issue_number, `Web nightly ${sha.slice(0,8)}: ${this.config.nightlyUrl}`).catch(error => this.event(ticket.id,'release','issue_warning',error.message));
        await this.discord.say(ticket.id, `**${roleName('release')}｜出荷**\nWeb nightly に公開しました。${this.config.nightlyUrl}\n公開版: ${sha.slice(0,8)}`).catch(error => this.event(ticket.id,'release','discord_warning',error.message));
      }
      return true;
    } catch (error) {
      this.store.updateRelease(releaseId, { status: 'failed', error: trim(error.message, 2000) });
      for (const ticket of ready) if (this.store.get(ticket.id)?.status === 'integrating') this.store.update(ticket.id, { status: 'pr_ready' });
      this.event(null,'release','failed',error.message);
      return false;
    } finally {
      if (worktree) await this.git.removeWorktree(worktree.path);
      this.releasing = false;
      this.onChange();
    }
  }
  async deploy(sha) {
    const response = await fetch(this.config.coolifyWebhook, { method: 'POST', headers: { Authorization: `Bearer ${this.config.coolifyToken}` }, signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`Coolify deploy webhook HTTP ${response.status}: ${(await response.text()).slice(0,500)}`);
    const payload = await response.json();
    const id = payload.deployment_uuid || payload.uuid || payload.deployments?.[0]?.deployment_uuid;
    if (!id) throw new Error(`Coolify did not return deployment UUID: ${JSON.stringify(payload).slice(0,500)}`);
    const deadline = Date.now() + this.config.releaseTimeoutMs;
    while (Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, this.config.pollMs));
      const statusResponse = await fetch(`${this.config.coolifyApiBase}/api/v1/deployments/${encodeURIComponent(id)}`, { headers: { Authorization: `Bearer ${this.config.coolifyToken}` }, signal: AbortSignal.timeout(30_000) });
      if (!statusResponse.ok) throw new Error(`Coolify status HTTP ${statusResponse.status}`);
      const state = await statusResponse.json();
      if (/failed|cancelled|error/i.test(state.status || '')) throw new Error(`Coolify deployment failed: ${state.status}`);
      if (/finished|success|completed/i.test(state.status || '')) {
        if (state.commit && !sha.startsWith(state.commit) && !state.commit.startsWith(sha)) throw new Error(`Coolify deployed ${state.commit}, expected ${sha}. Check the nightly application's Git branch.`);
        const health = await fetch(this.config.nightlyUrl, { signal: AbortSignal.timeout(15_000) });
        if (!health.ok) throw new Error(`Nightly URL health HTTP ${health.status}`);
        const serviceHealth = await fetch(new URL('/healthz',this.config.nightlyUrl), { signal: AbortSignal.timeout(15_000) });
        if (!serviceHealth.ok) throw new Error(`Nightly service health HTTP ${serviceHealth.status}`);
        return { id, sha };
      }
    }
    throw new Error(`Coolify deployment ${id} timed out`);
  }
  async fail(id, actor, error) {
    const message = trim(error?.message || error, 2000);
    this.store.update(id, { status: 'failed', error: message, worker: null });
    this.event(id, actor, 'failed', message);
    await this.discord.say(id, `**${roleName(actor)}**\n処理を止めました。担当者が確認します。${trim(message, 500)}`).catch(() => {});
  }
}
