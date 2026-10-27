import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getConfig } from './config.js';
import { Store } from './store.js';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const config = getConfig();
const store = new Store(join(root,'.data','state.sqlite'));
const children = new Set();

function lane(script, due) {
  const state = {running:false,retryAfter:0,lastStart:0};
  return async () => {
    if (state.running || Date.now() < state.retryAfter || !due(state)) return;
    state.running = true;
    state.lastStart = Date.now();
    try {
      const child = spawn(process.execPath,[join(root,'src',script)],{cwd:root,stdio:'inherit',windowsHide:true});
      children.add(child);
      const code = await new Promise((resolve,reject) => {
        child.once('error',reject);
        child.once('close',resolve);
      }).finally(() => children.delete(child));
      if (code !== 0) state.retryAfter = Date.now() + 60_000;
    } catch (error) {
      console.error(`${script}:`,error);
      state.retryAfter = Date.now() + 60_000;
    } finally {
      state.running = false;
    }
  };
}

const developLane = lane('release-ready.js',() => store.byStatus(['pr_ready']).some(row => row.pr_number && row.branch));
// main への反映は前回の開始から間隔を空ける。前回が長引いた場合は終わってから次を始める
const mainLane = lane('release-main.js',state => config.mainReleaseIntervalMs > 0 && Date.now() - state.lastStart >= config.mainReleaseIntervalMs);

function tick() {
  developLane().catch(error => console.error('Release poll:',error));
  mainLane().catch(error => console.error('Main release poll:',error));
}
setInterval(tick,15_000);
tick();
function stop() { for (const child of children) child.kill(); store.close(); process.exit(0); }
process.on('SIGINT',stop);
process.on('SIGTERM',stop);
