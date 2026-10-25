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
        last_message_id TEXT, answered_message_id TEXT, parent_ticket_id TEXT, decision_thread_id TEXT, base_sha TEXT,
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
      CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
    if (!this.db.prepare('PRAGMA table_info(tickets)').all().some(column => column.name === 'base_sha')) this.db.exec('ALTER TABLE tickets ADD COLUMN base_sha TEXT');
    if (!this.db.prepare('PRAGMA table_info(tickets)').all().some(column => column.name === 'answered_message_id')) this.db.exec('ALTER TABLE tickets ADD COLUMN answered_message_id TEXT');
  }
  get(id) { return this.db.prepare('SELECT * FROM tickets WHERE id=?').get(id); }
  list() { return this.db.prepare('SELECT * FROM tickets ORDER BY updated_at DESC LIMIT 200').all(); }
  create(id, title, lastMessageId = '') {
    const now = Date.now();
    this.db.prepare('INSERT OR IGNORE INTO tickets (id,title,status,last_message_id,created_at,updated_at) VALUES (?,?,?,?,?,?)').run(id, title, 'intake', lastMessageId, now, now);
    return this.get(id);
  }
  update(id, patch) {
    const allowed = ['title','status','summary','criteria','issue_number','pr_number','branch','worker','last_message_id','answered_message_id','parent_ticket_id','decision_thread_id','base_sha','error'];
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
  setKv(key,value) { this.db.prepare('INSERT INTO kv (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key,String(value)); }
  recover() {
    this.db.exec("UPDATE tickets SET status='intake',worker=NULL WHERE status='planning'");
    this.db.exec("UPDATE tickets SET status='queued',worker=NULL WHERE status='coding'");
    this.db.exec("UPDATE tickets SET status='pr_ready',worker=NULL WHERE status='integrating'");
    this.db.exec("UPDATE releases SET status='interrupted',error='Process restarted during merge' WHERE status IN ('integrating','deploying','merging')");
  }
  close() { this.db.close(); }
}
