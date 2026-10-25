import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { roles } from './config.js';

const types = { '.html':'text/html; charset=utf-8', '.css':'text/css; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.svg':'image/svg+xml' };

export class Dashboard {
  constructor(config, store, engine, root) {
    Object.assign(this, { config, store, engine, root });
    this.clients = new Set();
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
        return { ...role, ticket: tickets.find(ticket => ticket.id === assigned || ticket.worker === role.id)?.title || tickets.find(ticket => status?.includes(ticket.status))?.title || (role.id === 'release' && this.engine.releasing ? 'PR を確認・マージ中' : '') };
      }),
      tickets,
      events: this.store.events(),
      releases,
      mainUrl: `https://github.com/${this.config.githubRepo}/tree/${this.config.baseBranch || 'main'}`,
      releaseBranch: this.config.baseBranch || 'main'
    };
  }
  notify() {
    const data = `data: ${JSON.stringify(this.state())}\n\n`;
    for (const client of this.clients) client.write(data);
  }
  async start() {
    this.server = createServer(async (request, response) => {
      const path = new URL(request.url, `http://${request.headers.host}`).pathname;
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
        const content = await readFile(join(this.root, 'public', file));
        response.writeHead(200, { 'Content-Type': types[extname(file)], 'Cache-Control':'no-cache', 'X-Content-Type-Options':'nosniff' });
        response.end(content);
      } catch { response.writeHead(500); response.end('Dashboard unavailable'); }
    });
    await new Promise(resolve => this.server.listen(this.config.port, this.config.host, resolve));
    return `http://${this.config.host}:${this.config.port}`;
  }
  async stop() { for (const client of this.clients) client.end(); await new Promise(resolve => this.server.close(resolve)); }
}
