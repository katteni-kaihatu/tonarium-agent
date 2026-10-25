import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from './store.js';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const store = new Store(join(root,'.data','state.sqlite'));
const script = join(root,'src','release-ready.js');
let running = false;
let retryAfter = 0;
let child = null;

async function tick() {
  if (running || Date.now() < retryAfter) return;
  if (!store.list().some(row => row.status === 'pr_ready' && row.pr_number && row.branch)) return;
  running = true;
  try {
    child = spawn(process.execPath,[script],{cwd:root,stdio:'inherit',windowsHide:true});
    const code = await new Promise((resolve,reject) => {
      child.once('error',reject);
      child.once('close',resolve);
    });
    if (code !== 0) retryAfter = Date.now() + 60_000;
  } catch (error) {
    console.error('Release worker:',error);
    retryAfter = Date.now() + 60_000;
  } finally {
    child = null;
    running = false;
  }
}

setInterval(() => tick().catch(error => console.error('Release poll:',error)),15_000);
tick().catch(error => console.error('Release poll:',error));
process.on('SIGINT',() => { child?.kill(); store.close(); process.exit(0); });
process.on('SIGTERM',() => { child?.kill(); store.close(); process.exit(0); });
