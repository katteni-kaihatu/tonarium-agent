import test from 'node:test';
import assert from 'node:assert/strict';
import { AI } from '../src/ai.js';
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

test('agent guidance reads versioned role Markdown again for the next run', async () => {
  const root = await mkdtemp(join(tmpdir(),'tonarium-policy-test-'));
  try {
    await mkdir(join(root,'prompts'));
    await writeFile(join(root,'WORKFLOW.md'),'Common policy');
    await writeFile(join(root,'prompts','intake.md'),'First intake policy');
    const ai = new AI({},root);
    assert.equal(await ai.guidance('ひより'),'Common policy\n\nFirst intake policy');
    await writeFile(join(root,'prompts','intake.md'),'Updated intake policy');
    assert.equal(await ai.guidance('ひより'),'Common policy\n\nUpdated intake policy');
    await assert.rejects(() => ai.guidance('さくら'),/pm\.md/);
  } finally { await rm(root,{recursive:true,force:true}); }
});
