import 'dotenv/config';
import { resolve } from 'node:path';

const number = (value, fallback) => Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : fallback;
const nonNegativeNumber = (value, fallback) => value !== undefined && value !== '' && Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : fallback;
const defaultRoles = [
  { id: 'intake', name: 'ひより', job: '聞き取り', color: 'mint' },
  { id: 'pm', name: 'さくら', job: 'PM', color: 'rose' },
  { id: 'lead', name: 'あおい', job: '開発リード', color: 'blue' },
  { id: 'builder1', name: 'そら', job: '実装', color: 'blue' },
  { id: 'builder2', name: 'ゆず', job: '実装', color: 'blue' },
  { id: 'builder3', name: 'もも', job: '実装', color: 'blue' },
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
    maxWorkers: Math.min(3, Math.max(1, number(env.MAX_WORKERS, 3))),
    batchMs: nonNegativeNumber(env.RELEASE_BATCH_MINUTES, 0) * 60_000,
    checksTimeoutMs: number(env.CHECKS_TIMEOUT_MINUTES || env.RELEASE_TIMEOUT_MINUTES, 20) * 60_000,
    requiredPrCheck: env.REQUIRED_PR_CHECK || 'web',
    autoRelease: env.AUTO_RELEASE !== 'false'
  };
}
