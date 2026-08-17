import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const rootDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('transparent repair stages chain from the accepted repair RGB and preserve one fast retry', async () => {
  const skill = await readFile(path.join(
    rootDirectory,
    'plugin-template',
    'imvia-layer',
    'skills',
    'split-ui-design-layers-workbench-targeted',
    'SKILL.md',
  ), 'utf8');

  assert.match(skill, /repair_scope_path/);
  assert.match(skill, /accepted repair RGB/);
  assert.match(skill, /Fast mode budgets three calls/);
  assert.match(skill, /complete the hidden RGB structure before generating the alpha matte/);
  assert.match(skill, /one full-subject alpha matte/);
  assert.doesNotMatch(skill, /--repair-matte-input/);
  assert.match(skill, /update-targeted-job-stage\.mjs/);
  assert.match(skill, /use `repair_rgb` before the repair RGB call/);
  assert.match(skill, /`alpha_matte` before the full-alpha/);
  assert.match(skill, /omit\s+`timing\.completed_at`/);
});
