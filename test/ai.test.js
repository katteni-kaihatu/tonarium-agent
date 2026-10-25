import test from 'node:test';
import assert from 'node:assert/strict';
import { AI } from '../src/ai.js';

test('Codex intake attaches local screenshot files as image inputs', () => {
  const ai = new AI({codexModel:'gpt-6.1-sol',codexSpeed:'fast'});
  const args = ai.codexArgs('read-only','C:/repo','C:/out.json',['C:/feedback/screenshot.png']);
  const image = args.indexOf('--image');
  assert.ok(image > 0);
  assert.equal(args[image+1],'C:/feedback/screenshot.png');
  assert.ok(args.includes('read-only'));
});
