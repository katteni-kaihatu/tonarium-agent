import { mkdir, readdir, rm } from 'node:fs/promises';
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
  async prInfo(number) {
    const result = await this.gh(['pr','view',String(number),'--repo',this.config.githubRepo,'--json','state,headRefOid,baseRefName,statusCheckRollup,mergeCommit']);
    return JSON.parse(result.stdout);
  }
  async prDetails(number) {
    const result = await this.gh(['pr','view',String(number),'--repo',this.config.githubRepo,'--json','title,body,files,mergeCommit']);
    const info = JSON.parse(result.stdout);
    return {title:info.title,body:info.body,mergeCommit:info.mergeCommit?.oid,files:(info.files || []).map(file => file.path)};
  }
  async waitForChecks(number, expectedHead) {
    const deadline = Date.now() + (this.config.checksTimeoutMs || 20 * 60_000);
    let seenExpectedHead = false;
    while (Date.now() < deadline) {
      const info = await this.prInfo(number);
      if (info.headRefOid !== expectedHead) {
        if (seenExpectedHead) throw new Error(`PR #${number} head changed while checks were running`);
        await new Promise(resolve => setTimeout(resolve, this.config.checksPollMs ?? 10_000));
        continue;
      }
      seenExpectedHead = true;
      const checks = info.statusCheckRollup || [];
      const failed = checks.filter(check => /failure|error|timed_out|cancelled|action_required|startup_failure/i.test(check.conclusion || check.state || ''));
      if (failed.length) throw new Error(`PR #${number} checks failed: ${failed.map(check => check.name || check.context || 'unknown').join(', ')}`);
      const pending = checks.filter(check => !/success|neutral|skipped/i.test(check.conclusion || check.state || ''));
      const required = (this.config.requiredPrCheck || 'web').toLowerCase();
      const requiredChecks = checks.filter(check => (check.name || check.context || '').toLowerCase().includes(required));
      if (!pending.length && requiredChecks.some(check => /success/i.test(check.conclusion || check.state || ''))) return checks.length;
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
