import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { mergePosterJobUpdate } from './poster-job-ui-state.js';
import { posterWorkbenchView } from './poster-workbench-state.js';

const mainSource = await readFile(new URL('./main.jsx', import.meta.url), 'utf8');
const posterModePickerSource = await readFile(new URL('./PosterModePicker.jsx', import.meta.url), 'utf8');

test('a delayed older poll cannot overwrite a newer accept response', () => {
  const accepted = { job_id: 'poster-1', manifest_revision: 9, manifest: { layers: [{ status: 'ACCEPTED' }] } };
  const delayed = { job_id: 'poster-1', manifest_revision: 8, manifest: { layers: [{ status: 'NEEDS_USER_REVIEW' }] }, dispatch: { status: 'processing' } };
  assert.deepEqual(mergePosterJobUpdate(accepted, delayed), accepted);
});

test('fast poster planning uploads and persists a local plan without entering global analysis', () => {
  const fastPlanning = mainSource.match(/const startPosterFastPlanning[\s\S]*?const startPosterAnalysis/);
  assert.ok(fastPlanning, 'fast planning entry should remain visible in the app source');
  assert.match(fastPlanning[0], /materializePosterSource/);
  assert.match(fastPlanning[0], /uploadPosterSource/);
  assert.match(fastPlanning[0], /createFastPosterPlan/);
  assert.match(fastPlanning[0], /submitPosterFastJob\(plan\)/);
  assert.doesNotMatch(fastPlanning[0], /submitPosterAnalysis/);
});

test('fast candidate authorization uses the persisted per-layer candidate number', () => {
  const split = mainSource.match(/const splitFastPosterLayer[\s\S]*?const acceptFastPosterCandidate/);
  assert.ok(split, 'fast candidate entry should remain visible in the app source');
  assert.match(split[0], /posterFastCandidateAuthorizationId\(/);
  assert.doesNotMatch(split[0], /authorizationId[^\n]*Date\.now/);
});

test('fast planning delegates every asynchronous boundary to the stale-run pipeline', () => {
  const fastPlanning = mainSource.match(/const startPosterFastPlanning[\s\S]*?const startPosterAnalysis/);
  assert.ok(fastPlanning);
  assert.match(fastPlanning[0], /runPosterFastPlanningPipeline/);
  assert.doesNotMatch(fastPlanning[0], /isCurrentFastPlanning/);
  assert.match(fastPlanning[0], /submitJob: \(plan\) => submitPosterFastJob\(plan\)/);
  assert.match(fastPlanning[0], /persist: \(\{ plan: nextPlan, submitted \}\)/);
  assert.match(fastPlanning[0], /onStage: \(\) => setCategoryAnalysisStage\('complete'\)/);
});

test('fast job branch uses the H5-shaped workbench while legacy quality jobs remain readable', () => {
  assert.match(mainSource, /isFastPosterPlan && activePosterView\.kind === 'fast'/);
  assert.match(mainSource, /<PosterFastWorkbench/);
  assert.match(mainSource, /activePosterView\.kind === 'review'/);
  assert.match(mainSource, /<PosterPlanReview/);
  assert.match(mainSource, /poster-completion/);
  assert.match(mainSource, /onClick=\{startPosterAnalysis\}/);
  assert.doesNotMatch(posterModePickerSource, /高质量分析|quality_global|posterPlanningChoices/);
  assert.match(posterModePickerSource, /onPosterPlanningModeChange\?\.\('targeted_fast'\)/);
});

test('equal revision can add a non-regressive transport state without replacing the authoritative job', () => {
  const current = { job_id: 'poster-1', manifest_revision: 9, manifest: { layers: [{ status: 'ACCEPTED' }] }, dispatch: { status: 'queued' } };
  const update = { job_id: 'poster-1', manifest_revision: 9, manifest: { layers: [{ status: 'NEEDS_USER_REVIEW' }] }, dispatch: { status: 'sent' } };
  assert.deepEqual(mergePosterJobUpdate(current, update), {
    ...current,
    dispatch: { status: 'sent' },
  });
});

const recognizedStatuses = [
  'queued', 'pending', 'awaiting_codex_message',
  'claimed', 'delivered', 'sending_to_codex', 'submitted_to_conversation', 'sent',
  'host_accepted', 'sent_to_codex', 'processing', 'finalizing', 'ANALYZING',
  'completed', 'PLAN_REVIEW', 'PLAN_CONFIRMED', 'ANALYSIS_FAILED',
  'failed', 'send_failed', 'cancelled', 'abandoned',
];

function job(status) {
  return { job_id: 'poster-1', manifest_revision: 9, status, dispatch: { status } };
}

function dispatched({ status, dispatchId, planStatus = 'PLAN_CONFIRMED' }) {
  return {
    job_id: 'poster-1', manifest_revision: 9, status: planStatus,
    plan: { status: planStatus }, dispatch: { dispatch_id: dispatchId, status },
  };
}

function asPersistedPending(job) {
  return { ...job, dispatch: { ...job.dispatch, status: 'pending' } };
}

test('every poster workbench lifecycle status has an explicit merge classification', () => {
  for (const status of recognizedStatuses) {
    const result = mergePosterJobUpdate(job('queued'), job(status));
    assert.equal(result.dispatch.status, status === 'queued' ? 'pending' : status, status);
  }
});

test('equal-revision terminal and review outcomes replace active transports', () => {
  for (const status of ['completed', 'PLAN_REVIEW', 'PLAN_CONFIRMED', 'ANALYSIS_FAILED', 'failed', 'send_failed', 'cancelled', 'abandoned']) {
    assert.deepEqual(mergePosterJobUpdate(job('processing'), job(status)), job(status), status);
  }
});

test('valid forward intermediate lifecycle transitions are accepted', () => {
  for (const [from, to] of [
    ['queued', 'claimed'], ['awaiting_codex_message', 'sending_to_codex'],
    ['claimed', 'sent'], ['sent', 'processing'], ['ANALYZING', 'finalizing'],
  ]) {
    assert.equal(mergePosterJobUpdate(job(from), job(to)).dispatch.status, to, `${from} -> ${to}`);
  }
});

test('completed and terminal outcomes never regress to equal-revision active transports', () => {
  for (const terminal of ['completed', 'PLAN_REVIEW', 'PLAN_CONFIRMED', 'ANALYSIS_FAILED', 'failed', 'send_failed', 'cancelled', 'abandoned']) {
    assert.deepEqual(mergePosterJobUpdate(job(terminal), job('processing')), job(terminal), terminal);
  }
});

test('equal-revision active transports do not regress to an earlier lifecycle phase', () => {
  for (const [from, stale] of [
    ['sending_to_codex', 'queued'], ['processing', 'sent'], ['finalizing', 'processing'],
  ]) {
    assert.deepEqual(mergePosterJobUpdate(job(from), job(stale)), job(from), `${from} <- ${stale}`);
  }
});

test('same-phase transport aliases can replace one another without replacing authoritative manifest data', () => {
  const current = { ...job('sent'), manifest: { layers: [{ status: 'GENERATING' }] } };
  const incoming = { ...job('host_accepted'), manifest: { layers: [{ status: 'PENDING' }] } };
  assert.deepEqual(mergePosterJobUpdate(current, incoming), {
    ...current,
    status: 'host_accepted',
    dispatch: { status: 'host_accepted' },
  });
});

test('a new candidate dispatch is accepted while the plan remains confirmed at the same revision', () => {
  const current = { job_id: 'poster-1', manifest_revision: 9, status: 'PLAN_CONFIRMED', plan: { status: 'PLAN_CONFIRMED' } };
  const incoming = dispatched({ status: 'queued', dispatchId: 'candidate-dispatch-1' });
  assert.deepEqual(mergePosterJobUpdate(current, incoming), asPersistedPending(incoming));
});

test('a new queued candidate dispatch replaces a completed analysis dispatch at the same revision', () => {
  const current = dispatched({ status: 'completed', dispatchId: 'analysis-dispatch-1', planStatus: 'PLAN_CONFIRMED' });
  const incoming = dispatched({ status: 'queued', dispatchId: 'candidate-dispatch-1' });
  assert.deepEqual(mergePosterJobUpdate(current, incoming), asPersistedPending(incoming));
});

test('a delayed update for an old dispatch cannot overwrite the newly submitted candidate dispatch', () => {
  const current = dispatched({ status: 'queued', dispatchId: 'candidate-dispatch-1' });
  const delayed = dispatched({ status: 'completed', dispatchId: 'analysis-dispatch-1' });
  assert.deepEqual(mergePosterJobUpdate(current, delayed), asPersistedPending(current));
});

test('the same dispatch is strictly monotonic and rejects sent-to-claimed regression', () => {
  const current = dispatched({ status: 'sent', dispatchId: 'candidate-dispatch-1' });
  const delayed = dispatched({ status: 'claimed', dispatchId: 'candidate-dispatch-1' });
  assert.deepEqual(mergePosterJobUpdate(current, delayed), current);
});

test('the same dispatch accepts all forward dispatch phases and terminal outcomes', () => {
  const phases = ['pending', 'claimed', 'delivered', 'sent', 'finalizing', 'completed'];
  for (let index = 1; index < phases.length; index += 1) {
    const current = dispatched({ status: phases[index - 1], dispatchId: 'candidate-dispatch-1' });
    const incoming = dispatched({ status: phases[index], dispatchId: 'candidate-dispatch-1' });
    assert.deepEqual(mergePosterJobUpdate(current, incoming), incoming, `${phases[index - 1]} -> ${phases[index]}`);
  }
});

test('the same foreground dispatch follows every persisted transition', () => {
  const transitions = [
    ['pending', 'claimed'],
    ['pending', 'cancelled'],
    ['claimed', 'pending'],
    ['claimed', 'delivered'],
    ['claimed', 'cancelled'],
    ['delivered', 'sent'],
    ['delivered', 'cancelled'],
    ['sent', 'finalizing'],
    ['sent', 'completed'],
    ['sent', 'cancelled'],
    ['finalizing', 'completed'],
    ['finalizing', 'cancelled'],
  ];
  for (const [from, to] of transitions) {
    const current = dispatched({ status: from, dispatchId: 'candidate-dispatch-1' });
    const incoming = dispatched({ status: to, dispatchId: 'candidate-dispatch-1' });
    assert.deepEqual(mergePosterJobUpdate(current, incoming), incoming, `${from} -> ${to}`);
  }
});

test('the same foreground dispatch rejects stale inverse transitions', () => {
  for (const [from, stale] of [
    ['sent', 'delivered'],
    ['sent', 'claimed'],
    ['delivered', 'claimed'],
    ['delivered', 'pending'],
    ['completed', 'sent'],
    ['cancelled', 'pending'],
  ]) {
    const current = dispatched({ status: from, dispatchId: 'candidate-dispatch-1' });
    const incoming = dispatched({ status: stale, dispatchId: 'candidate-dispatch-1' });
    assert.deepEqual(mergePosterJobUpdate(current, incoming), current, `${from} <- ${stale}`);
  }
});

test('a production candidate submission normalizes queued then follows persisted foreground states', () => {
  const submitted = dispatched({ status: 'queued', dispatchId: 'candidate-dispatch-1' });
  let current = mergePosterJobUpdate(null, submitted);
  assert.equal(current.dispatch.status, 'pending');
  assert.equal(posterWorkbenchView({ status: current.dispatch.status }).kind, 'queued');

  for (const status of ['pending', 'claimed', 'delivered', 'sent', 'finalizing', 'completed']) {
    const incoming = dispatched({ status, dispatchId: 'candidate-dispatch-1' });
    current = mergePosterJobUpdate(current, incoming);
    assert.equal(current.dispatch.status, status, status);
  }
});

test('a normalized queued candidate can advance to every reachable persisted dispatch state', () => {
  for (const status of ['claimed', 'delivered', 'sent', 'finalizing', 'completed']) {
    const queued = mergePosterJobUpdate(null, dispatched({ status: 'queued', dispatchId: 'candidate-dispatch-1' }));
    const incoming = dispatched({ status, dispatchId: 'candidate-dispatch-1' });
    assert.deepEqual(mergePosterJobUpdate(queued, incoming), incoming, `pending -> ${status}`);
  }
});

test('a stale synthetic queued response cannot regress an advanced candidate dispatch', () => {
  for (const status of ['claimed', 'delivered', 'sent', 'finalizing', 'completed']) {
    const queued = mergePosterJobUpdate(null, dispatched({ status: 'queued', dispatchId: 'candidate-dispatch-1' }));
    const current = mergePosterJobUpdate(queued, dispatched({ status, dispatchId: 'candidate-dispatch-1' }));
    const staleQueued = dispatched({ status: 'queued', dispatchId: 'candidate-dispatch-1' });
    assert.deepEqual(mergePosterJobUpdate(current, staleQueued), current, `${status} <- queued`);
  }
});
