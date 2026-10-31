import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { statSync } from 'node:fs';
import { join, extname } from 'node:path';
import { roles } from './config.js';

const types = { '.html':'text/html; charset=utf-8', '.css':'text/css; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.svg':'image/svg+xml' };

export class Dashboard {
  constructor(config, store, engine, root, admin = null) {
    Object.assign(this, { config, store, engine, root, admin });
    this.clients = new Set();
  }
  // アイコン画像の版数。管理画面で差し替えたファイル（.data/avatars 優先、無ければ
  // public/avatars）を stat し、サイズと更新時刻を版数にする。ブラウザは版数付き
  // URL で取得するので、差し替えると URL が変わり、古いキャッシュが表示され続けない。
  avatarVersion(role) {
    const filename = `${role.avatarId || role.id}.png`;
    if (!/^[a-zA-Z0-9_-]+\.png$/.test(filename)) return '';
    for (const candidate of [join(this.root, '.data', 'avatars', filename), join(this.root, 'public', 'avatars', filename)]) {
      try {
        const stat = statSync(candidate);
        if (stat.isFile()) return `${stat.size}-${Math.round(stat.mtimeMs)}`;
      } catch { /* 次の候補へ */ }
    }
    return '';
  }
  state() {
    const tickets = this.store.list().map(row => ({ ...row, criteria: JSON.parse(row.criteria || '[]') }));
    const releases = this.store.releases().map(row => ({ ...row, tickets: JSON.parse(row.tickets || '[]') }));
    return {
      title: 'TONARIUM / AGENT STUDIO',
      mode: this.config.discordToken ? 'live' : 'setup',
      time: Date.now(),
      roles: roles.map(role => {
        const status = { pm:['planning','decision'], integrator:['integrating'], release:['pr_ready'] }[role.id];
        const assigned = this.engine.roleBusy.get(role.id);
        const avatarVersion = this.avatarVersion(role);
        if (role.id === 'mainrelease') return { ...role, avatarVersion, ticket: this.store.getKv('main-release:status') || '' };
        return { ...role, avatarVersion, ticket: tickets.find(ticket => ticket.id === assigned || ticket.worker === role.id)?.title || tickets.find(ticket => status?.includes(ticket.status))?.title || (role.id === 'release' && this.engine.releasing ? 'PR を確認・マージ中' : '') };
      }),
      tickets,
      events: this.store.events(),
      releases,
      mainUrl: `https://github.com/${this.config.githubRepo}/tree/${this.config.baseBranch || 'develop'}`,
      releaseBranch: this.config.baseBranch || 'develop'
    };
  }
  notify() {
    const data = `data: ${JSON.stringify(this.state())}\n\n`;
    for (const client of this.clients) client.write(data);
  }
  async start() {
    this.server = createServer(async (request, response) => {
      const url = new URL(request.url, `http://${request.headers.host}`);
      const path = url.pathname;
      // 管理画面・管理API・アバター配信は AdminConsole が担当する（認証はそちら側）
      if (this.admin && (path.startsWith('/admin') || path.startsWith('/api/admin/') || path.startsWith('/avatars/'))) {
        try { if (await this.admin.handle(request, response, url)) return; }
        catch (error) { console.error('Admin console error:', error); if (!response.headersSent) { response.writeHead(500); response.end('Admin unavailable'); } return; }
      }
      if (path === '/api/state') {
        response.writeHead(200, { 'Content-Type':'application/json; charset=utf-8', 'Cache-Control':'no-store' });
        response.end(JSON.stringify(this.state()));
        return;
      }
      if (path === '/api/events') {
        response.writeHead(200, { 'Content-Type':'text/event-stream; charset=utf-8', 'Cache-Control':'no-cache', Connection:'keep-alive' });
        response.write(`data: ${JSON.stringify(this.state())}\n\n`);
        this.clients.add(response);
        request.on('close', () => this.clients.delete(response));
        return;
      }
      const file = path === '/' ? 'index.html' : path.slice(1);
      if (!['index.html','style.css','app.js'].includes(file)) { response.writeHead(404); response.end('Not found'); return; }
      try {
        let content = await readFile(join(this.root, 'public', file));
        // Misskey は OAuth の client_id（公開オリジンのトップページ）を読みに来て、
        // redirect_uri の link タグが宣言されているかを確認する。無いと認可が
        // "Invalid redirect_uri" で失敗する（tonarium 本体の __ORIGIN__ 置換と同じ仕組み）。
        // ADMIN_PUBLIC_URL が固定値なので、配信時にそのオリジンで差し込む。
        if (file === 'index.html' && this.config.adminPublicUrl) {
          const link = `<link rel="redirect_uri" href="${this.config.adminPublicUrl}/admin/auth/callback" />`;
          content = Buffer.from(content.toString('utf8').replace('</head>', `${link}</head>`));
        }
        response.writeHead(200, { 'Content-Type': types[extname(file)], 'Cache-Control':'no-cache', 'X-Content-Type-Options':'nosniff' });
        response.end(content);
      } catch { response.writeHead(500); response.end('Dashboard unavailable'); }
    });
    await new Promise(resolve => this.server.listen(this.config.port, this.config.host, resolve));
    return `http://${this.config.host}:${this.config.port}`;
  }
  async stop() { for (const client of this.clients) client.end(); await new Promise(resolve => this.server.close(resolve)); }
}
