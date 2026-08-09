import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveNodeResultState } from './result-version-state.js';

const sourceSize = { width: 658, height: 1424 };
const fixtureNode = {
  id: 'hero-title',
  bounds: { x: 12, y: 8, width: 42, height: 16 },
};

function job({
  id,
  status,
  images = [],
  nodeIds = ['hero-title'],
  parentJobId,
  parent_job_id,
  submittedAt,
  completedAt,
}) {
  return {
    id,
    status,
    images,
    nodeIds,
    parentJobId,
    parent_job_id,
    submittedAt,
    completedAt,
  };
}

function png(name) {
  return { name, url: `/results/${name}` };
}

test('a pending revision keeps the previous completed PNG visible', () => {
  const state = resolveNodeResultState({
    jobs: [
      job({ id: 'base', status: 'completed', images: [png('base.png')], submittedAt: 100, completedAt: 200 }),
      job({ id: 'revision', status: 'processing', parentJobId: 'base', submittedAt: 300 }),
    ],
    node: fixtureNode,
    sourceSize,
  });

  assert.equal(state.baseResult.job.id, 'base');
  assert.equal(state.baseResult.image.name, 'base.png');
  assert.equal(state.pendingRevision.job.id, 'revision');
});

test('a failed revision keeps the base PNG and a completed revision atomically becomes the base', () => {
  const baseJob = job({ id: 'base', status: 'completed', images: [png('base.png')], submittedAt: 100, completedAt: 200 });
  const failedRevision = job({ id: 'revision-failed', status: 'failed', parent_job_id: 'base', submittedAt: 300, completedAt: 350 });
  const completedRevision = job({
    id: 'revision-complete',
    status: 'completed',
    parentJobId: 'base',
    images: [png('revision.png')],
    submittedAt: 400,
    completedAt: 500,
  });

  assert.equal(resolveNodeResultState({ jobs: [baseJob, failedRevision], node: fixtureNode, sourceSize }).baseResult.job.id, 'base');
  assert.equal(resolveNodeResultState({ jobs: [baseJob, failedRevision], node: fixtureNode, sourceSize }).failedRevision.job.id, 'revision-failed');
  const completedState = resolveNodeResultState({ jobs: [baseJob, completedRevision], node: fixtureNode, sourceSize });
  assert.equal(completedState.baseResult.job.id, 'revision-complete');
  assert.deepEqual(completedState.history.map((item) => item.job.id), ['base', 'revision-complete']);
});

test('cancelled and image-less completions cannot hide a previous valid PNG', () => {
  const state = resolveNodeResultState({
    jobs: [
      job({ id: 'base', status: 'completed', images: [png('base.png')], submittedAt: 100, completedAt: 200 }),
      job({ id: 'cancelled-revision', status: 'cancelled', parentJobId: 'base', submittedAt: 300 }),
      job({ id: 'empty-completion', status: 'completed', parentJobId: 'base', submittedAt: 400, completedAt: 500 }),
    ],
    node: fixtureNode,
    sourceSize,
  });

  assert.equal(state.baseResult.job.id, 'base');
  assert.equal(state.pendingRevision, null);
  assert.equal(state.failedRevision, null);
  assert.deepEqual(state.history.map((item) => item.job.id), ['base']);
});

test('matches a multi-layer result by normalized node filename without mutating job order', () => {
  const jobs = [
    job({
      id: 'older',
      status: 'completed',
      nodeIds: ['hero-title', 'button'],
      images: [png('button.png'), png('HERO_TITLE-final.png')],
      submittedAt: 100,
      completedAt: 200,
    }),
    job({
      id: 'newer',
      status: 'completed',
      nodeIds: ['hero-title', 'button'],
      images: [png('button-revision.png'), png('hero title revision.png')],
      submittedAt: 300,
      completedAt: 400,
    }),
  ];

  const state = resolveNodeResultState({ jobs, node: fixtureNode, sourceSize });

  assert.equal(state.baseResult.job.id, 'newer');
  assert.equal(state.baseResult.image.name, 'hero title revision.png');
  assert.deepEqual(jobs.map((item) => item.id), ['older', 'newer']);
});

test('uses the only image for a single-node job and preserves its layer snapshot', () => {
  const state = resolveNodeResultState({
    jobs: [job({
      id: 'single',
      status: 'completed',
      images: [png('opaque-export.png')],
      submittedAt: 100,
      completedAt: 200,
    })],
    node: fixtureNode,
    sourceSize,
  });

  assert.equal(state.baseResult.image.name, 'opaque-export.png');
  assert.deepEqual(state.baseResult.bounds, fixtureNode.bounds);
  assert.deepEqual(state.baseResult.sourceSize, sourceSize);
});
