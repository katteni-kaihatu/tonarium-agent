import test from 'node:test';
import assert from 'node:assert/strict';
import { AI, userFacingChanges, unverifiedPoints } from '../src/ai.js';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('Codex intake attaches local screenshot files as image inputs', () => {
  const ai = new AI({codexModel:'gpt-6.1-sol',codexSpeed:'fast'});
  const args = ai.codexArgs('read-only','C:/repo','C:/out.json',['C:/feedback/screenshot.png']);
  const image = args.indexOf('--image');
  assert.ok(image > 0);
  assert.equal(args[image+1],'C:/feedback/screenshot.png');
  assert.ok(args.includes('read-only'));
});

test('agent guidance reads versioned role Markdown, guardrails and the target direction again for the next run', async () => {
  const root = await mkdtemp(join(tmpdir(),'tonarium-policy-test-'));
  try {
    await mkdir(join(root,'prompts'));
    await mkdir(join(root,'policy'));
    await mkdir(join(root,'repo','docs'),{recursive:true});
    await writeFile(join(root,'WORKFLOW.md'),'Common policy');
    await writeFile(join(root,'policy','guardrails.md'),'Guardrails');
    await writeFile(join(root,'prompts','intake.md'),'First intake policy');
    await writeFile(join(root,'prompts','review.md'),'Review policy');
    await writeFile(join(root,'repo','docs','direction.md'),'Direction');
    const ai = new AI({},root);
    assert.equal(await ai.guidance('ひより'),'Common policy\n\nGuardrails\n\nFirst intake policy');
    await writeFile(join(root,'prompts','intake.md'),'Updated intake policy');
    assert.equal(await ai.guidance('ひより'),'Common policy\n\nGuardrails\n\nUpdated intake policy');
    assert.match(await ai.guidance('ひより',{cwd:join(root,'repo')}),/開発方針（docs\/direction\.md）\n\nDirection$/);
    assert.equal(await ai.guidance('あおい',{guide:'review'}),'Common policy\n\nGuardrails\n\nReview policy');
    await writeFile(join(root,'prompts','translator.md'),'Translate');
    assert.equal(await ai.guidance('通訳',{cwd:join(root,'repo')}),'Common policy\n\nTranslate');
    await assert.rejects(() => ai.guidance('さくら'),/pm\.md/);
    await writeFile(join(root,'policy','guardrails.md'),'');
    await assert.rejects(() => ai.guidance('ひより'),/guardrails/);
  } finally { await rm(root,{recursive:true,force:true}); }
});

test('the builder report ends with user-facing changes for the PR body', () => {
  assert.deepEqual(userFacingChanges('変更しました\nUSER_FACING_CHANGES:\n- カメラにタイマーを追加\n- 音が鳴る\n'),['カメラにタイマーを追加','音が鳴る']);
  assert.deepEqual(userFacingChanges('報告だけ'),[]);
});

test('unverified points are parsed separately and never leak into user-facing changes', () => {
  const report = '直しました\nUNVERIFIED_POINTS:\n- 実機の見た目は未確認\nUSER_FACING_CHANGES:\n- ボタンが揃う\n';
  assert.deepEqual(unverifiedPoints(report),['実機の見た目は未確認']);
  assert.deepEqual(userFacingChanges(report),['ボタンが揃う']);
  // 順序が逆でも混ざらない
  const reversed = '直しました\nUSER_FACING_CHANGES:\n- ボタンが揃う\nUNVERIFIED_POINTS:\n- 実機の見た目は未確認\n';
  assert.deepEqual(userFacingChanges(reversed),['ボタンが揃う']);
  assert.deepEqual(unverifiedPoints(reversed),['実機の見た目は未確認']);
  assert.deepEqual(unverifiedPoints('報告だけ'),[]);
});
