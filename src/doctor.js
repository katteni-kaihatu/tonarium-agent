import { existsSync } from 'node:fs';
import { getConfig, roles } from './config.js';
import { AI } from './ai.js';
import { command } from './command.js';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client, GatewayIntentBits, PermissionFlagsBits } from 'discord.js';

const config = getConfig();
const ai = new AI(config);
const checks = [
  ['Tonarium checkout', existsSync(config.repo), config.repo],
  ['Discord Bot token', Boolean(config.discordToken), 'DISCORD_TOKEN'],
  ['Discord feedback channel', Boolean(config.discordChannelId), config.discordChannelId],
  ['GitHub release branch', Boolean(config.baseBranch), config.baseBranch],
  ['Main release', true, config.mainReleaseIntervalMs ? `${config.baseBranch} → ${config.mainBranch} every ${config.mainReleaseIntervalMs / 60_000} minutes` : 'disabled']
];
try {
  for (const role of [...roles,{name:'通訳'}]) await ai.guidance(role.name);
  await ai.guidance('設計レビュー',{guide:'review'});
  checks.push(['Role Markdown guidance',true,'WORKFLOW.md, policy/guardrails.md and prompts/']);
} catch (error) { checks.push(['Role Markdown guidance',false,error.message]); }
if (config.translationProvider === 'openai') checks.push(['OpenAI translation key',Boolean(config.translationApiKey),'OPENAI_API_KEY']);
const providers = [config.intakeProvider,config.planningProvider,config.codingProvider,config.integrationProvider,config.translationProvider];
for (const executable of [...new Set(['git','gh',...providers].filter(x => x !== 'codex' && x !== 'openai'))]) {
  try { await command(executable,['--version'],{timeoutMs:10_000}); checks.push([`${executable} CLI`,true,'found']); }
  catch { checks.push([`${executable} CLI`,false,'not found or not executable']); }
}
const codexScript = join(dirname(dirname(fileURLToPath(import.meta.url))),'node_modules','@openai','codex','bin','codex.js');
try { const result = await command(process.execPath,[codexScript,'--version'],{timeoutMs:10_000}); checks.push(['Project Codex CLI',/0\.164\.0/.test(result.stdout),'gpt-6.1-sol compatible']); }
catch { checks.push(['Project Codex CLI',false,'run npm ci']); }
if (config.authMode === 'subscription' && providers.includes('claude')) {
  try {
    const result = await command('claude',['auth','status'],{timeoutMs:10_000});
    checks.push(['Claude subscription login',JSON.parse(result.stdout).loggedIn === true,'claude auth status']);
  } catch { checks.push(['Claude subscription login',false,'claude auth login']); }
}
if (config.authMode === 'subscription' && providers.includes('codex')) {
  try {
    const result = await command('codex',['login','status'],{timeoutMs:10_000});
    checks.push(['Codex subscription login',/Logged in/i.test(result.stdout + result.stderr),'codex login']);
  } catch { checks.push(['Codex subscription login',false,'codex login']); }
}
if (config.discordToken) {
  const bot = new Client({intents:[GatewayIntentBits.Guilds,GatewayIntentBits.GuildMessages,GatewayIntentBits.MessageContent]});
  try {
    await bot.login(config.discordToken);
    const channel = await bot.channels.fetch(config.discordChannelId);
    const member = await channel.guild.members.fetchMe();
    const permissions = channel.permissionsFor(member);
    for (const [name,flag] of [
      ['View Channel',PermissionFlagsBits.ViewChannel],
      ['Read Message History',PermissionFlagsBits.ReadMessageHistory],
      ['Send Messages',PermissionFlagsBits.SendMessages],
      ['Create Public Threads',PermissionFlagsBits.CreatePublicThreads],
      ['Send Messages in Threads',PermissionFlagsBits.SendMessagesInThreads],
      ['Manage Webhooks (posts as each agent)',PermissionFlagsBits.ManageWebhooks]
    ]) checks.push([`Discord ${name}`,permissions.has(flag),channel.name]);
    if (config.decisionForumId) {
      const forum = await bot.channels.fetch(config.decisionForumId).catch(() => null);
      checks.push(['Decision forum Manage Webhooks',Boolean(forum?.permissionsFor?.(member)?.has(PermissionFlagsBits.ManageWebhooks)),forum?.name || config.decisionForumId]);
    }
    if (config.releaseChannelId) {
      const releaseChannel = await bot.channels.fetch(config.releaseChannelId).catch(() => null);
      const releasePermissions = releaseChannel?.permissionsFor?.(member);
      for (const [name,flag] of [['View Channel',PermissionFlagsBits.ViewChannel],['Send Messages',PermissionFlagsBits.SendMessages],['Manage Webhooks',PermissionFlagsBits.ManageWebhooks]]) {
        checks.push([`Release channel ${name}`,Boolean(releasePermissions?.has(flag)),releaseChannel?.name || config.releaseChannelId]);
      }
    } else checks.push(['Release channel',true,'DISCORD_RELEASE_CHANNEL_ID is empty; main release results are not posted']);
  } catch { checks.push(['Discord Bot connection',false,'Check token, Message Content Intent and channel ID']); }
  finally { bot.destroy(); }
}
for (const [name,ok,detail] of checks) console.log(`${ok ? 'OK' : 'SETUP'}  ${name}: ${detail}`);
console.log(checks.every(([,ok]) => ok) ? '\nReady for live feedback.' : '\nComplete every SETUP item before connecting a live feedback channel.');
