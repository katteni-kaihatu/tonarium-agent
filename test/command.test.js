import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanModelEnv } from '../src/command.js';

test('subscription mode keeps Discord and Coolify credentials out of model processes and does not use API keys', () => {
  const result = cleanModelEnv({ PATH:'path', DISCORD_TOKEN:'private', COOLIFY_API_TOKEN:'private', OPENAI_API_KEY:'private', ANTHROPIC_API_KEY:'private' });
  assert.deepEqual(result,{PATH:'path'});
});
