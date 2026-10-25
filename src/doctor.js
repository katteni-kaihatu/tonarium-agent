import { existsSync } from 'node:fs';
import { getConfig } from './config.js';
import { command } from './command.js';

const config = getConfig();
const checks = [
  ['Tonarium checkout', existsSync(config.repo), config.repo],
  ['Discord Bot token', Boolean(config.discordToken), 'DISCORD_TOKEN'],
  ['Discord feedback channel', Boolean(config.discordChannelId), config.discordChannelId],
  ['Coolify webhook', Boolean(config.coolifyWebhook), 'COOLIFY_DEPLOY_WEBHOOK'],
  ['Coolify API token', Boolean(config.coolifyToken), 'COOLIFY_API_TOKEN'],
  ['Coolify API base', Boolean(config.coolifyApiBase), 'COOLIFY_API_BASE'],
  ['Web nightly URL', Boolean(config.nightlyUrl), 'NIGHTLY_URL']
];
for (const executable of ['git','gh',config.planningProvider,config.codingProvider]) {
  try { await command(executable,['--version'],{timeoutMs:10_000}); checks.push([`${executable} CLI`,true,'found']); }
  catch { checks.push([`${executable} CLI`,false,'not found or not executable']); }
}
for (const [name,ok,detail] of checks) console.log(`${ok ? 'OK' : 'SETUP'}  ${name}: ${detail}`);
console.log('\nComplete every SETUP item before connecting a live feedback channel.');
