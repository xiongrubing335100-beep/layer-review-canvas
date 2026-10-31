import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createPosterPlanningRunGuard,
  posterFastCandidateAuthorizationId,
  posterWorkbenchView,
  runPosterFastPlanningPipeline,
} from './poster-workbench-state.js';

test('preserves dispatch lifecycle separately from poster plan state', () => {
  assert.equal(posterWorkbenchView({ status: 'queued', dispatch_id: 'd-1' }).kind, 'queued');
  assert.equal(posterWorkbenchView({ status: 'claimed', dispatch_id: 'd-1' }).kind, 'processing');
  assert.equal(posterWorkbenchView({ status: 'processing', dispatch_id: 'd-1' }).kind, 'processing');
  assert.equal(posterWorkbenchView({ status: 'PLAN_REVIEW', plan: { status: 'PLAN_REVIEW' } }).kind, 'review');
  assert.equal(posterWorkbenchView({ status: 'ANALYSIS_FAILED', plan: { status: 'ANALYSIS_FAILED' } }).kind, 'failed');
});

test('targeted-fast plans always select the fast workbench instead of the high-quality review flow', () => {
  assert.equal(posterWorkbenchView({
    status: 'PLAN_REVIEW',
    plan: { status: 'PLAN_REVIEW', planning_mode: 'targeted_fast' },
  }).kind, 'fast');
  assert.equal(posterWorkbenchView({
    status: 'PLAN_REVIEW',
    plan: { status: 'PLAN_REVIEW', planning_mode: 'quality_global' },
  }).kind, 'review');
});

test('targeted-fast metadata on the job remains sufficient when the plan is carried separately', () => {
  assert.deepEqual(posterWorkbenchView({ planning_mode: 'targeted_fast', status: 'PLAN_REVIEW' }), { kind: 'fast' });
});

test('high-quality lifecycle states remain distinct from the fast workbench', () => {
  for (const [status, kind] of [
    ['PLAN_REVIEW', 'review'],
    ['PLAN_CONFIRMED', 'confirmed'],
    ['ANALYSIS_FAILED', 'failed'],
    ['queued', 'queued'],
  ]) {
    assert.equal(posterWorkbenchView({ status, plan: { status } }).kind, kind, status);
  }
});

test('fast candidate authorization derives the next number from persisted candidates for one layer', () => {
  const manifest = {
    candidates: [
      { layer_index: 2, candidate_id: 'candidate-2-a' },
      { layer_index: 1, candidate_id: 'candidate-1-a' },
      { layer_index: 2, candidate_id: 'candidate-2-b' },
    ],
  };
  assert.equal(posterFastCandidateAuthorizationId('poster-job', 4, 2, manifest), 'poster-job:4:2:3');
  assert.equal(posterFastCandidateAuthorizationId('poster-job', 4, 3, manifest), 'poster-job:4:3:1');
});

function deferred() {
  let resolve;
  const promise = new Promise((value) => { resolve = value; });
  return { promise, resolve };
}

test('superseding during source upload prevents the fast pipeline from submitting or saving', async () => {
  let currentRun = 1;
  const guard = createPosterPlanningRunGuard(1, () => currentRun);
  const upload = deferred();
  let uploadStarted = false;
  let submitted = 0;
  const effects = [];
  const pipeline = runPosterFastPlanningPipeline({
    runGuard: guard,
    materializeSource: async () => ({ blob: 'materialized', size: { width: 1, height: 1 } }),
    uploadSource: () => { uploadStarted = true; return upload.promise; },
    createPlan: () => ({ plan: true }),
    submitJob: async () => { submitted += 1; return { job_id: 'stale' }; },
    persist: () => effects.push('save'),
    onStage: () => effects.push('stage'),
  });
  while (!uploadStarted) await Promise.resolve();
  currentRun = 2;
  upload.resolve({ sourcePath: 'stale-source.png' });
  assert.deepEqual(await pipeline, { status: 'stale' });
  assert.equal(submitted, 0);
  assert.deepEqual(effects, []);
});

test('superseding during fast submit prevents stale persistence and stage updates', async () => {
  let currentRun = 7;
  const guard = createPosterPlanningRunGuard(7, () => currentRun);
  const submit = deferred();
  let submitStarted = false;
  const effects = [];
  const pipeline = runPosterFastPlanningPipeline({
    runGuard: guard,
    materializeSource: async () => ({ blob: 'materialized', size: { width: 1, height: 1 } }),
    uploadSource: async () => ({ sourcePath: 'source.png', size: { width: 1, height: 1 } }),
    createPlan: (source) => ({ source }),
    submitJob: () => { submitStarted = true; return submit.promise; },
    persist: () => effects.push('save'),
    onStage: () => effects.push('stage'),
  });
  while (!submitStarted) await Promise.resolve();
  currentRun = 8;
  submit.resolve({ job_id: 'stale-job', plan: { planning_mode: 'targeted_fast' } });
  assert.deepEqual(await pipeline, { status: 'stale' });
  assert.deepEqual(effects, []);
});
