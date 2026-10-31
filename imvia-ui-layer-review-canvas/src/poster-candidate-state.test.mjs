import assert from 'node:assert/strict';
import test from 'node:test';

import {
  PosterCandidateTransitionError,
  canAcceptPosterCandidate,
  canGeneratePosterCandidate,
  candidateFileName,
  reducePosterLayerState,
} from './poster-candidate-state.js';

function posterLayerFixture(overrides = {}) {
  const planVersion = overrides.activePlanVersion ?? overrides.plan?.plan_version ?? 2;
  return {
    status: 'PENDING',
    generationCount: 0,
    plan: { status: 'PLAN_CONFIRMED', plan_version: planVersion },
    activePlanVersion: 2,
    candidatePlanVersion: undefined,
    candidateId: undefined,
    candidatePath: undefined,
    ...overrides,
  };
}

test('one authorization creates one generation only', () => {
  let state = posterLayerFixture({ status: 'PENDING', generationCount: 0 });
  state = reducePosterLayerState(state, { type: 'GENERATION_AUTHORIZED', planVersion: 2 });
  state = reducePosterLayerState(state, { type: 'GENERATION_STARTED' });
  state = reducePosterLayerState(state, { type: 'GENERATION_FAILED', error: 'ImageGen failed' });
  assert.equal(canGeneratePosterCandidate(state), false);
  assert.equal(state.status, 'HARD_REJECTED');
});

test('retry requires an explicit authorization event', () => {
  const rejected = posterLayerFixture({ status: 'HARD_REJECTED', generationCount: 1 });
  const retry = reducePosterLayerState(rejected, { type: 'RETRY_AUTHORIZED' });
  assert.equal(retry.status, 'RETRY_AUTHORIZED');
  assert.equal(canGeneratePosterCandidate(retry), true);
});

test('a stale candidate cannot be accepted', () => {
  const state = posterLayerFixture({
    status: 'NEEDS_USER_REVIEW', candidatePlanVersion: 2, activePlanVersion: 3,
    candidateId: 'candidate-1', candidatePath: 'candidates/layer_1_title_candidate-01.png',
  });
  assert.equal(canAcceptPosterCandidate(state), false);
});

test('authorization is denied when the Task 2 plan is not confirmed', () => {
  const state = posterLayerFixture({ plan: { status: 'PLAN_REVIEW', plan_version: 2 } });
  assert.throws(
    () => reducePosterLayerState(state, { type: 'GENERATION_AUTHORIZED', planVersion: 2 }),
    (error) => error instanceof PosterCandidateTransitionError && error.code === 'PLAN_NOT_CONFIRMED',
  );
  assert.equal(canGeneratePosterCandidate({
    ...state, status: 'GENERATION_AUTHORIZED', authorizationPlanVersion: 2,
  }), false);
});

test('acceptance fails closed without a successful release gate record', () => {
  const state = posterLayerFixture({
    status: 'NEEDS_USER_REVIEW', candidatePlanVersion: 2,
    candidateId: 'candidate-1', candidatePath: 'candidate.png',
  });
  assert.equal(canAcceptPosterCandidate(state), false);
  assert.throws(
    () => reducePosterLayerState(state, { type: 'CANDIDATE_ACCEPTED' }),
    (error) => error instanceof PosterCandidateTransitionError && error.code === 'CANDIDATE_NOT_ACCEPTABLE',
  );
});

test('acceptance fails closed when the release gate failed', () => {
  const state = posterLayerFixture({
    status: 'NEEDS_USER_REVIEW', candidatePlanVersion: 2,
    candidateId: 'candidate-1', candidatePath: 'candidate.png',
    releaseGate: { verdict: 'HARD_REJECTED', failureCodes: ['TEXT_OR_LOGO_MUTATED'], checks: {} },
  });
  assert.equal(canAcceptPosterCandidate(state), false);
});

test('Task 7 NEEDS_USER_REVIEW gate verdict enables review and acceptance', () => {
  let state = posterLayerFixture();
  state = reducePosterLayerState(state, { type: 'GENERATION_AUTHORIZED', planVersion: 2 });
  state = reducePosterLayerState(state, { type: 'GENERATION_STARTED' });
  state = reducePosterLayerState(state, {
    type: 'CANDIDATE_CREATED', candidateId: 'candidate-1', candidatePath: 'candidate.png', planVersion: 2,
  });
  state = reducePosterLayerState(state, {
    type: 'REVIEW_READY',
    releaseGate: { verdict: 'NEEDS_USER_REVIEW', failureCodes: [], checks: {} },
    candidateId: 'candidate-1', planVersion: 2,
  });
  assert.equal(state.status, 'NEEDS_USER_REVIEW');
  assert.equal(state.releaseGate.candidateId, 'candidate-1');
  assert.equal(state.releaseGate.planVersion, 2);
  assert.equal(canAcceptPosterCandidate(state), true);
});

test('a generic passing Task 7 gate without event binding cannot be accepted', () => {
  const state = posterLayerFixture({
    status: 'NEEDS_USER_REVIEW', candidatePlanVersion: 2,
    candidateId: 'candidate-1', candidatePath: 'candidate.png',
    releaseGate: { verdict: 'NEEDS_USER_REVIEW', failureCodes: [], checks: {} },
  });
  assert.equal(canAcceptPosterCandidate(state), false);
});

test('candidate creation requires a complete candidate bound to the active plan', () => {
  let state = reducePosterLayerState(posterLayerFixture(), {
    type: 'GENERATION_AUTHORIZED', planVersion: 2,
  });
  state = reducePosterLayerState(state, { type: 'GENERATION_STARTED' });
  assert.throws(
    () => reducePosterLayerState(state, {
      type: 'CANDIDATE_CREATED', candidateId: 'candidate-1', candidatePath: 'candidate.png', planVersion: 3,
    }),
    (error) => error instanceof PosterCandidateTransitionError && error.code === 'PLAN_VERSION_MISMATCH',
  );
  assert.throws(
    () => reducePosterLayerState(state, { type: 'CANDIDATE_CREATED', planVersion: 2 }),
    (error) => error instanceof PosterCandidateTransitionError && error.code === 'CANDIDATE_ID_REQUIRED',
  );
});

test('only a reviewed current candidate can be accepted', () => {
  const rejected = posterLayerFixture({
    status: 'HARD_REJECTED', generationCount: 1, candidateId: 'candidate-1',
    candidatePath: 'candidate.png', candidatePlanVersion: 2,
  });
  assert.equal(canAcceptPosterCandidate(rejected), false);
  assert.throws(
    () => reducePosterLayerState(rejected, { type: 'CANDIDATE_ACCEPTED' }),
    (error) => error instanceof PosterCandidateTransitionError,
  );
});

test('legal candidate lifecycle binds its plan and records the generation', () => {
  let state = posterLayerFixture();
  state = reducePosterLayerState(state, { type: 'GENERATION_AUTHORIZED', planVersion: 2 });
  state = reducePosterLayerState(state, { type: 'GENERATION_STARTED' });
  state = reducePosterLayerState(state, {
    type: 'CANDIDATE_CREATED', candidateId: 'candidate-1', candidatePath: 'candidate.png', planVersion: 2,
  });
  state = reducePosterLayerState(state, {
    type: 'REVIEW_READY',
    releaseGate: { verdict: 'NEEDS_USER_REVIEW', failureCodes: [], checks: {} },
    candidateId: 'candidate-1', planVersion: 2,
  });
  assert.equal(state.status, 'NEEDS_USER_REVIEW');
  assert.equal(state.generationCount, 1);
  assert.equal(canAcceptPosterCandidate(state), true);
  const accepted = reducePosterLayerState(state, {
    type: 'CANDIDATE_ACCEPTED', candidateId: 'candidate-1', planVersion: 2,
  });
  assert.equal(accepted.status, 'ACCEPTED');
});

test('a clean retry resets old candidate gate state and accepts after its own passing gate', () => {
  let state = posterLayerFixture();
  state = reducePosterLayerState(state, { type: 'GENERATION_AUTHORIZED', planVersion: 2 });
  state = reducePosterLayerState(state, { type: 'GENERATION_STARTED' });
  state = reducePosterLayerState(state, {
    type: 'CANDIDATE_CREATED', candidateId: 'candidate-1', candidatePath: 'candidate-1.png', planVersion: 2,
  });
  state = reducePosterLayerState(state, {
    type: 'HARD_FAILURE_FOUND', failureCode: 'TEXT_OR_LOGO_MUTATED',
  });
  state = reducePosterLayerState(state, { type: 'RETRY_AUTHORIZED', planVersion: 2 });
  assert.equal(state.candidateId, undefined);
  assert.equal(state.releaseGate, undefined);
  assert.equal(state.failureCodes, undefined);
  assert.equal(state.candidateHistory[0].candidateId, 'candidate-1');

  state = reducePosterLayerState(state, { type: 'GENERATION_STARTED' });
  state = reducePosterLayerState(state, {
    type: 'CANDIDATE_CREATED', candidateId: 'candidate-2', candidatePath: 'candidate-2.png', planVersion: 2,
  });
  state = reducePosterLayerState(state, {
    type: 'REVIEW_READY',
    releaseGate: { verdict: 'NEEDS_USER_REVIEW', failureCodes: [], checks: {} },
    candidateId: 'candidate-2', planVersion: 2,
  });
  assert.equal(canAcceptPosterCandidate(state), true);
  assert.equal(reducePosterLayerState(state, {
    type: 'CANDIDATE_ACCEPTED', candidateId: 'candidate-2', planVersion: 2,
  }).status, 'ACCEPTED');
});

test('retry clears a nested active candidate and its candidate-scoped state', () => {
  const rejected = posterLayerFixture({
    status: 'HARD_REJECTED', generationCount: 1,
    candidate: {
      id: 'candidate-nested', path: 'candidate-nested.png', planVersion: 2,
      releaseGate: { verdict: 'HARD_REJECTED', failureCodes: ['TEXT_OR_LOGO_MUTATED'], checks: {} },
      failureCodes: ['TEXT_OR_LOGO_MUTATED'],
    },
    releaseGate: { verdict: 'HARD_REJECTED', failureCodes: ['TEXT_OR_LOGO_MUTATED'], checks: {} },
    failureCodes: ['TEXT_OR_LOGO_MUTATED'],
  });
  const retry = reducePosterLayerState(rejected, { type: 'RETRY_AUTHORIZED', planVersion: 2 });
  assert.equal(retry.candidate, undefined);
  assert.equal(retry.releaseGate, undefined);
  assert.equal(retry.failureCodes, undefined);
  assert.equal(retry.candidateHistory[0].candidateId, 'candidate-nested');
});

test('candidate file names are deterministic and reject unsafe values', () => {
  assert.equal(candidateFileName({ layerIndex: 2, slug: '主标题', generationCount: 1 }),
    'layer_2_主标题_candidate-01.png');
  assert.equal(candidateFileName({ layerIndex: 12, slug: 'hero title', generationCount: 11 }),
    'layer_12_hero-title_candidate-11.png');
  assert.throws(() => candidateFileName({ layerIndex: 0, slug: 'title', generationCount: 1 }), TypeError);
  assert.throws(() => candidateFileName({ layerIndex: 1, slug: '../title', generationCount: 1 }), TypeError);
  assert.throws(() => candidateFileName({ layerIndex: 1, slug: 'title', generationCount: 0 }), TypeError);
});
