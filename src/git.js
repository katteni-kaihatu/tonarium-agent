import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { command } from './command.js';

export class GitHub {
  constructor(config, root) { this.config = config; this.root = root; this.worktrees = join(root, '.worktrees'); }
  git(args, cwd = this.config.repo, options = {}) { return command('git', args, { cwd, ...options }); }
  gh(args, cwd = this.config.repo, options = {}) { return command('gh', args, { cwd, ...options }); }
  async prepare() {
    this.prepareLock = (this.prepareLock || Promise.resolve()).catch(() => {}).then(async () => {
      await mkdir(this.worktrees, { recursive: true });
      await this.git(['fetch','origin','main']);
      const remote = await this.git(['ls-remote','--heads','origin',this.config.nightlyBranch]);
      if (!remote.stdout) await this.git(['push','origin',`refs/remotes/origin/main:refs/heads/${this.config.nightlyBranch}`]);
      await this.git(['fetch','origin',this.config.nightlyBranch]);
    });
    return this.prepareLock;
  }
  async worktree(name, base = `origin/${this.config.nightlyBranch}`) {
    await mkdir(this.worktrees, { recursive: true });
    const path = join(this.worktrees, name.replace(/[^a-zA-Z0-9_-]/g, '-'));
    const branch = `agent/${name.replace(/[^a-zA-Z0-9_-]/g, '-')}`;
    await this.git(['worktree','add','-b',branch,path,base]);
    return { path, branch };
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
    const result = await this.gh(['pr','create','--repo',this.config.githubRepo,'--base',this.config.nightlyBranch,'--head',branch,'--title',title,'--body',body]);
    return Number(result.stdout.match(/\/(\d+)\s*$/)?.[1]) || null;
  }
  async closeIssue(number, note) {
    if (!number) return;
    await this.gh(['issue','close',String(number),'--repo',this.config.githubRepo,'--comment',note]);
  }
  async commitPush(path, branch, title) {
    const status = await this.git(['status','--porcelain'], path);
    if (!status.stdout) throw new Error('Agent made no code changes');
    await this.git(['add','-A'], path);
    await this.git(['commit','-m',title], path);
    await this.git(['push','-u','origin',branch], path);
  }
  async mergeInto(path, branch) {
    await this.git(['fetch','origin',branch], path);
    await this.git(['merge','--no-ff','--no-edit',`origin/${branch}`], path);
  }
  async pushNightly(path) {
    const sha = (await this.git(['rev-parse','HEAD'],path)).stdout;
    await this.git(['push','origin',`HEAD:refs/heads/${this.config.nightlyBranch}`],path);
    return sha;
  }
}
