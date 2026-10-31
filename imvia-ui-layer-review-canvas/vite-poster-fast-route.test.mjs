import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { layerReviewQueue } from './vite.config.js';
import { buildFastLayerSnapshot, createFastPosterPlan, suggestPosterFastLayers } from './src/poster-fast-plan.js';
import { posterFastCandidateAuthorizationId } from './src/poster-workbench-state.js';
import { initializePosterFastJob, readPosterJob, recordPosterGenerationFailure } from './src/poster-job-store.js';

const sourcePath = path.resolve('public/demo-source.png');

function routeHandlers() {
  const handlers = [];
  layerReviewQueue().configureServer({ middlewares: { use(handler) { handlers.push(handler); } } });
  return handlers;
}

async function request(handlers, url, body) {
  return new Promise((resolve, reject) => {
    const response = {
      statusCode: 200, headers: {}, setHeader(name, value) { this.headers[name] = value; },
      end(value = '') { resolve({ statusCode: this.statusCode, body: String(value) }); },
    };
    const bytes = Buffer.from(JSON.stringify(body));
    const requestValue = {
      method: 'POST', url, headers: { 'content-type': 'application/json' },
      async *[Symbol.asyncIterator]() { yield bytes; },
    };
    const dispatch = (index) => {
      const handler = handlers[index];
      if (!handler) return reject(new Error('poster API did not produce a response'));
      return handler(requestValue, response, () => dispatch(index + 1));
    };
    Promise.resolve(dispatch(0)).catch(reject);
  });
}

test('fast endpoint rejects an analysis dispatch request before it creates a job', async () => {
  const original = process.env.IMVIA_FEATURE_POSTER_LAYERING_MODE;
  process.env.IMVIA_FEATURE_POSTER_LAYERING_MODE = '1';
  try {
    const response = await request(routeHandlers(), '/api/poster-layer/jobs/fast', {
      analysis_dispatch: true,
      plan: { document_mode: 'poster' },
    });
    assert.equal(response.statusCode, 400);
    assert.match(response.body, /不允许分析 dispatch/);
  } finally {
    if (original === undefined) delete process.env.IMVIA_FEATURE_POSTER_LAYERING_MODE;
    else process.env.IMVIA_FEATURE_POSTER_LAYERING_MODE = original;
  }
});

test('candidate endpoint rejects a forged targeted snapshot before enqueueing', async () => {
  const original = process.env.IMVIA_FEATURE_POSTER_LAYERING_MODE;
  process.env.IMVIA_FEATURE_POSTER_LAYERING_MODE = '1';
  try {
    const response = await request(routeHandlers(), '/api/poster-layer/jobs/no-such-fast-job/candidates/3', {
      explicit_authorization: true, planning_mode: 'targeted_fast', expected_manifest_revision: 1,
      plan_version: 1, authorization_id: 'no-such-fast-job:1:3:1', snapshot_id: 'forged',
      layer_snapshot: { snapshot_id: 'forged', layer_index: 3, user_confirmed: true },
    });
    assert.equal(response.statusCode, 404);
  } finally {
    if (original === undefined) delete process.env.IMVIA_FEATURE_POSTER_LAYERING_MODE;
    else process.env.IMVIA_FEATURE_POSTER_LAYERING_MODE = original;
  }
});

test('candidate endpoint accepts deterministic first and subsequent fast authorizations', async () => {
  const previousCwd = process.cwd();
  const outputRoot = await mkdtemp(path.join(os.tmpdir(), 'poster-fast-route-'));
  await mkdir(path.join(outputRoot, 'output'), { recursive: true });
  const jobId = 'poster-fast-route';
  const source = { path: 'source.png', width: 1500, height: 3664, aspect_ratio: 1500 / 3664, target_2x: false };
  const layers = suggestPosterFastLayers({ data: new Uint8ClampedArray(4), width: 1, height: 1 });
  const basePlan = createFastPosterPlan({
    job_id: jobId, project_id: 'project-fast-route', image_id: 'image-fast-route', source,
    document_mode: 'poster', status: 'PLAN_REVIEW', output_directory: `output/poster-jobs/${jobId}`, layers,
  });
  const { plan, snapshot } = buildFastLayerSnapshot(basePlan, 1, {}, '2026-08-22T00:00:00.000Z');
  const original = process.env.IMVIA_FEATURE_POSTER_LAYERING_MODE;
  process.env.IMVIA_FEATURE_POSTER_LAYERING_MODE = '1';
  try {
    await initializePosterFastJob({ outputRoot: path.join(outputRoot, 'output'), jobId, sourcePath, plan });
    process.chdir(outputRoot);
    const firstRecord = await readPosterJob(path.join(outputRoot, 'output'), jobId);
    const firstAuthorizationId = posterFastCandidateAuthorizationId(
      jobId, plan.plan_version, 1, firstRecord.manifest,
    );
    const first = await request(routeHandlers(), `/api/poster-layer/jobs/${jobId}/candidates/1`, {
      explicit_authorization: true, planning_mode: 'targeted_fast',
      expected_manifest_revision: firstRecord.manifest.revision, plan_version: plan.plan_version,
      authorization_id: firstAuthorizationId, snapshot_id: snapshot.snapshot_id, layer_snapshot: snapshot,
    });
    assert.equal(first.statusCode, 202);
    assert.equal(JSON.parse(first.body).status, 'queued');

    const afterFirst = await readPosterJob(path.join(outputRoot, 'output'), jobId);
    const firstAuthorization = afterFirst.manifest.authorizations.find((authorization) => authorization.layer_index === 1);
    await recordPosterGenerationFailure({
      outputRoot: path.join(outputRoot, 'output'), jobId, layerIndex: 1,
      authorizationId: firstAuthorization.authorization_id,
      candidateNumber: firstAuthorization.candidate_number,
      planVersion: firstAuthorization.plan_version,
      dispatchId: JSON.parse(first.body).dispatch_id,
      error: 'test candidate rejected', failureCodes: ['GENERATION_FAILED'],
    });
    const secondRecord = await readPosterJob(path.join(outputRoot, 'output'), jobId);
    const retry = await request(routeHandlers(), `/api/poster-layer/jobs/${jobId}/layers/1/retry`, {
      expected_manifest_revision: secondRecord.manifest.revision,
    });
    assert.equal(retry.statusCode, 200);
    const retriedRecord = await readPosterJob(path.join(outputRoot, 'output'), jobId);
    const secondAuthorizationId = posterFastCandidateAuthorizationId(
      jobId, plan.plan_version, 1, retriedRecord.manifest,
    );
    assert.equal(secondAuthorizationId, `${jobId}:1:1:2`);
    const second = await request(routeHandlers(), `/api/poster-layer/jobs/${jobId}/candidates/1`, {
      explicit_authorization: true, planning_mode: 'targeted_fast',
      expected_manifest_revision: retriedRecord.manifest.revision, plan_version: plan.plan_version,
      authorization_id: secondAuthorizationId, snapshot_id: snapshot.snapshot_id, layer_snapshot: snapshot,
    });
    assert.equal(second.statusCode, 202);
    assert.equal(JSON.parse(second.body).status, 'queued');
  } finally {
    process.chdir(previousCwd);
    if (original === undefined) delete process.env.IMVIA_FEATURE_POSTER_LAYERING_MODE;
    else process.env.IMVIA_FEATURE_POSTER_LAYERING_MODE = original;
    await rm(outputRoot, { recursive: true, force: true });
  }
});
