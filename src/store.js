import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export class Store {
  constructor(file) {
    mkdirSync(dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec(`PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS tickets (
        id TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT '', status TEXT NOT NULL,
        summary TEXT NOT NULL DEFAULT '', criteria TEXT NOT NULL DEFAULT '[]',
        issue_number INTEGER, pr_number INTEGER, branch TEXT, worker TEXT,
        last_message_id TEXT, answered_message_id TEXT, parent_ticket_id TEXT, decision_thread_id TEXT, base_sha TEXT, merged_branch TEXT,
        error TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT, ticket_id TEXT, actor TEXT NOT NULL,
        kind TEXT NOT NULL, text TEXT NOT NULL, created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS releases (
        id INTEGER PRIMARY KEY AUTOINCREMENT, status TEXT NOT NULL, commit_sha TEXT,
        deployment_id TEXT, tickets TEXT NOT NULL DEFAULT '[]', url TEXT, error TEXT,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS admin_users (
        misskey_id TEXT PRIMARY KEY, username TEXT, display_name TEXT,
        permissions TEXT NOT NULL DEFAULT '[]', created_by TEXT,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS admin_sessions (
        token_hash TEXT PRIMARY KEY, misskey_id TEXT NOT NULL,
        expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS ticket_rounds (
        ticket_id TEXT NOT NULL, round INTEGER NOT NULL, title TEXT NOT NULL DEFAULT '', summary TEXT NOT NULL DEFAULT '',
        criteria TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL, issue_number INTEGER, pr_number INTEGER, branch TEXT,
        merged_branch TEXT, created_at INTEGER NOT NULL, PRIMARY KEY (ticket_id, round)
      );`);
    if (!this.db.prepare('PRAGMA table_info(tickets)').all().some(column => column.name === 'base_sha')) this.db.exec('ALTER TABLE tickets ADD COLUMN base_sha TEXT');
    if (!this.db.prepare('PRAGMA table_info(tickets)').all().some(column => column.name === 'answered_message_id')) this.db.exec('ALTER TABLE tickets ADD COLUMN answered_message_id TEXT');
    if (!this.db.prepare('PRAGMA table_info(tickets)').all().some(column => column.name === 'round')) this.db.exec('ALTER TABLE tickets ADD COLUMN round INTEGER NOT NULL DEFAULT 1');
    if (!this.db.prepare('PRAGMA table_info(tickets)').all().some(column => column.name === 'merged_branch')) {
      this.db.exec("ALTER TABLE tickets ADD COLUMN merged_branch TEXT; UPDATE tickets SET merged_branch='main' WHERE status='merged'");
    }
  }
  get(id) { return this.db.prepare('SELECT * FROM tickets WHERE id=?').get(id); }
  // 同じミリ秒に更新された行同士は rowid の降順で安定させる（新しい案件が先に来る）
  list() { return this.db.prepare('SELECT * FROM tickets ORDER BY updated_at DESC, rowid DESC LIMIT 200').all(); }
  byStatus(statuses) {
    if (!statuses.length) return [];
    return this.db.prepare(`SELECT * FROM tickets WHERE status IN (${statuses.map(() => '?').join(',')}) ORDER BY updated_at ASC`).all(...statuses);
  }
  byPr(numbers) {
    if (!numbers.length) return [];
    const marks = numbers.map(() => '?').join(',');
    const current = this.db.prepare(`SELECT id FROM tickets WHERE pr_number IN (${marks})`).all(...numbers);
    const past = this.db.prepare(`SELECT ticket_id AS id FROM ticket_rounds WHERE pr_number IN (${marks})`).all(...numbers);
    return [...new Set([...current,...past].map(row => row.id))].map(id => this.get(id)).filter(Boolean);
  }
  rounds(id) { return this.db.prepare('SELECT * FROM ticket_rounds WHERE ticket_id=? ORDER BY round ASC').all(id); }
  archiveRound(ticket) {
    this.db.prepare('INSERT OR REPLACE INTO ticket_rounds (ticket_id,round,title,summary,criteria,status,issue_number,pr_number,branch,merged_branch,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
      .run(ticket.id,ticket.round || 1,ticket.title,ticket.summary,ticket.criteria,ticket.status,ticket.issue_number ?? null,ticket.pr_number ?? null,ticket.branch ?? null,ticket.merged_branch ?? null,Date.now());
  }
  markRoundsMerged(id,numbers,branch) {
    if (!numbers.length) return;
    this.db.prepare(`UPDATE ticket_rounds SET merged_branch=? WHERE ticket_id=? AND pr_number IN (${numbers.map(() => '?').join(',')})`).run(branch,id,...numbers);
  }
  create(id, title, lastMessageId = '') {
    const now = Date.now();
    this.db.prepare('INSERT OR IGNORE INTO tickets (id,title,status,last_message_id,created_at,updated_at) VALUES (?,?,?,?,?,?)').run(id, title, 'intake', lastMessageId, now, now);
    return this.get(id);
  }
  update(id, patch) {
    const allowed = ['title','status','summary','criteria','issue_number','pr_number','branch','worker','last_message_id','answered_message_id','parent_ticket_id','decision_thread_id','base_sha','merged_branch','error','round'];
    const entries = Object.entries(patch).filter(([key]) => allowed.includes(key));
    if (!entries.length) return this.get(id);
    const sql = entries.map(([key]) => `${key}=?`).join(',');
    this.db.prepare(`UPDATE tickets SET ${sql},updated_at=? WHERE id=?`).run(...entries.map(([, value]) => value), Date.now(), id);
    return this.get(id);
  }
  event(ticketId, actor, kind, message) {
    this.db.prepare('INSERT INTO events (ticket_id,actor,kind,text,created_at) VALUES (?,?,?,?,?)').run(ticketId, actor, kind, String(message).slice(0, 2000), Date.now());
  }
  events(limit = 100) { return this.db.prepare('SELECT * FROM events ORDER BY id DESC LIMIT ?').all(limit); }
  latestEvent(ticketId,kind) { return this.db.prepare('SELECT * FROM events WHERE ticket_id=? AND kind=? ORDER BY id DESC LIMIT 1').get(ticketId,kind); }
  release(status, tickets = []) {
    const now = Date.now();
    return Number(this.db.prepare('INSERT INTO releases (status,tickets,created_at,updated_at) VALUES (?,?,?,?)').run(status, JSON.stringify(tickets), now, now).lastInsertRowid);
  }
  updateRelease(id, patch) {
    const entries = Object.entries(patch).filter(([key]) => ['status','commit_sha','deployment_id','tickets','url','error'].includes(key));
    if (!entries.length) return;
    this.db.prepare(`UPDATE releases SET ${entries.map(([key]) => `${key}=?`).join(',')},updated_at=? WHERE id=?`).run(...entries.map(([,value]) => value), Date.now(), id);
  }
  releases() { return this.db.prepare('SELECT * FROM releases ORDER BY id DESC LIMIT 20').all(); }
  getKv(key) { return this.db.prepare('SELECT value FROM kv WHERE key=?').get(key)?.value; }
  listKv(prefix) { return this.db.prepare('SELECT key,value FROM kv WHERE key LIKE ? ORDER BY key ASC').all(`${prefix}%`); }
  setKv(key,value) { this.db.prepare('INSERT INTO kv (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key,String(value)); }
  deleteKv(key) { this.db.prepare('DELETE FROM kv WHERE key=?').run(key); }
  listAdmins() { return this.db.prepare('SELECT * FROM admin_users ORDER BY created_at ASC').all(); }
  getAdmin(id) { return this.db.prepare('SELECT * FROM admin_users WHERE misskey_id=?').get(id); }
  upsertAdmin({ misskeyId, username = null, displayName = null, permissions, createdBy = null }) {
    const now = Date.now();
    const existing = this.getAdmin(misskeyId);
    if (existing) {
      // プロフィールは新しい値が来たときだけ更新し、権限は明示指定があるときだけ差し替える
      this.db.prepare('UPDATE admin_users SET username=?,display_name=?,permissions=?,updated_at=? WHERE misskey_id=?')
        .run(username ?? existing.username, displayName ?? existing.display_name,
          permissions !== undefined ? JSON.stringify(permissions) : existing.permissions, now, misskeyId);
    } else {
      this.db.prepare('INSERT INTO admin_users (misskey_id,username,display_name,permissions,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?)')
        .run(misskeyId, username, displayName, JSON.stringify(permissions ?? []), createdBy, now, now);
    }
    return this.getAdmin(misskeyId);
  }
  deleteAdmin(id) { this.db.prepare('DELETE FROM admin_users WHERE misskey_id=?').run(id); }
  createAdminSession(tokenHash, misskeyId, expiresAt) {
    this.db.prepare('INSERT INTO admin_sessions (token_hash,misskey_id,expires_at,created_at) VALUES (?,?,?,?)')
      .run(tokenHash, misskeyId, expiresAt, Date.now());
  }
  adminSession(tokenHash) {
    if (!tokenHash) return undefined;
    const row = this.db.prepare('SELECT s.token_hash,s.misskey_id,s.expires_at,u.username,u.display_name,u.permissions FROM admin_sessions s LEFT JOIN admin_users u ON u.misskey_id=s.misskey_id WHERE s.token_hash=?').get(tokenHash);
    if (!row) return undefined;
    if (row.expires_at <= Date.now()) { this.deleteAdminSession(tokenHash); return undefined; }
    return row;
  }
  deleteAdminSession(tokenHash) { this.db.prepare('DELETE FROM admin_sessions WHERE token_hash=?').run(tokenHash); }
  recover() {
    this.db.exec("UPDATE tickets SET status='intake',worker=NULL WHERE status='planning'");
    this.db.exec("UPDATE tickets SET status='queued',worker=NULL WHERE status='coding'");
    this.db.exec("UPDATE tickets SET status='pr_ready',worker=NULL WHERE status='integrating'");
    this.db.exec("UPDATE releases SET status='interrupted',error='Process restarted during merge' WHERE status IN ('integrating','deploying','merging')");
  }
  close() { this.db.close(); }
}
