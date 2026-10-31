import assert from 'node:assert/strict';
import test from 'node:test';

import { posterCandidateEligibility } from './poster-candidate-eligibility.js';

const SHA = 'a'.repeat(64);
const checks = {
  source_comparison: true,
  locked_anchors: true,
  repair_envelope: true,
  canvas_dimensions: true,
  key_field: true,
};

function fixture(overrides = {}) {
  const candidate = {
    candidate_id: 'candidate-1', layer_index: 1, candidate_number: 2, plan_version: 4,
    path: '/safe/candidates/layer_1.png', status: 'NEEDS_USER_REVIEW', candidate_sha256: SHA, failure_codes: [],
    release_gate: { verdict: 'NEEDS_USER_REVIEW', failureCodes: [], checks, candidateId: 'candidate-1', planVersion: 4, candidateSha256: SHA },
  };
  const layer = {
    layer_index: 1, status: 'NEEDS_USER_REVIEW', generation_count: 2,
    candidate_output: candidate.path,
    visual_inspection: {
      performed: true, verdict: 'NEEDS_USER_REVIEW', failure_codes: [], checks,
      candidate_id: 'candidate-1', plan_version: 4, candidate_sha256: SHA,
    },
  };
  return {
    plan: { status: 'PLAN_CONFIRMED', plan_version: 4 },
    candidate,
    layer,
    ...overrides,
  };
}

test('only a fully bound Task7 review candidate is eligible for acceptance', () => {
  assert.deepEqual(posterCandidateEligibility(fixture()), { eligible: true, reason: null });
});

test('the established Task7 inspection binding does not require a duplicate checks record', () => {
  const value = fixture();
  delete value.layer.visual_inspection.checks;
  assert.deepEqual(posterCandidateEligibility(value), { eligible: true, reason: null });
});

for (const [name, mutate] of [
  ['unconfirmed plan', (value) => { value.plan.status = 'PLAN_REVIEW'; }],
  ['wrong review state', (value) => { value.layer.status = 'RETRY_AUTHORIZED'; }],
  ['wrong candidate status', (value) => { value.candidate.status = 'HARD_REJECTED'; }],
  ['missing candidate path', (value) => { value.candidate.path = ''; }],
  ['candidate output mismatch', (value) => { value.layer.candidate_output = '/safe/candidates/other.png'; }],
  ['candidate number mismatch', (value) => { value.candidate.candidate_number = 3; }],
  ['candidate plan mismatch', (value) => { value.candidate.plan_version = 3; }],
  ['inspection not performed', (value) => { value.layer.visual_inspection.performed = false; }],
  ['inspection candidate mismatch', (value) => { value.layer.visual_inspection.candidate_id = 'candidate-2'; }],
  ['inspection plan mismatch', (value) => { value.layer.visual_inspection.plan_version = 3; }],
  ['gate candidate mismatch', (value) => { value.candidate.release_gate.candidateId = 'candidate-2'; }],
  ['gate plan mismatch', (value) => { value.candidate.release_gate.planVersion = 3; }],
  ['gate has partial checks', (value) => { value.candidate.release_gate.checks = { source_comparison: true }; }],
  ['gate has failed check', (value) => { value.candidate.release_gate.checks = { ...checks, key_field: false }; }],
  ['candidate sha mismatch', (value) => { value.candidate.candidate_sha256 = 'b'.repeat(64); }],
  ['gate sha mismatch', (value) => { value.candidate.release_gate.candidateSha256 = 'b'.repeat(64); }],
  ['inspection sha mismatch', (value) => { value.layer.visual_inspection.candidate_sha256 = 'b'.repeat(64); }],
]) {
  test(`rejects ${name}`, () => {
    const value = structuredClone(fixture());
    mutate(value);
    assert.equal(posterCandidateEligibility(value).eligible, false);
  });
}
