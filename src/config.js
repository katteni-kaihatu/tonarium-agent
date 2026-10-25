import 'dotenv/config';
import { resolve } from 'node:path';

const number = (value, fallback) => Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : fallback;
const nonNegativeNumber = (value, fallback) => value !== undefined && value !== '' && Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : fallback;
const namedPool = (prefix, names, job, color) => names.map((name,index) => ({id:index ? `${prefix}${index+1}` : prefix,name,job,color}));
const defaultRoles = [
  ...namedPool('intake',['ひより','こはる','みお','りん','ほのか'],'聞き取り','mint'),
  { id: 'pm', name: 'さくら', job: 'PM', color: 'rose' },
  ...namedPool('lead',['あおい','かえで','まこと','なぎ','つばさ'],'開発リード','blue'),
  ...['そら','ゆず','もも','はる','かなた','ふう','きい','あかり','ひなた','しおり','れん','さつき','いおり','みなと','こよみ'].map((name,index) => ({id:`builder${index+1}`,name,job:'実装',color:'blue'})),
  { id: 'support', name: 'あん', job: '実装案内', color: 'mint' },
  { id: 'integrator', name: 'すず', job: '統合', color: 'violet' },
  { id: 'release', name: 'みのり', job: '出荷', color: 'gold' }
];
let customNames = {};
try { customNames = JSON.parse(process.env.TONARIUM_TEAM_NAMES || '{}'); } catch { /* keep defaults */ }
export const roles = defaultRoles.map(role => ({ ...role, name: typeof customNames[role.id] === 'string' ? customNames[role.id].slice(0,20) : role.name }));

export function getConfig(env = process.env) {
  return {
    discordToken: env.DISCORD_TOKEN || '',
    discordChannelId: env.DISCORD_CHANNEL_ID || '',
    decisionForumId: env.DISCORD_DECISION_FORUM_ID || '',
    decisionMentionId: env.DISCORD_DECISION_MENTION_ID || '',
    repo: resolve(env.TONARIUM_REPO || 'C:/Users/neo/GitHub/tonarium-prototype'),
    githubRepo: env.GITHUB_REPO || 'katteni-kaihatu/tonarium-prototype',
    baseBranch: env.RELEASE_BRANCH || 'main',
    planningProvider: env.PLANNING_PROVIDER || 'claude',
    codingProvider: env.CODING_PROVIDER || 'codex',
    integrationProvider: env.INTEGRATION_PROVIDER || 'codex',
    translationProvider: env.TRANSLATION_PROVIDER || 'claude',
    translationModel: env.TRANSLATION_MODEL || 'gpt-6-luna',
    translationApiKey: env.OPENAI_API_KEY || '',
    authMode: env.AGENT_AUTH_MODE || 'subscription',
    codexModel: env.CODEX_MODEL || 'gpt-6.1-sol',
    codexSpeed: env.CODEX_SPEED || 'fast',
    codexReasoning: env.CODEX_REASONING_EFFORT || 'medium',
    host: env.HOST || '127.0.0.1',
    port: number(env.PORT, 43879),
    maxWorkers: Math.min(15, Math.max(1, number(env.MAX_WORKERS, 15))),
    batchMs: nonNegativeNumber(env.RELEASE_BATCH_MINUTES, 0) * 60_000,
    checksTimeoutMs: number(env.CHECKS_TIMEOUT_MINUTES || env.RELEASE_TIMEOUT_MINUTES, 20) * 60_000,
    requiredPrCheck: env.REQUIRED_PR_CHECK || 'web',
    autoRelease: env.AUTO_RELEASE !== 'false'
  };
}
