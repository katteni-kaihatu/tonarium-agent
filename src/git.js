import { mkdir, readdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { command } from './command.js';

export class GitHub {
  constructor(config, root) { this.config = config; this.root = root; this.worktrees = join(root, '.worktrees'); }
  git(args, cwd = this.config.repo, options = {}) { return command('git', args, { cwd, ...options }); }
  gh(args, cwd = this.config.repo, options = {}) { return command('gh', args, { cwd, ...options }); }
  async prepare() {
    this.prepareLock = (this.prepareLock || Promise.resolve()).catch(() => {}).then(async () => {
      await mkdir(this.worktrees, { recursive: true });
      await this.git(['fetch','origin',this.config.baseBranch || 'main']);
    });
    return this.prepareLock;
  }
  async baseHead() {
    await this.prepare();
    return (await this.git(['rev-parse',`origin/${this.config.baseBranch || 'main'}`])).stdout;
  }
  async worktree(name, base = `origin/${this.config.baseBranch || 'main'}`) {
    await mkdir(this.worktrees, { recursive: true });
    const path = join(this.worktrees, name.replace(/[^a-zA-Z0-9_-]/g, '-'));
    const branch = `agent/${name.replace(/[^a-zA-Z0-9_-]/g, '-')}`;
    await this.git(['worktree','add','-b',branch,path,base]);
    return { path, branch };
  }
  async resumeTaskWorktree(id) {
    const prefix = `task-${String(id).replace(/[^a-zA-Z0-9_-]/g, '-')}-`;
    const entries = await readdir(this.worktrees,{withFileTypes:true}).catch(() => []);
    const names = entries.filter(entry => entry.isDirectory() && entry.name.startsWith(prefix)).map(entry => entry.name).sort().reverse();
    for (const name of names) {
      const path = join(this.worktrees,name);
      const valid = await this.git(['rev-parse','--is-inside-work-tree'],path).catch(() => null);
      if (valid?.stdout === 'true') return {path,branch:`agent/${name}`,resumed:true};
    }
    return null;
  }
  async snapshotWorktree(name, sha) {
    await mkdir(this.worktrees, { recursive: true });
    const path = join(this.worktrees, name.replace(/[^a-zA-Z0-9_-]/g, '-'));
    await this.git(['worktree','add','--detach',path,sha]);
    return { path };
  }
  async removeWorktree(path) {
    await this.git(['worktree','remove','--force',path]).catch(() => {});
    await rm(path, { recursive: true, force: true }).catch(() => {});
  }
  async test(path) {
    const base = (await this.git(['merge-base','HEAD',`origin/${this.config.baseBranch || 'main'}`],path)).stdout;
    if (await this.changelogCheck(path,base) === 'missing') throw new Error('Every PR must add a new dated entry to shared/changelog.ts');
    await command('npm', ['ci'], { cwd: path, timeoutMs: 15 * 60_000 });
    await command('npm', ['run','typecheck'], { cwd: path, timeoutMs: 15 * 60_000 });
    await command('npm', ['run','build'], { cwd: path, timeoutMs: 20 * 60_000 });
    await command('npm', ['run','test:client'], { cwd: path, timeoutMs: 15 * 60_000 });
    await command('npm', ['run','test:sync'], { cwd: path, timeoutMs: 15 * 60_000 });
  }
  async issue(title, body) {
    const result = await this.gh(['issue','create','--repo',this.config.githubRepo,'--title',title,'--body',body]);
    return Number(result.stdout.match(/\/(\d+)\s*$/)?.[1]) || null;
  }
  async pr(title, body, branch) {
    const result = await this.gh(['pr','create','--repo',this.config.githubRepo,'--base',this.config.baseBranch || 'main','--head',branch,'--title',title,'--body',body]);
    return Number(result.stdout.match(/\/(\d+)\s*$/)?.[1]) || null;
  }
  async findPr(branch) {
    const result = await this.gh(['pr','list','--repo',this.config.githubRepo,'--head',branch,'--state','open','--json','number','--limit','1']);
    return JSON.parse(result.stdout || '[]')[0]?.number || null;
  }
  async closeIssue(number, note) {
    if (!number) return;
    await this.gh(['issue','close',String(number),'--repo',this.config.githubRepo,'--comment',note]);
  }
  async commitPush(path, branch, title, onRetry = () => {}) {
    const status = await this.git(['status','--porcelain'], path);
    if (!status.stdout) throw new Error('Agent made no code changes');
    await this.git(['add','-A'], path);
    await this.git(['commit','-m',title], path);
    await this.pushWithRetry(path,branch,onRetry);
  }
  async pushWithRetry(path, branch, onRetry = () => {}) {
    const delays = this.pushRetryDelays || [0,2_000,5_000];
    let lastError;
    for (let attempt = 0; attempt < delays.length; attempt++) {
      if (delays[attempt]) await new Promise(resolve => setTimeout(resolve,delays[attempt]));
      try { return await this.git(['push','-u','origin',branch],path); }
      catch (error) {
        lastError = error;
        if (attempt + 1 < delays.length) onRetry(attempt + 1,error);
      }
    }
    throw lastError;
  }
  async mergeMainInto(path) {
    await this.git(['merge','--no-edit',`origin/${this.config.baseBranch || 'main'}`], path);
  }
  async pushBranch(path, branch) {
    await this.git(['push','origin',`HEAD:refs/heads/${branch}`],path);
    return (await this.git(['rev-parse','HEAD'],path)).stdout;
  }
  async changelogCheck(path,baseSha) {
    const script = join(path,'.github','scripts','check-changelog.mjs');
    if (!existsSync(script)) return 'unavailable';
    try {
      await command(process.execPath,[script,baseSha],{cwd:path,timeoutMs:30_000});
      return 'ok';
    } catch (error) {
      if (error.message.includes('Every PR must add a new dated entry')) return 'missing';
      throw error;
    }
  }
  async prInfo(number) {
    const result = await this.gh(['pr','view',String(number),'--repo',this.config.githubRepo,'--json','state,headRefOid,headRefName,baseRefName,statusCheckRollup,mergeCommit']);
    return JSON.parse(result.stdout);
  }
  async checkRunsForCommit(sha) {
    const result = await this.gh(['api',`repos/${this.config.githubRepo}/commits/${sha}/check-runs`]);
    return (JSON.parse(result.stdout).check_runs || []).map(run => ({name:run.name,conclusion:run.conclusion,state:run.status}));
  }
  async workflowRunsForCommit(sha) {
    const result = await this.gh(['run','list','--repo',this.config.githubRepo,'--commit',sha,'--limit','100','--json','status,conclusion,headSha,workflowName']);
    return JSON.parse(result.stdout).filter(run => run.headSha === sha)
      .map(run => ({name:run.workflowName || 'GitHub workflow',conclusion:run.conclusion,state:run.status}));
  }
  async triggerWebCheck(branch) {
    await this.gh(['workflow','run','web-checks.yml','--repo',this.config.githubRepo,'--ref',branch]);
  }
  async prDetails(number) {
    const result = await this.gh(['pr','view',String(number),'--repo',this.config.githubRepo,'--json','title,body,files,mergeCommit']);
    const info = JSON.parse(result.stdout);
    return {title:info.title,body:info.body,mergeCommit:info.mergeCommit?.oid,files:(info.files || []).map(file => file.path)};
  }
  async waitForChecks(number, expectedHead) {
    const deadline = Date.now() + (this.config.checksTimeoutMs || 20 * 60_000);
    let seenExpectedHead = false;
    let headSeenAt = 0;
    let triggered = false;
    while (Date.now() < deadline) {
      const info = await this.prInfo(number);
      if (info.headRefOid !== expectedHead) {
        if (seenExpectedHead) throw new Error(`PR #${number} head changed while checks were running`);
        await new Promise(resolve => setTimeout(resolve, this.config.checksPollMs ?? 10_000));
        continue;
      }
      if (!seenExpectedHead) headSeenAt = Date.now();
      seenExpectedHead = true;
      const required = (this.config.requiredPrCheck || 'web').toLowerCase();
      const rollup = info.statusCheckRollup || [];
      const hasRequired = rollup.some(check => (check.name || check.context || '').toLowerCase().includes(required));
      const checks = [
        ...(hasRequired || !info.headRefName ? rollup : [...rollup,...await this.checkRunsForCommit(expectedHead)]),
        ...await this.workflowRunsForCommit(expectedHead)
      ];
      const failed = checks.filter(check => /failure|error|timed_out|cancelled|action_required|startup_failure/i.test(check.conclusion || check.state || ''));
      if (failed.length) throw new Error(`PR #${number} checks failed: ${failed.map(check => check.name || check.context || 'unknown').join(', ')}`);
      const pending = checks.filter(check => !/success|neutral|skipped/i.test(check.conclusion || check.state || ''));
      const requiredChecks = checks.filter(check => (check.name || check.context || '').toLowerCase().includes(required));
      if (!pending.length && requiredChecks.some(check => /success/i.test(check.conclusion || check.state || ''))
        && (!info.headRefName || Date.now() - headSeenAt >= (this.config.checksStartGraceMs ?? 30_000))) return checks.length;
      if (!requiredChecks.length && !triggered && required === 'web' && info.headRefName && Date.now() - headSeenAt >= (this.config.checksStartGraceMs ?? 30_000)) {
        await this.triggerWebCheck(info.headRefName);
        triggered = true;
      }
      await new Promise(resolve => setTimeout(resolve, this.config.checksPollMs ?? 10_000));
    }
    throw new Error(`PR #${number} checks timed out`);
  }
  async mergePr(number, expectedHead) {
    const before = await this.prInfo(number);
    if (before.state === 'MERGED') return before.mergeCommit?.oid || null;
    if (before.baseRefName !== (this.config.baseBranch || 'main')) throw new Error(`PR #${number} targets ${before.baseRefName}`);
    if (before.headRefOid !== expectedHead) throw new Error(`PR #${number} head changed before merge`);
    await this.gh(['pr','merge',String(number),'--repo',this.config.githubRepo,'--merge','--match-head-commit',expectedHead]);
    const after = await this.prInfo(number);
    if (after.state !== 'MERGED') throw new Error(`PR #${number} is ${after.state}, expected MERGED`);
    return after.mergeCommit?.oid || null;
  }
}
