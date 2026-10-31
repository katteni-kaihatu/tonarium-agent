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
import { AdminAuth } from './auth.js';
import { AdminConsole } from './admin.js';
import { applySettings, aiHooks } from './settings.js';
import { setAvatarBaseUrl, setSpeechPolisher, setAvatarRoot } from './poster.js';
import { SpeechPolisher } from './speech.js';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const config = getConfig();
const store = new Store(join(root,'.data','state.sqlite'));
const auth = new AdminAuth(config, store);
// 人格プロンプトとプロンプト上書きは DB（管理画面）が正本。AI にはフックで渡す
const ai = new AI(config, root, aiHooks(store));
// メンバー/人格の設定を roles へ反映してから各部品を作る
applySettings(store, config);
setAvatarBaseUrl(`${config.adminPublicUrl || 'https://tonarium-agent.kokopi.me'}/avatars`);
setAvatarRoot(root);
setSpeechPolisher(new SpeechPolisher(ai, aiHooks(store), { cwd: root }));
const git = new GitHub(config,root);
const translator = new Translator(config,ai,root);
const discord = new DiscordTransport(config,store,translator);
let dashboard;
const engine = new Engine(config,store,ai,git,discord,() => dashboard?.notify());
const adminConsole = new AdminConsole(config, store, auth, {
  dataRoot: join(root,'.data'),
  publicRoot: root,
  // メンバー構成が変わったら、稼働中エンジンのロール使用状況も追随させる
  onChange: () => { engine.reconcileRoles(); dashboard?.notify(); }
});
dashboard = new Dashboard(config,store,engine,root,adminConsole);

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
