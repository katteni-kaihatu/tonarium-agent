import { existsSync } from 'node:fs';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { roles } from './config.js';
import { command } from './command.js';

const roleName = id => roles.find(role => role.id === id)?.name || id;
const trim = (value, length = 1500) => String(value || '').slice(0, length);
const slugPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const maintenanceTag = '開発・保守';
const releaseBranchPrefix = 'release/main-';

export function tokyoStamp(now = Date.now()) {
  const iso = new Date(now + 9 * 3600_000).toISOString();
  return {date:iso.slice(0,10),hhmm:iso.slice(11,16).replace(':',''),label:`${iso.slice(0,10)} ${iso.slice(11,16)} JST`};
}

export function userFacingSection(body) {
  const lines = String(body || '').replace(/<!--[\s\S]*?-->/g,'').split(/\r?\n/);
  const start = lines.findIndex(line => /^##\s*利用者向けの変更/.test(line.trim()));
  if (start < 0) return [];
  const items = [];
  for (const line of lines.slice(start + 1)) {
    if (/^##\s/.test(line.trim())) break;
    const item = line.trim().replace(/^[-*]\s*/,'').trim();
    if (item && line.trim().match(/^[-*]\s/)) items.push(item);
  }
  return items.filter(item => !/^(なし|特になし|none|n\/a)$/i.test(item) && !item.startsWith('（実装担当の報告なし'));
}

export function prNumberFrom(subject) {
  return Number(String(subject).match(/^Merge pull request #(\d+)\b/)?.[1] || String(subject).match(/\(#(\d+)\)\s*$/)?.[1]) || null;
}

function validEntry(entry) {
  return entry && typeof entry.title === 'string' && entry.title.trim()
    && Array.isArray(entry.items) && entry.items.length && entry.items.every(item => typeof item === 'string' && item.trim())
    && (entry.tag === undefined || entry.tag === '' || (typeof entry.tag === 'string' && entry.tag.trim()));
}

export function fallbackEntries(units) {
  const entries = [], maintenance = [];
  for (const unit of units.filter(unit => !unit.recorded)) {
    if (unit.userFacing.length) entries.push({slug:unit.pr ? `pr-${unit.pr}` : `commit-${unit.sha.slice(0,7)}`,title:trim(unit.title,80),items:unit.userFacing.slice(0,6),units:[unit.id]});
    else maintenance.push(unit);
  }
  if (maintenance.length) entries.push({slug:'maintenance',title:'開発・保守の更新',items:maintenance.map(unit => trim(unit.title,120)).slice(0,10),tag:maintenanceTag,units:maintenance.map(unit => unit.id)});
  return entries;
}

// AI の返答を検証し、どの項目にも含まれなかった変更は保守の項目に回して取りこぼさない
export function normalizeEntries(raw, units) {
  const pending = new Set(units.filter(unit => !unit.recorded).map(unit => unit.id));
  const entries = [];
  for (const entry of Array.isArray(raw?.entries) ? raw.entries : []) {
    if (!validEntry(entry)) continue;
    const slug = String(entry.slug || '').toLowerCase().replace(/[^a-z0-9-]+/g,'-').replace(/^-+|-+$/g,'').replace(/-{2,}/g,'-').slice(0,40) || 'update';
    const covered = (Array.isArray(entry.units) ? entry.units : []).map(String).filter(id => pending.has(id));
    for (const id of covered) pending.delete(id);
    entries.push({slug:slugPattern.test(slug) ? slug : 'update',title:trim(entry.title.trim(),80),items:entry.items.map(item => trim(item.trim(),300)).slice(0,8),...(entry.tag && entry.tag.trim() ? {tag:trim(entry.tag.trim(),20)} : {}),units:covered});
  }
  const rest = units.filter(unit => pending.has(unit.id));
  if (rest.length) entries.push(...fallbackEntries(rest));
  return entries;
}

export function entryFiles(entries, now = Date.now()) {
  const {date,hhmm} = tokyoStamp(now);
  const used = new Set();
  return entries.map(entry => {
    let name = `${date}-rel${hhmm}-${entry.slug}`;
    for (let index = 2; used.has(name); index++) name = `${date}-rel${hhmm}-${entry.slug}-${index}`;
    used.add(name);
    const content = {date,title:entry.title,items:entry.items,...(entry.tag ? {tag:entry.tag} : {})};
    return {file:`${name}.json`,content,units:entry.units};
  });
}

export class MainRelease {
  constructor(config, store, ai, git, notify = async () => {}, onTicket = async () => {}) {
    Object.assign(this,{config,store,ai,git,notify,onTicket});
    this.main = config.mainBranch || 'main';
    this.develop = config.baseBranch || 'develop';
  }
  status(text) { this.store.setKv('main-release:status',text); }
  async run({ dryRun = false, now = Date.now(), log = console.log } = {}) {
    await this.git.fetchBranches(this.develop,this.main);
    const developHead = await this.git.revParse(`origin/${this.develop}`);
    const open = dryRun ? null : (await this.git.openPrs(this.main)).find(pr => String(pr.headRefName || '').startsWith(releaseBranchPrefix));
    if (open) {
      const snapshot = String(open.body || '').match(/Develop snapshot: ([0-9a-f]{40})/)?.[1] || '';
      if (snapshot && snapshot !== developHead && this.store.getKv('main-release:failed-snapshot') === snapshot) {
        await this.git.closePr(open.number,'develop が進んだため、新しいリリース PR で反映し直します。');
        log(`Closed stale release PR #${open.number}`);
      } else if (this.store.getKv('main-release:failed-snapshot') === snapshot) {
        log(`Release PR #${open.number} is still blocked`);
        return {status:'blocked'};
      } else return this.finish(open.number,open.headRefOid,snapshot,log);
    }
    const commits = await this.git.firstParentCommits(`origin/${this.main}`,developHead);
    if (!commits.length) { log('No develop changes to release.'); return {status:'skipped'}; }
    if (!dryRun && this.store.getKv('main-release:failed-snapshot') === developHead) { log('The same develop commit failed before; waiting for develop to change.'); return {status:'blocked'}; }
    let worktree;
    const stamp = tokyoStamp(now);
    try {
      this.status(`develop ${developHead.slice(0,8)} を main へ反映する準備中`);
      const units = await this.collect(commits);
      worktree = await this.git.releaseWorktree(`main-${stamp.date.replace(/-/g,'')}-${stamp.hhmm}-${developHead.slice(0,8)}`,`origin/${this.main}`);
      try { await this.git.git(['merge','--no-ff','-m',`Merge develop ${developHead.slice(0,8)} into ${this.main}`,developHead],worktree.path); }
      catch (error) {
        await this.git.git(['merge','--abort'],worktree.path).catch(() => {});
        throw new Error(`develop を ${this.main} にマージできません。${this.main} に develop にない変更があり競合しています。${this.main} → develop の PR で競合を解消してください: ${trim(error.message,400)}`);
      }
      const entries = await this.entries(units,worktree.path);
      const files = entryFiles(entries,now);
      if (dryRun) {
        log(JSON.stringify({developHead,units:units.map(({diff,...unit}) => unit),changelog:files.map(({file,content}) => ({file,...content}))},null,2));
        return {status:'dry-run',units,files};
      }
      for (const {file,content} of files) await writeFile(join(worktree.path,'changelog',file),`${JSON.stringify(content,null,2)}\n`);
      await this.validate(worktree.path,files.length ? 'release' : 'main');
      if (files.length) {
        await this.git.git(['add','--',...files.map(({file}) => `changelog/${file}`)],worktree.path);
        await this.git.git(['commit','-m',`docs: record changes for the ${stamp.label} release`],worktree.path);
      }
      await this.git.pushWithRetry(worktree.path,worktree.branch);
      const head = (await this.git.git(['rev-parse','HEAD'],worktree.path)).stdout;
      const prs = units.map(unit => unit.pr).filter(Boolean);
      const body = `develop の変更を main に反映します。Tonarium Agent のリリース担当（${roleName('mainrelease')}）が作成しました。\n\n## 追加した変更履歴\n\n${files.length ? files.map(({file,content}) => `- ${content.title}（changelog/${file}）`).join('\n') : '- なし（すべて記録済み）'}\n\n## 含まれる変更\n\n${units.map(unit => `- ${unit.pr ? `#${unit.pr} ` : `${unit.sha.slice(0,8)} `}${unit.title}${unit.recorded ? '（旧運用で履歴を記録済み）' : ''}`).join('\n')}\n\nDevelop snapshot: ${developHead}\nPRs: ${prs.join(',')}`;
      const number = await this.git.createPr(`Release develop ${developHead.slice(0,8)} to ${this.main} (${stamp.label})`,body,worktree.branch,this.main);
      if (!number) throw new Error('Could not create the release PR');
      log(`Opened release PR #${number}`);
      return await this.finish(number,head,developHead,log,{files,units});
    } catch (error) {
      if (!dryRun) await this.failed(developHead,error);
      throw error;
    } finally {
      if (worktree) {
        await this.git.removeWorktree(worktree.path);
        // push 済みならリモートに残るので、手元のブランチは毎回消す
        await this.git.git(['branch','-D',worktree.branch]).catch(() => {});
      }
      this.status('');
    }
  }
  async collect(commits) {
    const limit = commits.length > 20 ? 2000 : 8000;
    const units = [];
    for (const [index,commit] of commits.entries()) {
      const pr = prNumberFrom(commit.subject);
      const details = pr ? await this.git.prDetails(pr).catch(() => null) : null;
      const diff = await this.git.commitDiff(commit.sha,commit.parents[0],limit);
      units.push({
        id:`u${index + 1}`,sha:commit.sha,pr,author:details?.author || commit.author,
        // GitHub のマージ commit は件名が定型文で、PR のタイトルは本文の1行目に入る
        title:trim(details?.title || (/^Merge pull request #/.test(commit.subject) && commit.body.split('\n')[0].trim()) || commit.subject,200),
        userFacing:userFacingSection(details?.body),
        body:trim(details?.body || commit.body,1500),
        files:diff.stat,diff:diff.diff,
        recorded:diff.addedChangelog.length > 0
      });
    }
    return units;
  }
  async recent(path) {
    const files = (await readdir(join(path,'changelog')).catch(() => [])).filter(file => file.endsWith('.json')).sort().slice(-15);
    const titles = [];
    for (const file of files) {
      try { titles.push(`${file}: ${JSON.parse(await readFile(join(path,'changelog',file),'utf8')).title}`); } catch { /* skip unreadable entries */ }
    }
    return titles;
  }
  async entries(units, path) {
    if (!units.some(unit => !unit.recorded)) return [];
    try {
      const raw = await this.ai.ask(roleName('mainrelease'), `main への反映に含まれる変更から、利用者向けの変更履歴を機能ごとに作ってください。
- 同じ機能に関する変更（追加と、その後の修正など）は一つの項目にまとめる。
- PR の「利用者向けの変更」欄（userFacing）があれば優先する。なければタイトル・本文・差分から、利用者に分かる言葉で最低限の内容を書く。差分から確かめられない効果を書き足さない。
- 利用者に見えない変更（CI、テスト、文書、リファクタリング、開発ツール）は tag="${maintenanceTag}" の一つの項目にまとめる。
- recorded=true の変更は旧運用で履歴が記録済みなので、項目にしない。
- 同じ範囲で追加と取り消し（revert）がそろった変更は記載しない。すでに main にある機能を取り消した場合は、取り下げとして記載する。
- 直近の履歴と同じ内容を繰り返さない。続きの改善なら、何が良くなったかを書く。
- slug は機能を表す英小文字・数字・ハイフンの短い名前。units には、その項目にまとめた変更の id をすべて入れる。
返す JSON: {"entries":[{"slug":"camera-timer","title":"短い見出し","items":["利用者から見た変更"],"tag":"任意","units":["u1"]}]}

直近の履歴: ${JSON.stringify(await this.recent(path))}
変更: ${JSON.stringify(units)}`, {provider:this.config.planningProvider,cwd:path,repoReadOnly:true,timeoutMs:10 * 60_000});
      return normalizeEntries(raw,units);
    } catch (error) {
      this.store.event(null,roleName('mainrelease'),'changelog_fallback',trim(`変更履歴の生成に失敗したため、PR のタイトルと記載から作成: ${error.message}`,500));
      return fallbackEntries(units);
    }
  }
  async validate(path, mode) {
    const script = join(path,'scripts','check-changelog.mjs');
    if (!existsSync(script)) return;
    await command(process.execPath,[script,'--mode',mode,'--base',`origin/${this.main}`],{cwd:path,timeoutMs:60_000});
  }
  async finish(number, head, snapshot, log, { files = [], units = [] } = {}) {
    try {
      this.status(`リリース PR #${number} のチェックを待っています`);
      await this.git.waitForChecks(number,head);
      const sha = await this.git.mergePr(number,head,this.main);
      const prs = units.length ? units.map(unit => unit.pr).filter(Boolean) : await this.prsFromBody(number);
      const tickets = this.store.byPr(prs);
      for (const ticket of tickets) {
        this.store.setKv(`main-released:${ticket.id}`,'1');
        this.store.setKv(`thread-status-dirty:${ticket.id}`,'1');
        this.store.event(ticket.id,roleName('mainrelease'),'main_released',`main に反映: リリース PR #${number}`);
        await this.onTicket(ticket.id).catch(error => console.error('Thread status after main release:',error));
      }
      const id = this.store.release('main_merged',tickets.map(ticket => ticket.id));
      this.store.updateRelease(id,{commit_sha:sha || null,url:`https://github.com/${this.config.githubRepo}/pull/${number}`});
      this.store.setKv('main-release:failed-snapshot','');
      this.store.setKv('main-release:last-error','');
      log(`Merged release PR #${number}`);
      const list = files.length ? `\n${files.map(({content}) => `- ${content.title}`).join('\n')}` : '';
      await this.notify(`develop の変更を ${this.main} に反映しました（PR #${number}）。${list}`).catch(error => console.error('Release notification:',error));
      return {status:'merged',number,sha};
    } catch (error) {
      await this.failed(snapshot,error,number);
      throw error;
    }
  }
  async prsFromBody(number) {
    const info = await this.git.prDetails(number).catch(() => null);
    return String(info?.body || '').match(/^PRs: ([\d,]*)$/m)?.[1].split(',').map(Number).filter(Boolean) || [];
  }
  async failed(snapshot, error, number = null) {
    if (this.store.getKv('main-release:failed-snapshot') === snapshot && number === null) return;
    this.store.setKv('main-release:failed-snapshot',snapshot || '');
    const message = trim(error.message,800);
    this.store.event(null,roleName('mainrelease'),'main_release_failed',message);
    // 同じ理由で止まり続けるときは一度だけ知らせる
    if (this.store.getKv('main-release:last-error') === message) return;
    this.store.setKv('main-release:last-error',message);
    await this.notify(`${this.main} への反映を止めました。${number ? `リリース PR #${number}: https://github.com/${this.config.githubRepo}/pull/${number}\n` : ''}理由: ${message}\ndevelop が更新されたら自動で作り直します。`,{mention:true}).catch(notifyError => console.error('Release notification:',notifyError));
  }
}
