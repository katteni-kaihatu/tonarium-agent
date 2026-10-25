import test from 'node:test';
import assert from 'node:assert/strict';
import { Translator } from '../src/translation.js';

test('Codex subscription translator returns and caches Japanese, English and Korean', async () => {
  let calls = 0;
  const ai = { ask: async (_role,_prompt,options) => { assert.equal(options.provider,'codex'); calls++; return {ja:'こんにちは',en:'Hello',ko:'안녕하세요'}; } };
  const translator = new Translator({translationProvider:'codex'},ai,process.cwd());
  assert.deepEqual(await translator.translate('こんにちは'),{ja:'こんにちは',en:'Hello',ko:'안녕하세요'});
  await translator.translate('こんにちは');
  assert.equal(calls,1);
});

test('OpenAI translation uses only its configured API key and structured output', async () => {
  const observed = [];
  const clientFactory = options => ({responses:{create:async request => {
    observed.push({key:options.apiKey,request});
    return {output_text:JSON.stringify({ja:'こんにちは',en:'Hello',ko:'안녕하세요'})};
  }}});
  const translator = new Translator({translationProvider:'openai',translationApiKey:'test-key',translationModel:'gpt-6-luna'},null,process.cwd(),clientFactory);
  assert.equal((await translator.translate('Hello')).ko,'안녕하세요');
  assert.equal(observed[0].key,'test-key');
  assert.equal(observed[0].request.text.format.type,'json_schema');
  assert.equal(observed[0].request.store,false);
});
