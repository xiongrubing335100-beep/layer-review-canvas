import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  failureExplanation,
  posterCandidateReviewModel,
} from './poster-candidate-review-model.js';

const source = [
  await readFile(new URL('./PosterCandidateReview.jsx', import.meta.url), 'utf8'),
  await readFile(new URL('./poster-candidate-review-model.js', import.meta.url), 'utf8'),
].join('\n');

test('hard rejected candidates never show accept', () => {
  assert.match(source, /status === 'HARD_REJECTED'/);
  assert.match(source, /重新生成此层/);
  assert.doesNotMatch(source, /HARD_REJECTED[\s\S]{0,180}>接受候选</);
});

test('review-ready candidates show explicit accept and retry', () => {
  assert.match(source, /status === 'NEEDS_USER_REVIEW'/);
  assert.match(source, /接受候选/);
  assert.match(source, /重试此层/);
});

test('candidate comparison keeps the source and overlay candidate in the same stack and labels previews only', () => {
  assert.match(source, /className="poster-compare__stack"/);
  assert.match(source, /className="poster-compare__source"/);
  assert.match(source, /className="poster-compare__candidate"/);
  assert.match(source, /透明模拟预览（仅预览）/);
  assert.doesNotMatch(source, /download=/i);
});

test('candidate review describes a returned PNG with truthful Chinese dimension facts', () => {
  const explanation = failureExplanation('CANVAS_OR_GREEN_FIELD_INVALID', {
    dimensions: { width: 852, height: 1846 },
    expectedDimensions: { width: 1848, height: 4000 },
  });

  assert.match(explanation.message, /画布/);
  assert.deepEqual(explanation.facts, [
    '实际画布：852 × 1846 px',
    '要求画布：1848 × 4000 px',
  ]);
  assert.equal(explanation.technicalCode, 'CANVAS_OR_GREEN_FIELD_INVALID');
});

test('candidate review model keeps machine codes while supplying Chinese generation failures', () => {
  const model = posterCandidateReviewModel({
    status: 'HARD_REJECTED',
    failureCodes: ['GENERATION_FAILED', 'IMAGEGEN_NO_PNG', 'REGISTRATION_UNCERTAIN'],
    facts: { registration: '与原图主体边缘无法稳定对齐' },
  });

  assert.equal(model.statusLabel, '候选未通过自动质检');
  assert.deepEqual(model.failures.map((failure) => failure.technicalCode), [
    'GENERATION_FAILED', 'IMAGEGEN_NO_PNG', 'REGISTRATION_UNCERTAIN',
  ]);
  assert.match(model.failures[0].message, /生成失败/);
  assert.match(model.failures[1].message, /PNG/);
  assert.deepEqual(model.failures[2].facts, ['配准：与原图主体边缘无法稳定对齐']);
});

test('candidate review maps every established release-gate code to Chinese', () => {
  const codes = [
    'UNSUPPORTED_GRAPHIC_EFFECT', 'UI_BUNDLING_ERROR', 'VISIBLE_ANCHOR_MUTATION',
    'WHOLE_ASSET_REGENERATION', 'REPAIR_ENVELOPE_EXCEEDED', 'COMPLETION_MISSING',
    'ANATOMY_OR_STRUCTURE_BROKEN', 'TEXT_OR_LOGO_MUTATED', 'BACKGROUND_LAYOUT_DRIFT',
    'OCCLUDER_OWNERSHIP_ERROR', 'EFFECT_CONTINUITY_BROKEN', 'FOREIGN_CONTENT_LEAK',
    'REGISTRATION_UNCERTAIN', 'KEY_UNUSABLE', 'CANVAS_OR_GREEN_FIELD_INVALID',
  ];

  for (const code of codes) {
    const explanation = failureExplanation(code);
    assert.match(explanation.message, /[\u4e00-\u9fff]/u, `${code} should have a Chinese explanation`);
    assert.equal(explanation.technicalCode, code);
  }
});

test('the candidate-review header keeps status enums out of ordinary copy', () => {
  assert.match(source, /actionModel\.statusLabel/);
  assert.doesNotMatch(source, /statusLabel}\uff08\{status}\uff09/);
});

test('candidate review uses a Chinese release-check heading', () => {
  assert.match(source, /发布检查/);
  assert.doesNotMatch(source, /<h3>Release gate<\/h3>/);
});
