import assert from 'node:assert/strict';
import test from 'node:test';

import { canAcceptPosterCandidate } from './poster-candidate-state.js';
import { evaluatePosterRelease, POSTER_FAILURE_CODES } from './poster-release-gate.js';

const expectedFailureCodes = [
  'UNSUPPORTED_GRAPHIC_EFFECT', 'UI_BUNDLING_ERROR', 'VISIBLE_ANCHOR_MUTATION',
  'WHOLE_ASSET_REGENERATION', 'REPAIR_ENVELOPE_EXCEEDED', 'COMPLETION_MISSING',
  'ANATOMY_OR_STRUCTURE_BROKEN', 'TEXT_OR_LOGO_MUTATED', 'BACKGROUND_LAYOUT_DRIFT',
  'OCCLUDER_OWNERSHIP_ERROR', 'EFFECT_CONTINUITY_BROKEN', 'FOREIGN_CONTENT_LEAK',
  'REGISTRATION_UNCERTAIN', 'KEY_UNUSABLE', 'CANVAS_OR_GREEN_FIELD_INVALID',
];

function headlineFixture() {
  return { layer_index: 1, layer_name: 'Title', processing_mode: 'graphic_completion' };
}

function candidateFixture(overrides = {}) {
  return {
    candidate_id: 'candidate-1',
    plan_version: 2,
    path: '/jobs/poster-1/candidates/title.png',
    ...overrides,
  };
}

function passingChecks() {
  return {
    source_comparison: true,
    locked_anchors: true,
    repair_envelope: true,
    canvas_dimensions: true,
    key_field: true,
  };
}

test('v3.1 failure codes are exact and exposed as an immutable set', () => {
  assert.deepEqual([...POSTER_FAILURE_CODES], expectedFailureCodes);
  assert.throws(() => POSTER_FAILURE_CODES.add('UNKNOWN'), /read-only/i);
  assert.deepEqual([...POSTER_FAILURE_CODES], expectedFailureCodes);
});

test('mutated title geometry is a hard failure', () => {
  const result = evaluatePosterRelease({
    layer: headlineFixture(),
    candidate: candidateFixture(),
    review: { verdict: 'NEEDS_USER_REVIEW', failure_codes: [], checks: passingChecks(), textOrLogoMutated: true },
  });

  assert.equal(result.verdict, 'HARD_REJECTED');
  assert.deepEqual(result.failureCodes, ['TEXT_OR_LOGO_MUTATED']);
});

test('a fully passing report remains bound to its candidate and plan for user review', () => {
  const result = evaluatePosterRelease({
    layer: headlineFixture(),
    candidate: candidateFixture(),
    review: { verdict: 'NEEDS_USER_REVIEW', failure_codes: [], checks: passingChecks() },
  });

  assert.deepEqual(result, {
    verdict: 'NEEDS_USER_REVIEW',
    failureCodes: [],
    checks: passingChecks(),
    candidateId: 'candidate-1',
    planVersion: 2,
  });
});

test('unknown failure codes invalidate the review report instead of being ignored', () => {
  assert.throws(() => evaluatePosterRelease({
    layer: headlineFixture(),
    candidate: candidateFixture(),
    review: { verdict: 'HARD_REJECTED', failure_codes: ['NOT_A_V3_1_CODE'], checks: passingChecks() },
  }), /unknown poster failure code/i);
});

test('a clean verdict without deterministic checks is an invalid release report', () => {
  assert.throws(() => evaluatePosterRelease({
    layer: headlineFixture(),
    candidate: candidateFixture(),
    review: { verdict: 'NEEDS_USER_REVIEW', failure_codes: [] },
  }), /missing checks/i);
});

test('missing or unknown release verdicts invalidate the report', () => {
  for (const verdict of [undefined, 'ACCEPTED']) {
    assert.throws(() => evaluatePosterRelease({
      layer: headlineFixture(),
      candidate: candidateFixture(),
      review: { verdict, failure_codes: [], checks: passingChecks() },
    }), /release verdict/i);
  }
});

test('release checks require the exact five-key schema with no extras', () => {
  assert.throws(() => evaluatePosterRelease({
    layer: headlineFixture(),
    candidate: candidateFixture(),
    review: {
      verdict: 'NEEDS_USER_REVIEW', failure_codes: [],
      checks: { ...passingChecks(), subjective_quality: true },
    },
  }), /unexpected checks/i);
  assert.throws(() => evaluatePosterRelease({
    layer: headlineFixture(),
    candidate: candidateFixture(),
    review: {
      verdict: 'NEEDS_USER_REVIEW', failure_codes: [],
      checks: { ...passingChecks(), key_field: 'yes' },
    },
  }), /must be boolean/i);
});

test('failed deterministic checks are retained alongside declared visual failures', () => {
  const result = evaluatePosterRelease({
    layer: headlineFixture(),
    candidate: candidateFixture(),
    review: {
      verdict: 'HARD_REJECTED',
      failure_codes: ['TEXT_OR_LOGO_MUTATED'],
      checks: { ...passingChecks(), key_field: false },
    },
  });

  assert.deepEqual(result.failureCodes, ['TEXT_OR_LOGO_MUTATED', 'KEY_UNUSABLE']);
});

for (const failureCode of expectedFailureCodes) {
  test(`${failureCode} hard-rejects and cannot be accepted`, () => {
    const candidate = candidateFixture();
    const gate = evaluatePosterRelease({
      layer: headlineFixture(),
      candidate,
      review: { verdict: 'HARD_REJECTED', failure_codes: [failureCode], checks: passingChecks() },
    });
    const layerState = {
      status: 'NEEDS_USER_REVIEW',
      plan: { status: 'PLAN_CONFIRMED', plan_version: 2 },
      candidateId: candidate.candidate_id,
      candidatePath: candidate.path,
      candidatePlanVersion: candidate.plan_version,
      releaseGate: gate,
    };

    assert.equal(gate.verdict, 'HARD_REJECTED');
    assert.deepEqual(gate.failureCodes, [failureCode]);
    assert.equal(canAcceptPosterCandidate(layerState), false);
  });
}
