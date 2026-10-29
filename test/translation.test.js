import test from 'node:test';
import assert from 'node:assert/strict';
import { Translator, scriptLanguage, translationLines, withTranslations } from '../src/translation.js';

test('Codex subscription translator returns and caches Japanese, English and Korean', async () => {
  let calls = 0;
  const ai = { ask: async (_role,_prompt,options) => { assert.equal(options.provider,'codex'); calls++; return {ja:'こんにちは',en:'Hello',ko:'안녕하세요'}; } };
  const translator = new Translator({translationProvider:'codex'},ai,process.cwd());
  assert.deepEqual(await translator.translate('こんにちは'),{ja:'こんにちは',en:'Hello',ko:'안녕하세요',source:'ja'});
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

test('translations skip the original language and lines identical to the original, without a heading', () => {
  const result = {source:'ja',ja:'地図を拡大したい',en:'I want to zoom the map',ko:'지도를 확대하고 싶어요'};
  assert.equal(withTranslations('地図を拡大したい',result),'地図を拡大したい\n\n🇺🇸 I want to zoom the map\n🇰🇷 지도를 확대하고 싶어요');
  assert.equal(translationLines('Hello',{source:'other',ja:'こんにちは',en:'Hello',ko:'안녕하세요'}),'🇯🇵 こんにちは\n🇰🇷 안녕하세요');
  assert.equal(translationLines('你好',{source:'other',ja:'こんにちは',en:'Hello',ko:'안녕하세요'}),'🇯🇵 こんにちは\n🇺🇸 Hello\n🇰🇷 안녕하세요');
  assert.equal(translationLines('OK',{source:'en',ja:'OK',en:'OK',ko:'OK'}),'');
  assert.equal(withTranslations('本文',null),'本文');
  assert.deepEqual(['한국어 문장','ひらがなと漢字','English only','漢字'].map(scriptLanguage),['ko','ja','en','']);
});
