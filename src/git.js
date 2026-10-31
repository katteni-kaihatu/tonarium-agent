import { mkdir, readdir, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { command } from './command.js';

const changelogPaths = ['changelog','shared/changelog.ts'];

export class GitHub {
  constructor(config, root) { this.config = config; this.root = root; this.worktrees = join(root, '.worktrees'); }
  git(args, cwd = this.config.repo, options = {}) { return command('git', args, { cwd, ...options }); }
  gh(args, cwd = this.config.repo, options = {}) { return command('gh', args, { cwd, ...options }); }
  async prepare() {
    this.prepareLock = (this.prepareLock || Promise.resolve()).catch(() => {}).then(async () => {
      await mkdir(this.worktrees, { recursive: true });
      await this.git(['fetch','origin',this.config.baseBranch || 'develop']);
    });
    return this.prepareLock;
  }
  async baseHead() {
    await this.prepare();
    return (await this.git(['rev-parse',`origin/${this.config.baseBranch || 'develop'}`])).stdout;
  }
  async worktree(name, base = `origin/${this.config.baseBranch || 'develop'}`) {
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
  async changelogChanges(path, base) {
    const tracked = (await this.git(['diff','--name-only',base,'--',...changelogPaths],path)).stdout.split('\n');
    const untracked = (await this.git(['ls-files','--others','--exclude-standard','--',...changelogPaths],path)).stdout.split('\n');
    return [...new Set([...tracked,...untracked].map(line => line.trim()).filter(Boolean))];
  }
  async restoreChangelog(path, base) {
    const changed = await this.changelogChanges(path,base);
    if (!changed.length) return [];
    const inBase = new Set((await this.git(['ls-tree','-r','--name-only',base,'--',...changelogPaths],path)).stdout.split('\n').filter(Boolean));
    const restore = changed.filter(file => inBase.has(file));
    const remove = changed.filter(file => !inBase.has(file));
    if (restore.length) await this.git(['checkout',base,'--',...restore],path);
    if (remove.length) await this.git(['rm','-r','-f','-q','--ignore-unmatch','--',...remove],path);
    for (const file of remove) await rm(join(path,file),{force:true});
    return changed;
  }
  async reviewDiff(path, limit = 40_000) {
    const base = (await this.git(['merge-base','HEAD',`origin/${this.config.baseBranch || 'develop'}`],path)).stdout;
    // 新規ファイルも差分に出すため、内容は追加せずに追跡対象としてだけ登録する
    await this.git(['add','-A','--intent-to-add'],path);
    const stat = (await this.git(['diff','--stat=120',base],path)).stdout;
    const diff = (await this.git(['diff','--unified=3',base,'--','.',':(exclude)package-lock.json'],path)).stdout;
    return `${stat.slice(-4000)}\n\n${diff.slice(0,limit)}${diff.length > limit ? '\n…（以降省略）' : ''}`;
  }
  async test(path) {
    const base = (await this.git(['merge-base','HEAD',`origin/${this.config.baseBranch || 'develop'}`],path)).stdout;
    const changelog = await this.changelogChanges(path,base);
    if (changelog.length) throw new Error(`Changelog files must not change before the main release: ${changelog.join(', ')}`);
    await command('npm', ['ci'], { cwd: path, timeoutMs: 15 * 60_000 });
    await command('npm', ['run','typecheck'], { cwd: path, timeoutMs: 15 * 60_000 });
    await command('npm', ['run','build'], { cwd: path, timeoutMs: 20 * 60_000 });
    await command('npm', ['run','test:client'], { cwd: path, timeoutMs: 15 * 60_000 });
    await command('npm', ['run','test:sync'], { cwd: path, timeoutMs: 15 * 60_000 });
    const scripts = JSON.parse(await readFile(join(path,'package.json'),'utf8')).scripts || {};
    if (scripts['test:shared-assets']) await command('npm', ['run','test:shared-assets'], { cwd: path, timeoutMs: 15 * 60_000 });
  }
  async issue(title, body) {
    const result = await this.gh(['issue','create','--repo',this.config.githubRepo,'--title',title,'--body',body]);
    return Number(result.stdout.match(/\/(\d+)\s*$/)?.[1]) || null;
  }
  async pr(title, body, branch) {
    const result = await this.gh(['pr','create','--repo',this.config.githubRepo,'--base',this.config.baseBranch || 'develop','--head',branch,'--title',title,'--body',body]);
    return Number(result.stdout.match(/\/(\d+)\s*$/)?.[1]) || null;
  }
  async findPr(branch) {
    const result = await this.gh(['pr','list','--repo',this.config.githubRepo,'--head',branch,'--state','open','--json','number','--limit','1']);
    return JSON.parse(result.stdout || '[]')[0]?.number || null;
  }
  async retargetPr(number) {
    await this.gh(['pr','edit',String(number),'--repo',this.config.githubRepo,'--base',this.config.baseBranch || 'develop']);
  }
  async closeIssue(number, note) {
    if (!number) return;
    await this.gh(['issue','close',String(number),'--repo',this.config.githubRepo,'--comment',note]);
  }
  async hasChanges(path) {
    const status = await this.git(['status','--porcelain'], path);
    return Boolean(status.stdout.trim());
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
    await this.git(['merge','--no-edit',`origin/${this.config.baseBranch || 'develop'}`], path);
  }
  async pushBranch(path, branch) {
    await this.git(['push','origin',`HEAD:refs/heads/${branch}`],path);
    return (await this.git(['rev-parse','HEAD'],path)).stdout;
  }
  async prInfo(number) {
    const result = await this.gh(['pr','view',String(number),'--repo',this.config.githubRepo,'--json','state,headRefOid,headRefName,baseRefName,statusCheckRollup,mergeCommit']);
    return JSON.parse(result.stdout);
  }
  async failedCheckDetails(number) {
    const info = await this.prInfo(number);
    const failed = (info.statusCheckRollup || []).filter(check => /failure|error|timed_out|cancelled/i.test(check.conclusion || check.status || ''));
    const summaries = failed.map(check => `${check.name || 'check'}: ${check.conclusion || check.status}`);
    const runIds = [...new Set(failed.map(check => check.detailsUrl?.match(/\/actions\/runs\/(\d+)/)?.[1]).filter(Boolean))].slice(0,2);
    for (const runId of runIds) {
      try {
        const result = await this.gh(['run','view',runId,'--repo',this.config.githubRepo,'--log-failed'],this.config.repo,{timeoutMs:60_000});
        summaries.push(`Run ${runId}: ${result.stdout.slice(-9000)}`);
      } catch (error) { summaries.push(`Run ${runId}: ${String(error.message).slice(-1000)}`); }
    }
    return summaries.join('\n').slice(-12_000);
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
    const result = await this.gh(['pr','view',String(number),'--repo',this.config.githubRepo,'--json','title,body,files,mergeCommit,author']);
    const info = JSON.parse(result.stdout);
    return {title:info.title,body:info.body,author:info.author?.login || '',mergeCommit:info.mergeCommit?.oid,files:(info.files || []).map(file => file.path)};
  }
  async fetchBranches(...branches) {
    await mkdir(this.worktrees, { recursive: true });
    await this.git(['fetch','origin',...branches]);
  }
  async revParse(ref) { return (await this.git(['rev-parse',ref])).stdout; }
  async firstParentCommits(from, to) {
    const raw = (await this.git(['log','--first-parent','--reverse','--format=%H%x1f%P%x1f%an%x1f%s%x1f%b%x1e',`${from}..${to}`])).stdout;
    return raw.split('\x1e').map(record => record.replace(/^\n/,'')).filter(record => record.trim()).map(record => {
      const [sha,parents,author,subject,body] = record.split('\x1f');
      return {sha,parents:parents.split(' ').filter(Boolean),author,subject,body:(body || '').trim()};
    });
  }
  async commitDiff(sha, parent, limit = 8000) {
    const range = [parent || `${sha}^`,sha];
    const stat = (await this.git(['diff','--stat=120',...range])).stdout;
    const added = (await this.git(['diff','--name-only','--diff-filter=A',...range,'--','changelog'])).stdout.split('\n').filter(Boolean);
    const diff = (await this.git(['diff','--unified=2',...range,'--','.',':(exclude)package-lock.json',':(exclude)changelog',':(exclude)shared/changelog.ts'])).stdout;
    return {stat:stat.slice(-3000),diff:diff.slice(0,limit),addedChangelog:added};
  }
  async releaseWorktree(name, base) {
    await mkdir(this.worktrees, { recursive: true });
    const safe = name.replace(/[^a-zA-Z0-9_-]/g, '-');
    const path = join(this.worktrees, safe);
    const branch = `release/${safe}`;
    await this.git(['worktree','add','-b',branch,path,base]);
    return { path, branch };
  }
  async openPrs(base) {
    const result = await this.gh(['pr','list','--repo',this.config.githubRepo,'--base',base,'--state','open','--json','number,headRefName,headRefOid,body','--limit','50']);
    return JSON.parse(result.stdout || '[]');
  }
  async createPr(title, body, branch, base) {
    const result = await this.gh(['pr','create','--repo',this.config.githubRepo,'--base',base,'--head',branch,'--title',title,'--body',body]);
    return Number(result.stdout.match(/\/(\d+)\s*$/)?.[1]) || null;
  }
  async closePr(number, note) {
    await this.gh(['pr','close',String(number),'--repo',this.config.githubRepo,'--delete-branch','--comment',note]);
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
  async mergePr(number, expectedHead, base = this.config.baseBranch || 'develop') {
    const before = await this.prInfo(number);
    if (before.state === 'MERGED') return before.mergeCommit?.oid || null;
    if (before.baseRefName !== base) throw new Error(`PR #${number} targets ${before.baseRefName}`);
    if (before.headRefOid !== expectedHead) throw new Error(`PR #${number} head changed before merge`);
    await this.gh(['pr','merge',String(number),'--repo',this.config.githubRepo,'--merge','--match-head-commit',expectedHead]);
    const after = await this.prInfo(number);
    if (after.state !== 'MERGED') throw new Error(`PR #${number} is ${after.state}, expected MERGED`);
    return after.mergeCommit?.oid || null;
  }
}
