import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, unlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { initializePosterJob, mutatePosterJob, readPosterJob } from '../src/poster-job-store.js';
import { finalizePosterAnalysis } from './finalize-poster-analysis.mjs';
import { preparePosterJob } from './prepare-poster-job.mjs';
import {
  acknowledgeForegroundDispatch,
  claimNextForegroundDispatchFromRoots,
  enqueueForegroundDispatch,
  finalizeForegroundDispatch,
  markForegroundDispatchDelivered,
  readForegroundDispatch,
} from '../src/foreground-dispatch.js';
import { controlPosterDispatch } from '../src/poster-dispatch-control.js';
import { layerReviewQueue } from '../vite.config.js';

const sourcePath = path.resolve('public/demo-source.png');

function plan() {
  return {
    version: '1.0', task: 'poster_layering', job_id: 'poster-job-1', project_id: 'project-1', image_id: 'image-1',
    source: { path: 'source.png', width: 1500, height: 3664, aspect_ratio: 1500 / 3664, target_2x: false },
    document_mode: 'poster', status: 'PLAN_REVIEW', plan_version: 1,
    skill_contract: { base: 'lovart-poster-layering-v3-1', adapter: 'imvia-poster-layering-workbench-v1', auto_retry: false, full_canvas: true },
    layers: [{
      layer_index: 1, layer_name: 'Title', asset_role: 'headline', layer_type: 'graphic', z_order: 1,
      position: 'top center', visible_content: ['Title'], included_content: ['Title'], excluded_content: [],
      occludes: [], occluded_by: [], source_evidence: [{ description: 'title', path: 'evidence/title.json', region: [0, 0, 1, 1] }],
      support_components: [], ui_independence: 'not_applicable',
      repair_envelope: { description: '', covered_segment: [], seam_band: '', forbidden_regions: [] },
      locked_visible_anchors: ['glyphs'], completion_required: false, completion_regions: [], risk_level: 'high',
      processing_mode: 'graphic_completion', fill_color: '#00FF00', compositing_mode: 'Normal', separation_reason: 'independent title', status: 'PENDING',
    }], output_directory: 'ignored',
  };
}

function analyzingPlan() {
  return { ...plan(), status: 'ANALYZING', layers: [] };
}

async function routedAnalysisFixture(context, { confirmModel = true, outputRoot: suppliedOutputRoot } = {}) {
  const outputRoot = suppliedOutputRoot || await mkdtemp(path.join(os.tmpdir(), 'finalize-analysis-routed-'));
  context.after(() => rm(outputRoot, { recursive: true, force: true }));
  const record = await initializePosterJob({ outputRoot, jobId: 'poster-job-1', sourcePath, plan: analyzingPlan() });
  const dispatchId = randomUUID();
  const prepared = await preparePosterJob({ outputRoot, jobId: 'poster-job-1', phase: 'analysis', dispatchId });
  await enqueueForegroundDispatch(record.paths.root, {
    jobId: 'poster-job-1', taskKind: 'poster_analysis', planPath: record.paths.plan,
    planVersion: prepared.plan_version, prompt: 'analysis', submittedAt: '2026-08-20T10:00:00.000Z', dispatchId,
  });
  const claim = await claimNextForegroundDispatchFromRoots([path.join(outputRoot, 'poster-jobs')], { bridgeId: 'bridge' });
  assert.deepEqual(
    { jobId: claim.jobId, dispatchId: claim.dispatchId, rootKind: claim.rootKind, taskKind: claim.taskKind },
    { jobId: 'poster-job-1', dispatchId, rootKind: 'poster', taskKind: 'poster_analysis' },
  );
  await markForegroundDispatchDelivered(record.paths.root, {
    bridgeId: 'bridge', claimToken: claim.claimToken, dispatchId, rootKind: 'poster',
  });
  if (confirmModel) {
    await acknowledgeForegroundDispatch(record.paths.root, undefined, {
      dispatchId, rootKind: 'poster', confirmationSource: 'codex_model_tool',
    });
  }
  await writeFile(path.join(record.paths.evidence, 'title.json'), '{}');
  const submitted = { ...plan(), output_directory: record.paths.root };
  const submittedPath = path.join(record.paths.evidence, 'poster-layer-plan.candidate.json');
  await writeFile(submittedPath, JSON.stringify(submitted));
  return { outputRoot, record, dispatchId, submitted, submittedPath };
}

async function invokePosterApi({ method, url, body }) {
  const handlers = [];
  layerReviewQueue().configureServer({
    middlewares: { use(handler) { handlers.push(handler); } },
  });
  const bytes = body === undefined ? [] : [Buffer.from(JSON.stringify(body))];
  return new Promise((resolve, reject) => {
    const response = {
      statusCode: 200,
      setHeader() {},
      end(payload = '') {
        resolve({ statusCode: this.statusCode, body: String(payload) });
      },
    };
    const request = {
      method,
      url,
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      async *[Symbol.asyncIterator]() { yield* bytes; },
    };
    const dispatch = (index) => {
      const handler = handlers[index];
      if (!handler) return reject(new Error('poster API did not produce a response'));
      return handler(request, response, () => dispatch(index + 1));
    };
    Promise.resolve(dispatch(0)).catch(reject);
  });
}

test('routed analysis finalization initializes the first candidate lifecycle for the HTTP route', async (context) => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'finalize-analysis-http-'));
  const outputRoot = path.join(workspace, 'output');
  const originalCwd = process.cwd();
  context.after(async () => {
    process.chdir(originalCwd);
    await rm(workspace, { recursive: true, force: true });
  });

  await mkdir(outputRoot, { recursive: true });
  const fixture = await routedAnalysisFixture(context, { outputRoot });
  const { record, dispatchId, submitted, submittedPath } = fixture;
  delete submitted.layers[0].status;
  await writeFile(submittedPath, JSON.stringify(submitted));
  await finalizePosterAnalysis({ outputRoot: fixture.outputRoot, jobId: 'poster-job-1', analysisPlanPath: submittedPath, dispatchId });

  const finalized = await readPosterJob(fixture.outputRoot, 'poster-job-1');
  assert.equal(finalized.manifest.layers[0].status, 'PENDING');
  assert.equal(finalized.manifest.layers[0].authorization_plan_version, finalized.plan.plan_version);
  assert.equal(finalized.manifest.layers[0].authorization_consumed, false);
  assert.equal(finalized.manifest.layers[0].generation_count, 0);
  assert.equal(finalized.manifest.layers[0].candidate_output, undefined);
  assert.equal(finalized.manifest.layers[0].visual_inspection, undefined);

  process.chdir(workspace);
  const confirmed = await invokePosterApi({
    method: 'POST', url: '/api/poster-layer/jobs/poster-job-1/plan/confirm',
    body: { expected_manifest_revision: finalized.manifest.revision },
  });
  assert.equal(confirmed.statusCode, 200);
  const confirmedJob = JSON.parse(confirmed.body);
  const authorized = await invokePosterApi({
    method: 'POST', url: '/api/poster-layer/jobs/poster-job-1/candidates/1',
    body: {
      explicit_authorization: true,
      expected_manifest_revision: confirmedJob.manifest_revision,
      plan_version: confirmedJob.plan.plan_version,
    },
  });
  assert.equal(authorized.statusCode, 202);
  const queued = JSON.parse(authorized.body);
  const prepared = await readPosterJob(fixture.outputRoot, 'poster-job-1');
  assert.equal(prepared.manifest.layers[0].status, 'GENERATING');
  assert.equal(prepared.manifest.layers[0].generation_count, 1);
  const candidateDispatch = JSON.parse(await readFile(
    path.join(prepared.paths.root, 'foreground-dispatches', `${queued.dispatch_id}.json`), 'utf8',
  ));
  assert.equal(candidateDispatch.taskKind, 'poster_candidate');
  assert.match(candidateDispatch.prompt, /imvia-poster-layering-workbench-v1/);
  assert.match(candidateDispatch.prompt, /finalize-poster-generation-failure/);
  assert.match(candidateDispatch.prompt, /没有返回可用 PNG 或审核报告/);

  const retry = await invokePosterApi({
    method: 'POST', url: '/api/poster-layer/jobs/poster-job-1/candidates/1',
    body: {
      explicit_authorization: true,
      expected_manifest_revision: prepared.manifest.revision,
      plan_version: prepared.plan.plan_version,
    },
  });
  assert.equal(retry.statusCode, 400);
  const candidateDispatches = await Promise.all((await readdir(path.join(prepared.paths.root, 'foreground-dispatches')))
    .filter((name) => name.endsWith('.json'))
    .map(async (name) => JSON.parse(await readFile(path.join(prepared.paths.root, 'foreground-dispatches', name), 'utf8'))));
  assert.equal(candidateDispatches.filter((entry) => entry.taskKind === 'poster_candidate').length, 1);
});

test('candidate enqueue failure rolls its exact reservation back before a retry queues once', async (context) => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'candidate-enqueue-rollback-'));
  const outputRoot = path.join(workspace, 'output');
  const originalCwd = process.cwd();
  context.after(async () => {
    process.chdir(originalCwd);
    await rm(workspace, { recursive: true, force: true });
  });
  await mkdir(outputRoot, { recursive: true });
  const fixture = await routedAnalysisFixture(context, { outputRoot });
  await finalizePosterAnalysis({
    outputRoot, jobId: 'poster-job-1', analysisPlanPath: fixture.submittedPath, dispatchId: fixture.dispatchId,
  });
  process.chdir(workspace);
  const beforeConfirm = await readPosterJob(outputRoot, 'poster-job-1');
  const confirmed = await invokePosterApi({
    method: 'POST', url: '/api/poster-layer/jobs/poster-job-1/plan/confirm',
    body: { expected_manifest_revision: beforeConfirm.manifest.revision },
  });
  assert.equal(confirmed.statusCode, 200);
  const confirmedJob = JSON.parse(confirmed.body);
  await rm(path.join(fixture.record.paths.root, 'foreground-dispatches'), { recursive: true });
  await writeFile(path.join(fixture.record.paths.root, 'foreground-dispatches'), 'injected enqueue failure');
  const attempted = await invokePosterApi({
    method: 'POST', url: '/api/poster-layer/jobs/poster-job-1/candidates/1',
    body: { explicit_authorization: true, expected_manifest_revision: confirmedJob.manifest_revision,
      plan_version: confirmedJob.plan.plan_version },
  });
  assert.equal(attempted.statusCode, 400);
  const rolledBack = await readPosterJob(outputRoot, 'poster-job-1');
  assert.equal(rolledBack.manifest.layers[0].status, 'PENDING');
  assert.equal(rolledBack.manifest.layers[0].authorization_consumed, false);
  assert.deepEqual(rolledBack.manifest.authorizations, []);
  await unlink(path.join(fixture.record.paths.root, 'foreground-dispatches'));
  const retried = await invokePosterApi({
    method: 'POST', url: '/api/poster-layer/jobs/poster-job-1/candidates/1',
    body: { explicit_authorization: true, expected_manifest_revision: rolledBack.manifest.revision,
      plan_version: rolledBack.plan.plan_version },
  });
  assert.equal(retried.statusCode, 202);
  const dispatches = await Promise.all((await readdir(path.join(fixture.record.paths.root, 'foreground-dispatches')))
    .map(async (name) => JSON.parse(await readFile(path.join(fixture.record.paths.root, 'foreground-dispatches', name), 'utf8'))));
  assert.equal(dispatches.filter((dispatch) => dispatch.taskKind === 'poster_candidate').length, 1);
});

test('poster job refresh reconciles a prepare-only routed crash before exposing GENERATING state', async (context) => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'candidate-refresh-reconcile-'));
  const outputRoot = path.join(workspace, 'output');
  const originalCwd = process.cwd();
  context.after(async () => { process.chdir(originalCwd); await rm(workspace, { recursive: true, force: true }); });
  await mkdir(outputRoot, { recursive: true });
  const fixture = await routedAnalysisFixture(context, { outputRoot });
  await finalizePosterAnalysis({ outputRoot, jobId: 'poster-job-1', analysisPlanPath: fixture.submittedPath, dispatchId: fixture.dispatchId });
  process.chdir(workspace);
  const initial = await readPosterJob(outputRoot, 'poster-job-1');
  const confirmed = await invokePosterApi({ method: 'POST', url: '/api/poster-layer/jobs/poster-job-1/plan/confirm', body: { expected_manifest_revision: initial.manifest.revision } });
  assert.equal(confirmed.statusCode, 200);
  let current = await readPosterJob(outputRoot, 'poster-job-1');
  current = await mutatePosterJob(outputRoot, 'poster-job-1', current.manifest.revision, (record) => ({
    ...record, manifest: { ...record.manifest, layers: record.manifest.layers.map((layer) => layer.layer_index === 1 ? {
      ...layer, status: 'GENERATION_AUTHORIZED', authorization_plan_version: record.plan.plan_version,
    } : layer) },
  }));
  await preparePosterJob({ outputRoot, jobId: 'poster-job-1', phase: 'candidate', layerIndex: 1, dispatchId: 'prepare-only-crash' });
  await mkdir(path.join(fixture.record.paths.root, 'foreground-dispatches'), { recursive: true });
  await writeFile(path.join(fixture.record.paths.root, 'foreground-dispatches', 'prepare-only-crash.json'), '{');
  const refreshed = await invokePosterApi({ method: 'GET', url: '/api/poster-layer/jobs/poster-job-1' });
  assert.equal(refreshed.statusCode, 200);
  const body = JSON.parse(refreshed.body);
  assert.equal(body.manifest.layers[0].status, 'GENERATION_AUTHORIZED');
  assert.equal(body.manifest.layers[0].authorization_consumed, false);
  assert.deepEqual(body.manifest.authorizations, []);
  assert.equal((await readPosterJob(outputRoot, 'poster-job-1')).manifest.revision, current.manifest.revision + 2);
});

test('analysis finalization allowlists ownership fields and strips lifecycle aliases', async (context) => {
  const fixture = await routedAnalysisFixture(context);
  const { outputRoot, dispatchId, submitted, submittedPath } = fixture;
  const layer = submitted.layers[0];
  Object.assign(layer, {
    status: 'ACCEPTED', generation_count: 99, generationCount: 99,
    authorization_plan_version: 'stale-snake', authorizationPlanVersion: 'stale-camel',
    accepted: true, accepted_at: '2026-08-21T00:00:00.000Z', acceptedAt: '2026-08-21T00:00:00.000Z',
    accepted_candidate_id: 'accepted-snake', acceptedCandidateId: 'accepted-camel',
    accepted_plan_version: 'accepted-plan-snake', acceptedPlanVersion: 'accepted-plan-camel',
    authorization_id: 'authorization-snake', authorizationId: 'authorization-camel',
    candidate_number: 9, candidateNumber: 9, candidate_sha256: 'a'.repeat(64), candidateSha256: 'b'.repeat(64),
    accepted_source_output: '/unsafe/snake.png', acceptedSourceOutput: '/unsafe/camel.png',
    retry_authorization_id: 'retry-snake', retryAuthorizationId: 'retry-camel',
    superseded_acceptances: [{ source_output: '/unsafe/snake-history.png' }],
    supersededAcceptances: [{ sourceOutput: '/unsafe/camel-history.png' }],
    candidates: [{ candidate_id: 'candidate-snake' }], candidate_versions: [{ candidate_id: 'version-snake' }],
    candidateVersions: [{ candidateId: 'version-camel' }], authorizations: [{ authorization_id: 'authorization-list' }],
  });
  await writeFile(submittedPath, JSON.stringify(submitted));

  await finalizePosterAnalysis({ outputRoot, jobId: 'poster-job-1', analysisPlanPath: submittedPath, dispatchId });
  const saved = (await readPosterJob(outputRoot, 'poster-job-1')).manifest.layers[0];
  const ownershipFields = [
    'layer_index', 'layer_name', 'asset_role', 'layer_type', 'z_order', 'position',
    'visible_content', 'included_content', 'excluded_content', 'occludes', 'occluded_by',
    'source_evidence', 'support_components', 'ui_independence', 'repair_envelope',
    'locked_visible_anchors', 'completion_required', 'completion_regions', 'risk_level',
    'processing_mode', 'fill_color', 'compositing_mode', 'separation_reason',
  ];
  assert.deepEqual(
    Object.fromEntries(ownershipFields.map((field) => [field, saved[field]])),
    Object.fromEntries(ownershipFields.map((field) => [field, layer[field]])),
  );
  assert.equal(saved.status, 'PENDING');
  assert.equal(saved.authorization_plan_version, submitted.plan_version);
  assert.equal(saved.authorization_consumed, false);
  assert.equal(saved.generation_count, 0);
  for (const field of [
    'generationCount', 'authorizationPlanVersion',
    'accepted', 'accepted_at', 'acceptedAt', 'accepted_candidate_id', 'acceptedCandidateId',
    'accepted_plan_version', 'acceptedPlanVersion',
    'authorization_id', 'authorizationId', 'candidate_number', 'candidateNumber',
    'candidate_sha256', 'candidateSha256', 'accepted_source_output', 'acceptedSourceOutput',
    'retry_authorization_id', 'retryAuthorizationId', 'superseded_acceptances', 'supersededAcceptances',
    'candidates', 'candidate_versions', 'candidateVersions', 'authorizations',
  ]) assert.equal(Object.hasOwn(saved, field), false, field);
});

test('routed analysis finalization completes its dispatch and releases the next queued job', async (context) => {
  const outputRoot = await mkdtemp(path.join(os.tmpdir(), 'finalize-analysis-'));
  context.after(() => rm(outputRoot, { recursive: true, force: true }));
  const record = await initializePosterJob({ outputRoot, jobId: 'poster-job-1', sourcePath, plan: plan() });
  const dispatchId = randomUUID();
  const prepared = await preparePosterJob({ outputRoot, jobId: 'poster-job-1', phase: 'analysis', dispatchId });
  await enqueueForegroundDispatch(record.paths.root, { jobId: 'poster-job-1', taskKind: 'poster_analysis', planPath: record.paths.plan,
    planVersion: prepared.plan_version, prompt: 'analysis', submittedAt: '2026-08-20T10:00:00.000Z', dispatchId });
  const jobsDirectory = path.join(outputRoot, 'jobs');
  const nextDirectory = path.join(jobsDirectory, 'next-ui');
  await mkdir(nextDirectory, { recursive: true });
  await writeFile(path.join(nextDirectory, 'layer-review-plan.json'), JSON.stringify({ status: 'queued' }));
  await enqueueForegroundDispatch(nextDirectory, { jobId: 'next-ui', prompt: 'next', submittedAt: '2026-08-20T10:00:01.000Z' });
  const claim = await claimNextForegroundDispatchFromRoots([path.join(outputRoot, 'poster-jobs'), jobsDirectory], { bridgeId: 'bridge' });
  assert.deepEqual(
    { jobId: claim.jobId, dispatchId: claim.dispatchId, rootKind: claim.rootKind, taskKind: claim.taskKind },
    { jobId: 'poster-job-1', dispatchId, rootKind: 'poster', taskKind: 'poster_analysis' },
  );
  assert.equal((await readForegroundDispatch(record.paths.root, { dispatchId, rootKind: 'poster' })).status, 'claimed');
  await markForegroundDispatchDelivered(record.paths.root, { bridgeId: 'bridge', claimToken: claim.claimToken, dispatchId, rootKind: 'poster' });
  assert.equal((await readForegroundDispatch(record.paths.root, { dispatchId, rootKind: 'poster' })).status, 'delivered');
  await acknowledgeForegroundDispatch(record.paths.root, undefined, { dispatchId, rootKind: 'poster', confirmationSource: 'codex_model_tool' });
  assert.equal((await readForegroundDispatch(record.paths.root, { dispatchId, rootKind: 'poster' })).status, 'sent');
  await mkdir(path.dirname(path.join(record.paths.evidence, 'title.json')), { recursive: true });
  await writeFile(path.join(record.paths.evidence, 'title.json'), '{}');
  const submitted = { ...plan(), output_directory: record.paths.root };
  const submittedPath = path.join(record.paths.evidence, 'poster-layer-plan.candidate.json');
  await writeFile(submittedPath, JSON.stringify(submitted));

  const result = await finalizePosterAnalysis({ outputRoot, jobId: 'poster-job-1', analysisPlanPath: submittedPath, dispatchId });
  assert.equal(result.status, 'PLAN_REVIEW');
  assert.equal((await readPosterJob(outputRoot, 'poster-job-1')).plan.status, 'PLAN_REVIEW');
  assert.deepEqual(await (await import('node:fs/promises')).readdir(record.paths.candidates), []);
  assert.equal(JSON.parse(await readFile(record.paths.plan, 'utf8')).source.path, 'source.png');
  assert.equal((await readPosterJob(outputRoot, 'poster-job-1')).manifest.layers[0].layer_name, 'Title');
  assert.equal((await readForegroundDispatch(record.paths.root, { dispatchId, rootKind: 'poster' })).status, 'completed');
  const nextClaim = await claimNextForegroundDispatchFromRoots([path.join(outputRoot, 'poster-jobs'), jobsDirectory], { bridgeId: 'bridge' });
  assert.deepEqual(
    { jobId: nextClaim.jobId, rootKind: nextClaim.rootKind, taskKind: nextClaim.taskKind },
    { jobId: 'next-ui', rootKind: 'ui', taskKind: 'ui_layer_review' },
  );
  await assert.rejects(finalizePosterAnalysis({ outputRoot, jobId: 'poster-job-1', analysisPlanPath: submittedPath, dispatchId }), /结束|取消/);
});

test('routed analysis finalization fails closed without its dispatch identity', async (context) => {
  const outputRoot = await mkdtemp(path.join(os.tmpdir(), 'finalize-analysis-'));
  context.after(() => rm(outputRoot, { recursive: true, force: true }));
  await assert.rejects(finalizePosterAnalysis({ outputRoot, jobId: 'poster-job-1', analysisPlanPath: 'ignored' }), /dispatchId is required/);
});

test('analysis finalization rejects a stale version and direct authoritative-plan input', async (context) => {
  const outputRoot = await mkdtemp(path.join(os.tmpdir(), 'finalize-analysis-'));
  context.after(() => rm(outputRoot, { recursive: true, force: true }));
  const record = await initializePosterJob({ outputRoot, jobId: 'poster-job-1', sourcePath, plan: plan() });
  await preparePosterJob({ outputRoot, jobId: 'poster-job-1', phase: 'analysis' });
  await writeFile(path.join(record.paths.evidence, 'title.json'), '{}');
  const submitted = { ...plan(), output_directory: record.paths.root, plan_version: 99 };
  const candidatePath = path.join(record.paths.evidence, 'poster-layer-plan.candidate.json');
  await writeFile(candidatePath, JSON.stringify(submitted));
  await assert.rejects(finalizePosterAnalysis({ outputRoot, jobId: 'poster-job-1', analysisPlanPath: candidatePath, trustedInternal: true }), /stale/);
  await assert.rejects(finalizePosterAnalysis({ outputRoot, jobId: 'poster-job-1', analysisPlanPath: record.paths.plan, trustedInternal: true }), /trusted evidence candidate/);
});

test('analysis finalization rejects evidence that escapes the evidence directory', async (context) => {
  const outputRoot = await mkdtemp(path.join(os.tmpdir(), 'finalize-analysis-'));
  context.after(() => rm(outputRoot, { recursive: true, force: true }));
  const record = await initializePosterJob({ outputRoot, jobId: 'poster-job-1', sourcePath, plan: plan() });
  await preparePosterJob({ outputRoot, jobId: 'poster-job-1', phase: 'analysis' });
  const submitted = plan();
  submitted.output_directory = record.paths.root;
  submitted.layers[0].source_evidence[0].path = 'source.png';
  const submittedPath = path.join(record.paths.evidence, 'poster-layer-plan.candidate.json');
  await writeFile(submittedPath, JSON.stringify(submitted));

  await assert.rejects(
    finalizePosterAnalysis({ outputRoot, jobId: 'poster-job-1', analysisPlanPath: submittedPath, trustedInternal: true }),
    /evidence path escapes/,
  );
});

test('routed analysis retry reconciles an exact plan-only finalizing crash', async (context) => {
  const fixture = await routedAnalysisFixture(context);
  const { outputRoot, record, dispatchId, submitted, submittedPath } = fixture;
  const manifestBeforeCrash = structuredClone((await readPosterJob(outputRoot, 'poster-job-1')).manifest);

  await assert.rejects(finalizeForegroundDispatch(record.paths.root, {
    dispatchId, rootKind: 'poster', binding: { taskKind: 'poster_analysis', planVersion: submitted.plan_version },
    publish: async () => {
      await writeFile(record.paths.plan, JSON.stringify(submitted));
      throw new Error('simulated crash after analysis plan publication');
    },
  }), (error) => {
    assert.equal(error.message, 'simulated crash after analysis plan publication');
    return true;
  });
  const crashed = await readPosterJob(outputRoot, 'poster-job-1');
  assert.deepEqual(crashed.plan, submitted);
  assert.deepEqual(crashed.manifest, manifestBeforeCrash);
  assert.equal((await readForegroundDispatch(record.paths.root, { dispatchId, rootKind: 'poster' })).status, 'finalizing');

  const result = await finalizePosterAnalysis({
    outputRoot, jobId: 'poster-job-1', analysisPlanPath: submittedPath, dispatchId,
  });
  assert.equal(result.status, 'PLAN_REVIEW');
  const saved = await readPosterJob(outputRoot, 'poster-job-1');
  assert.deepEqual(saved.plan, submitted);
  assert.equal(saved.manifest.phase, 'PLAN_REVIEW');
  assert.equal(saved.manifest.layers[0].layer_name, submitted.layers[0].layer_name);
  assert.equal(saved.manifest.layers[0].status, 'PENDING');
  assert.equal(saved.manifest.layers[0].authorization_plan_version, submitted.plan_version);
  assert.equal(saved.manifest.layers[0].authorization_consumed, false);
  assert.equal(saved.manifest.layers[0].generation_count, 0);
  assert.equal(saved.manifest.layers[0].candidate_output, undefined);
  assert.equal(saved.manifest.layers[0].visual_inspection, undefined);
  assert.equal(saved.manifest.analysis_preflight, undefined);
  assert.equal((await readForegroundDispatch(record.paths.root, { dispatchId, rootKind: 'poster' })).status, 'completed');
});

test('routed analysis retry rejects a mismatched plan-only finalizing state', async (context) => {
  const fixture = await routedAnalysisFixture(context);
  const { outputRoot, record, dispatchId, submitted, submittedPath } = fixture;
  const manifestBeforeCrash = structuredClone((await readPosterJob(outputRoot, 'poster-job-1')).manifest);
  const mismatchedPlan = structuredClone(submitted);
  mismatchedPlan.source.target_2x = true;

  await assert.rejects(finalizeForegroundDispatch(record.paths.root, {
    dispatchId, rootKind: 'poster',
    publish: async () => {
      await writeFile(record.paths.plan, JSON.stringify(mismatchedPlan));
      throw new Error('simulated crash after mismatched analysis plan publication');
    },
  }));
  await assert.rejects(finalizePosterAnalysis({
    outputRoot, jobId: 'poster-job-1', analysisPlanPath: submittedPath, dispatchId,
  }), (error) => {
    assert.equal(error.message, 'analysis preflight is missing or authoritative plan changed');
    return true;
  });
  const saved = await readPosterJob(outputRoot, 'poster-job-1');
  assert.deepEqual(saved.plan, mismatchedPlan);
  assert.deepEqual(saved.manifest, manifestBeforeCrash);
  assert.equal((await readForegroundDispatch(record.paths.root, { dispatchId, rootKind: 'poster' })).status, 'finalizing');
});

for (const action of ['cancel', 'abandon']) {
  test(`${action}ed routed analysis dispatch rejects its public finalizer without publishing`, async (context) => {
    const fixture = await routedAnalysisFixture(context, { confirmModel: action === 'abandon' });
    const { outputRoot, record, dispatchId, submittedPath } = fixture;
    const beforeControl = await readPosterJob(outputRoot, 'poster-job-1');

    const controlled = await controlPosterDispatch(record.paths.root, { dispatchId, action });
    assert.equal(controlled.status, 'CANCELLED');
    await assert.rejects(finalizePosterAnalysis({
      outputRoot, jobId: 'poster-job-1', analysisPlanPath: submittedPath, dispatchId,
    }));
    const saved = await readPosterJob(outputRoot, 'poster-job-1');
    assert.deepEqual(saved.plan, beforeControl.plan);
    assert.deepEqual(saved.manifest, beforeControl.manifest);
    assert.equal((await readForegroundDispatch(record.paths.root, { dispatchId, rootKind: 'poster' })).status, 'cancelled');
  });
}
