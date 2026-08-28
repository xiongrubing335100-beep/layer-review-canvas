import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const audit = await readFile(new URL('../docs/superpowers/audits/2026-08-22-task-5-fast-workbench-base-preservation.md', import.meta.url), 'utf8');
const [mainSource, stylesSource] = await Promise.all([
  readFile(new URL('./main.jsx', import.meta.url), 'utf8'),
  readFile(new URL('./styles.css', import.meta.url), 'utf8'),
]);
const fastSources = await Promise.all([
  readFile(new URL('./PosterFastWorkbench.jsx', import.meta.url), 'utf8'),
  readFile(new URL('./PosterFastCandidateResult.jsx', import.meta.url), 'utf8'),
  readFile(new URL('./poster-fast-workbench-model.js', import.meta.url), 'utf8'),
]);

function sha256(source) {
  return createHash('sha256').update(source).digest('hex');
}

test('Task 5 audit records the untracked baseline and rules out protected paths', () => {
  assert.match(audit, /untracked baseline/i);
  assert.match(audit, /cannot reconstruct a narrow historical diff/i);
  const changed = execFileSync('git', ['diff', '--name-only', '3eb88db^..73c1c96'], { encoding: 'utf8' });
  const protectedChange = changed.split('\n').find((path) => (
    path.startsWith('apps/bridge-server/')
    || path.startsWith('apps/photoshop-')
    || path.startsWith('_codex/collab/shared')
    || path.endsWith('/poster-layer-manifest-v3.1.json')
    || path.includes('/lovart-poster-layering-v3-1/')
  ));
  assert.equal(protectedChange, undefined);
  for (const source of fastSources) {
    assert.doesNotMatch(source, /bridge-server|photoshop|lovart-poster-layering-v3-1|poster-layer-manifest-v3\.1/i);
  }
});

test('base audit snapshots retained high-quality and fast boundaries without claiming historical reconstruction', () => {
  const mainHash = sha256(mainSource);
  const stylesHash = sha256(stylesSource);
  assert.match(audit, new RegExp(`src/main\\.jsx SHA-256: ${mainHash}`));
  assert.match(audit, new RegExp(`src/styles\\.css SHA-256: ${stylesHash}`));
  assert.match(audit, /incremental evidence only/i);
  assert.match(audit, /does not prove whole-file preservation/i);
  for (const marker of [
    'PosterPlanReview', 'PosterCandidateReview', 'poster-candidate-workbench', 'poster-completion',
    'PosterFastWorkbench', 'posterFastCandidatePreviewPath',
  ]) assert.match(mainSource, new RegExp(marker));
  for (const marker of ['.poster-plan-review', '.poster-candidate-review', '.poster-completion', '.poster-fast-workbench__']) {
    assert.ok(stylesSource.includes(marker));
  }
  assert.doesNotMatch(`${mainSource}\n${stylesSource}`, /bridge-server|photoshop|lovart-poster-layering-v3-1|poster-layer-manifest-v3\.1/i);
  const incremental = execFileSync('git', ['diff', '--name-only', '3eb88db..HEAD'], { encoding: 'utf8' });
  assert.match(incremental, /src\/PosterFastWorkbench\.jsx/);
  assert.doesNotMatch(incremental, /(^|\/)(apps\/bridge-server|apps\/photoshop|_codex\/collab\/shared|poster-layer-manifest-v3\.1|lovart-poster-layering-v3-1)/m);
});
