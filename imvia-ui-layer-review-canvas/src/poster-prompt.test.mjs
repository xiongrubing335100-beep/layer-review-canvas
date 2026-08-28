import assert from 'node:assert/strict';
import test from 'node:test';

import { buildPosterAnalysisPrompt, buildPosterCandidatePrompt, buildPosterTargetedCandidatePrompt } from './poster-prompt.js';

function fixture(overrides = {}) {
  return {
    jobId: 'poster-job-1',
    planPath: '/tmp/poster-job-1/poster-layer-plan.json',
    sourcePath: '/tmp/poster-job-1/source.png',
    ...overrides,
  };
}

test('analysis explicitly forbids generation', () => {
  const prompt = buildPosterAnalysisPrompt(fixture());
  assert.match(prompt, /禁止调用 ImageGen/);
  assert.match(prompt, /poster-layer-plan\.json/);
  assert.doesNotMatch(prompt, /生成候选第/);
});

test('candidate prompt authorizes exactly one layer and one candidate', () => {
  const prompt = buildPosterCandidatePrompt({ ...fixture(), layerIndex: 3, candidateNumber: 1 });
  assert.match(prompt, /只处理 layer_index=3/);
  assert.match(prompt, /只允许一次 ImageGen 调用/);
  assert.match(prompt, /finalize-poster-generation-failure/);
  assert.match(prompt, /不得接受候选/);
});

test('targeted prompt names one category and forbids global analysis', () => {
  const prompt = buildPosterTargetedCandidatePrompt({
    jobId: 'poster-fast-1', planPath: '/job/plan.json', snapshotPath: '/job/snap.json',
    sourcePath: '/job/source.png', layerIndex: 2, candidateNumber: 1, processingCategory: 'text',
  });
  assert.match(prompt, /imvia-poster-layering-workbench-targeted-v1/);
  assert.match(prompt, /只处理 layer_index=2/);
  assert.match(prompt, /不得.*整张海报.*分析/);
  assert.match(prompt, /只允许一次 ImageGen/);
  assert.match(prompt, /去背景.*RMBG 2\.0/);
  assert.match(prompt, /安全边距/);
  assert.match(prompt, /不得触碰或越过画布边缘/);
});
