import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getConfig } from './config.js';
import { Store } from './store.js';
import { AI } from './ai.js';
import { GitHub } from './git.js';
import { DiscordTransport } from './discord.js';
import { Translator } from './translation.js';
import { Engine } from './engine.js';
import { Dashboard } from './dashboard.js';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const config = getConfig();
const store = new Store(join(root,'.data','state.sqlite'));
const ai = new AI(config);
const git = new GitHub(config,root);
const translator = new Translator(config,ai,root);
const discord = new DiscordTransport(config,store,translator);
let dashboard;
const engine = new Engine(config,store,ai,git,discord,() => dashboard?.notify());
dashboard = new Dashboard(config,store,engine,root);

let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  await engine.stop();
  await dashboard.stop();
  store.close();
  process.exit(0);
}
process.on('SIGINT',stop);
process.on('SIGTERM',stop);
process.on('unhandledRejection',error => console.error('Unhandled rejection:',error));

const url = await dashboard.start();
console.log(`Tonarium team dashboard: ${url}`);
if (!config.discordToken) console.log('Setup mode: add DISCORD_TOKEN to .env to connect Discord.');
await engine.start();
