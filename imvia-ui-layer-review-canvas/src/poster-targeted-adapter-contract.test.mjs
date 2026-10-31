import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { POSTER_FAILURE_CODES } from './poster-release-gate.js';

const targetedDirectory = new URL('../plugin-template/imvia-layer/skills/imvia-poster-layering-workbench-targeted-v1/', import.meta.url);

// These are lifecycle failures handled before the v3.1 release gate. RUNTIME_DIR
// is a documented adapter path placeholder, not a failure code.
const NON_RELEASE_TOKENS = new Set([
  'GENERATION_FAILED',
  'IMAGEGEN_NO_PNG',
  'TARGETED_SNAPSHOT_INVALID',
  'RUNTIME_DIR',
]);

function backtickedMachineTokens(markdown) {
  return [...markdown.matchAll(/`([A-Z][A-Z0-9_:-]+)`/gu)].map((match) => match[1]);
}

test('targeted adapter uses only exact v3.1 failure codes plus documented lifecycle codes', async () => {
  const documents = await Promise.all([
    readFile(new URL('SKILL.md', targetedDirectory), 'utf8'),
    readFile(new URL('references/category-blocks.md', targetedDirectory), 'utf8'),
  ]);
  const declared = [...new Set(documents.flatMap(backtickedMachineTokens))];
  const unknown = declared.filter((code) => !NON_RELEASE_TOKENS.has(code) && !POSTER_FAILURE_CODES.has(code));

  assert.deepEqual(unknown, []);
  assert.ok(declared.includes('UI_BUNDLING_ERROR'));
  assert.ok(declared.includes('BACKGROUND_LAYOUT_DRIFT'));
});

test('targeted fast remove-background candidates use RMBG 2.0 before keyed finalization', async () => {
  const skill = await readFile(new URL('SKILL.md', targetedDirectory), 'utf8');
  assert.match(skill, /confirm_poster_foreground_dispatch/);
  assert.ok(
    skill.indexOf('先调用工作台工具 `confirm_poster_foreground_dispatch`')
      < skill.indexOf('只调用一次 ImageGen'),
    'dispatch confirmation must precede ImageGen in the adapter contract',
  );
  assert.match(skill, /finalize-poster-fast-rmbg-candidate\.mjs/);
  assert.match(skill, /finalize-rmbg\.py/);
  assert.match(skill, /prepare-poster-rmbg-candidate\.py/);
  assert.match(skill, /--transparent-preview/);
  assert.match(skill, /原始尺寸|原生尺寸/);
  assert.match(skill, /不得仅因.*放大|放大.*不得.*硬拒绝/);
  assert.match(skill, /不(?:再|得)执行[^。\n]*视觉比对/);
  assert.match(skill, /立即回传工作台/);
  assert.match(skill, /NEEDS_USER_REVIEW/);
  assert.match(skill, /--job-directory <output_directory>/);
  assert.doesNotMatch(skill, /--output-root <output_directory>/);
  assert.doesNotMatch(skill, /再运行[^。\n]*prepare-poster-job\.mjs/);
});
