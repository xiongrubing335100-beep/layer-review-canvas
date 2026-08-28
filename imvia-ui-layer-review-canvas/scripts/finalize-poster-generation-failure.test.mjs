import assert from 'node:assert/strict';
import { copyFile, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { randomUUID } from 'node:crypto';

import { authorizePosterRetry, initializePosterFastJob, initializePosterJob, mutatePosterJob, readPosterJob, recordPosterGenerationFailure } from '../src/poster-job-store.js';
import { buildFastLayerSnapshot, createFastPosterPlan } from '../src/poster-fast-plan.js';
import { preparePosterJob } from './prepare-poster-job.mjs';
import { finalizePosterGenerationFailure } from './finalize-poster-generation-failure.mjs';
import {
  acknowledgeForegroundDispatch,
  claimNextForegroundDispatchFromRoots,
  completeForegroundDispatch,
  enqueueForegroundDispatch,
  markForegroundDispatchDelivered,
  readForegroundDispatch,
} from '../src/foreground-dispatch.js';
import { controlPosterDispatch } from '../src/poster-dispatch-control.js';

const sourcePath = path.resolve('public/demo-source.png');

function plan() {
  return {
    version: '1.0', task: 'poster_layering', job_id: 'poster-job-1', project_id: 'project-1', image_id: 'image-1',
    source: { path: 'source.png', width: 1500, height: 3664, aspect_ratio: 1500 / 3664, target_2x: false },
    document_mode: 'poster', status: 'PLAN_CONFIRMED', plan_version: 2,
    skill_contract: { base: 'lovart-poster-layering-v3-1', adapter: 'imvia-poster-layering-workbench-v1', auto_retry: false, full_canvas: true },
    layers: [{
      layer_index: 1, layer_name: 'Title', asset_role: 'headline', layer_type: 'graphic', z_order: 1,
      position: 'top center', visible_content: ['Title'], included_content: ['Title'], excluded_content: [],
      occludes: [], occluded_by: [], source_evidence: [{ description: 'title', region: [0, 0, 1, 1] }], support_components: [],
      ui_independence: 'not_applicable', repair_envelope: { description: '', covered_segment: [], seam_band: '', forbidden_regions: [] },
      locked_visible_anchors: ['glyphs'], completion_required: false, completion_regions: [], risk_level: 'high', processing_mode: 'graphic_completion',
      fill_color: '#00FF00', compositing_mode: 'Normal', separation_reason: 'independent title', status: 'PENDING',
    }], output_directory: 'ignored',
  };
}

async function authorize(outputRoot) {
  const current = await readPosterJob(outputRoot, 'poster-job-1');
  await mutatePosterJob(outputRoot, 'poster-job-1', current.manifest.revision, (record) => ({
    ...record, manifest: { ...record.manifest, layers: record.manifest.layers.map((layer) => layer.layer_index === 1
      ? { ...layer, status: 'GENERATION_AUTHORIZED', authorization_plan_version: record.plan.plan_version } : layer) },
  }));
}

async function failureFixture(context, { acknowledged = false } = {}) {
  const outputRoot = await mkdtemp(path.join(os.tmpdir(), 'finalize-generation-failure-'));
  context.after(() => rm(outputRoot, { recursive: true, force: true }));
  const record = await initializePosterJob({ outputRoot, jobId: 'poster-job-1', sourcePath, plan: plan() });
  await authorize(outputRoot);
  const dispatchId = randomUUID();
  const spec = await preparePosterJob({ outputRoot, jobId: 'poster-job-1', phase: 'candidate', layerIndex: 1, dispatchId });
  await enqueueForegroundDispatch(record.paths.root, {
    jobId: 'poster-job-1', taskKind: 'poster_candidate', planPath: record.paths.plan,
    layerIndex: spec.layer_index, candidateNumber: spec.candidate_number, authorizationId: spec.authorization_id,
    planVersion: spec.plan_version, prompt: 'candidate', submittedAt: '2026-08-21T10:00:00.000Z', dispatchId,
  });
  const claim = await claimNextForegroundDispatchFromRoots([path.join(outputRoot, 'poster-jobs')], { bridgeId: 'bridge' });
  await markForegroundDispatchDelivered(record.paths.root, { bridgeId: 'bridge', claimToken: claim.claimToken, dispatchId, rootKind: 'poster' });
  if (acknowledged) await acknowledgeForegroundDispatch(record.paths.root, undefined, { dispatchId, rootKind: 'poster', confirmationSource: 'codex_model_tool' });
  return { outputRoot, record, dispatchId, spec };
}

async function fastFailureFixture(context) {
  const outputRoot = await mkdtemp(path.join(os.tmpdir(), 'finalize-fast-generation-failure-'));
  context.after(() => rm(outputRoot, { recursive: true, force: true }));
  const base = plan();
  const fast = createFastPosterPlan({ ...base, status: 'PLAN_REVIEW', layers: base.layers.map((layer) => ({
    ...layer, processing_category: 'text', planning_confidence: 0.5, user_confirmed: false,
  })) });
  const confirmed = buildFastLayerSnapshot(fast, 1).plan;
  const record = await initializePosterFastJob({ outputRoot, jobId: 'poster-job-1', sourcePath, plan: confirmed });
  await authorize(outputRoot);
  const dispatchId = randomUUID();
  const persisted = await readPosterJob(outputRoot, 'poster-job-1');
  const spec = await preparePosterJob({ outputRoot, jobId: 'poster-job-1', phase: 'candidate', layerIndex: 1,
    dispatchId, planningMode: 'targeted_fast', snapshotPath: persisted.paths.plan,
    processingCategory: persisted.plan.layers[0].confirmed_snapshot.layer.processing_category,
    sourceFingerprint: (await import('../src/poster-plan.js')).digestCanonicalJson(persisted.plan.source) });
  await enqueueForegroundDispatch(record.paths.root, { jobId: 'poster-job-1', taskKind: 'poster_candidate', planPath: record.paths.plan,
    layerIndex: spec.layer_index, candidateNumber: spec.candidate_number, authorizationId: spec.authorization_id,
    planVersion: spec.plan_version, planningMode: 'targeted_fast', snapshotId: spec.snapshot_id,
    sourceFingerprint: spec.source_fingerprint, manifestRevision: spec.reservation_manifest_revision,
    prompt: 'candidate', submittedAt: '2026-08-21T10:00:00.000Z', dispatchId });
  const claim = await claimNextForegroundDispatchFromRoots([path.join(outputRoot, 'poster-jobs')], { bridgeId: 'bridge' });
  await markForegroundDispatchDelivered(record.paths.root, { bridgeId: 'bridge', claimToken: claim.claimToken, dispatchId, rootKind: 'poster' });
  return { outputRoot, record, dispatchId, spec };
}

function failureArgs(fixture, extra = {}) {
  return {
    outputRoot: fixture.outputRoot, jobId: 'poster-job-1', layerIndex: 1, dispatchId: fixture.dispatchId,
    failureCode: 'IMAGEGEN_NO_PNG', message: 'ImageGen returned without a usable PNG', ...extra,
  };
}

function runFailureCli(args) {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [path.resolve('scripts/finalize-poster-generation-failure.mjs'), ...args], (error, stdout, stderr) => {
      if (error) reject(Object.assign(error, { stdout, stderr }));
      else resolve({ stdout, stderr });
    });
  });
}

test('ImageGen without a usable PNG records IMAGEGEN_NO_PNG, releases FIFO, and requires explicit retry', async (context) => {
  const fixture = await failureFixture(context); // delivered: ImageGen was invoked but yielded no files.
  const nextDirectory = path.join(fixture.outputRoot, 'jobs', 'next-ui');
  await mkdir(nextDirectory, { recursive: true });
  await writeFile(path.join(nextDirectory, 'layer-review-plan.json'), JSON.stringify({ status: 'queued' }));
  await enqueueForegroundDispatch(nextDirectory, { jobId: 'next-ui', prompt: 'next', submittedAt: '2026-08-21T10:00:01.000Z' });

  await finalizePosterGenerationFailure(failureArgs(fixture));
  const failed = await readPosterJob(fixture.outputRoot, 'poster-job-1');
  const layer = failed.manifest.layers.find((entry) => entry.layer_index === 1);
  assert.equal(layer.status, 'HARD_REJECTED');
  assert.equal(layer.generation_error, 'ImageGen returned without a usable PNG');
  assert.deepEqual(layer.failure_codes, ['GENERATION_FAILED', 'IMAGEGEN_NO_PNG']);
  assert.equal(failed.manifest.candidates[0].status, 'HARD_REJECTED');
  assert.equal(failed.manifest.candidates[0].path, undefined, 'no PNG must not fabricate a candidate path');
  assert.equal(failed.manifest.authorizations[0].generation_failure.event, 'GENERATION_FAILED');
  assert.equal((await readForegroundDispatch(fixture.record.paths.root, { dispatchId: fixture.dispatchId, rootKind: 'poster' })).status, 'failed');

  const next = await claimNextForegroundDispatchFromRoots([path.join(fixture.outputRoot, 'poster-jobs'), path.join(fixture.outputRoot, 'jobs')], { bridgeId: 'next-bridge' });
  assert.equal(next.jobId, 'next-ui');
  await authorizePosterRetry({ outputRoot: fixture.outputRoot, jobId: 'poster-job-1', layerIndex: 1, expectedRevision: failed.manifest.revision });
  const retried = await readPosterJob(fixture.outputRoot, 'poster-job-1');
  assert.equal(retried.manifest.layers[0].status, 'RETRY_AUTHORIZED');
  assert.equal((await readdir(path.join(fixture.record.paths.root, 'foreground-dispatches'))).length, 1, 'retry must not enqueue automatically');
});

test('usable PNG with a missing review report is retained by the production CLI without claiming no PNG', async (context) => {
  const fixture = await failureFixture(context);
  const candidateInput = path.join(fixture.outputRoot, 'raw-candidate.png');
  await copyFile(sourcePath, candidateInput);
  const candidateSha256 = createHash('sha256').update(await readFile(candidateInput)).digest('hex');
  const evidencePath = path.join(fixture.outputRoot, 'candidate-evidence.json');
  await writeFile(evidencePath, JSON.stringify({
    input_path: candidateInput,
    candidate_sha256: candidateSha256,
    dimensions: { width: 1500, height: 3664, expected_width: 1500, expected_height: 3664, fillColor: '#00FF00' },
    review_report: null,
    release_gate: null,
    key_findings: { report: 'missing' },
  }));

  await runFailureCli([
    '--output-root', fixture.outputRoot, '--job-id', 'poster-job-1', '--layer-index', '1', '--dispatch-id', fixture.dispatchId,
    '--failure-code', 'GENERATION_FAILED', '--message', '候选 PNG 可用，但审核报告缺失',
    '--candidate-evidence', evidencePath,
  ]);

  const saved = await readPosterJob(fixture.outputRoot, 'poster-job-1');
  const candidate = saved.manifest.candidates[0];
  assert.deepEqual(candidate.failure_codes, ['GENERATION_FAILED']);
  assert.equal(candidate.candidate_sha256, candidateSha256);
  assert.equal(candidate.review_report, null);
  assert.ok(candidate.path.startsWith(saved.paths.candidates));
  assert.equal(saved.manifest.layers[0].candidate_output, candidate.path);
  assert.equal(saved.manifest.layers[0].visual_inspection.performed, false);
  assert.doesNotMatch(saved.manifest.layers[0].failure_codes.join(','), /IMAGEGEN_NO_PNG/);
});

test('IMAGEGEN_NO_PNG rejects caller-supplied candidate evidence before changing the dispatch', async (context) => {
  const fixture = await failureFixture(context);
  const candidateInput = path.join(fixture.outputRoot, 'raw-candidate.png');
  await copyFile(sourcePath, candidateInput);
  const candidateSha256 = createHash('sha256').update(await readFile(candidateInput)).digest('hex');

  await assert.rejects(finalizePosterGenerationFailure(failureArgs(fixture, {
    candidateEvidence: { input_path: candidateInput, candidate_sha256: candidateSha256 },
  })), /IMAGEGEN_NO_PNG.*candidate evidence/i);
  assert.equal((await readForegroundDispatch(fixture.record.paths.root, {
    dispatchId: fixture.dispatchId, rootKind: 'poster',
  })).status, 'delivered');
});

test('a persisted fast PLAN_REVIEW snapshot can truthfully finalize a generation failure', async (context) => {
  const fixture = await fastFailureFixture(context);
  await finalizePosterGenerationFailure(failureArgs(fixture));
  const saved = await readPosterJob(fixture.outputRoot, 'poster-job-1');
  assert.equal(saved.plan.status, 'PLAN_REVIEW');
  assert.equal(saved.manifest.layers[0].status, 'HARD_REJECTED');
  assert.equal(saved.manifest.authorizations[0].planning_mode, 'targeted_fast');
  assert.equal(saved.manifest.authorizations[0].snapshot_id, saved.plan.layers[0].snapshot_id);
});

test('a fast idempotent direct failure replay accepts the post-failure manifest revision', async (context) => {
  const fixture = await fastFailureFixture(context);
  await finalizePosterGenerationFailure(failureArgs(fixture));
  await assert.doesNotReject(recordPosterGenerationFailure({
    outputRoot: fixture.outputRoot, jobId: 'poster-job-1', layerIndex: 1,
    authorizationId: fixture.spec.authorization_id, candidateNumber: fixture.spec.candidate_number,
    planVersion: fixture.spec.plan_version, dispatchId: fixture.dispatchId, idempotent: true,
    error: 'replayed failure',
  }));
});

test('no-PNG finalization cannot overwrite an already retained candidate', async (context) => {
  const fixture = await failureFixture(context);
  const current = await readPosterJob(fixture.outputRoot, 'poster-job-1');
  await mutatePosterJob(fixture.outputRoot, 'poster-job-1', current.manifest.revision, (record) => ({
    ...record,
    manifest: {
      ...record.manifest,
      candidates: [{
        candidate_id: fixture.spec.candidate_id, layer_index: 1, candidate_number: fixture.spec.candidate_number,
        plan_version: fixture.spec.plan_version, path: fixture.spec.candidate_path,
        status: 'HARD_REJECTED', failure_codes: ['CANVAS_OR_GREEN_FIELD_INVALID'], accepted: false,
      }],
    },
  }));
  await assert.rejects(finalizePosterGenerationFailure(failureArgs(fixture)), /cannot relabel/i);
  const unchanged = await readPosterJob(fixture.outputRoot, 'poster-job-1');
  assert.equal(unchanged.manifest.layers[0].status, 'GENERATING');
  assert.equal(unchanged.manifest.candidates[0].failure_codes[0], 'CANVAS_OR_GREEN_FIELD_INVALID');
});

test('fast failure finalization fails closed for every altered dispatch binding', async (context) => {
  for (const [field, value] of Object.entries({
    snapshotId: 'stale-snapshot', sourceFingerprint: 'changed-source', layerIndex: 2,
    authorizationId: 'stale-authorization', planVersion: 999, manifestRevision: 999,
  })) {
    const fixture = await fastFailureFixture(context);
    const journal = path.join(fixture.record.paths.root, 'foreground-dispatches', `${fixture.dispatchId}.json`);
    const dispatch = JSON.parse(await readFile(journal, 'utf8'));
    await writeFile(journal, JSON.stringify({ ...dispatch, [field]: value }));
    await assert.rejects(finalizePosterGenerationFailure(failureArgs(fixture)), /stale|binding|dispatch/i, field);
  }
});

test('failure finalizer binds only the dispatch-owned generation and is idempotent', async (context) => {
  const fixture = await failureFixture(context, { acknowledged: true });
  await assert.rejects(finalizePosterGenerationFailure(failureArgs(fixture, { layerIndex: 2 })), /layerIndex/);
  await finalizePosterGenerationFailure(failureArgs(fixture, { candidateNumber: 999, authorizationId: 'forged', planVersion: 999 }));
  const once = await readFile(path.join(fixture.record.paths.root, 'foreground-dispatches', `${fixture.dispatchId}.json`), 'utf8');
  await finalizePosterGenerationFailure(failureArgs(fixture));
  assert.equal(await readFile(path.join(fixture.record.paths.root, 'foreground-dispatches', `${fixture.dispatchId}.json`), 'utf8'), once);
});

test('production failure-finalizer CLI ends a delivered ImageGen dispatch without candidate files', async (context) => {
  const fixture = await failureFixture(context);
  const result = await runFailureCli([
    '--output-root', fixture.outputRoot, '--job-id', 'poster-job-1', '--layer-index', '1', '--dispatch-id', fixture.dispatchId,
    '--failure-code', 'IMAGEGEN_NO_OUTPUT', '--message', 'ImageGen returned no output',
  ]);
  assert.equal(JSON.parse(result.stdout).status, 'failed');
  assert.equal((await readForegroundDispatch(fixture.record.paths.root, { dispatchId: fixture.dispatchId, rootKind: 'poster' })).status, 'failed');
});

test('failure finalizer converges after crashes on either side of its manifest/dispatch persistence boundary', async (context) => {
  const beforeDispatch = await failureFixture(context, { acknowledged: true });
  await assert.rejects(finalizePosterGenerationFailure(failureArgs(beforeDispatch, {
    hooks: { afterManifestFailure: () => { throw new Error('simulated crash after manifest'); } },
  })), /simulated crash/);
  assert.equal((await readPosterJob(beforeDispatch.outputRoot, 'poster-job-1')).manifest.layers[0].status, 'HARD_REJECTED');
  assert.equal((await readForegroundDispatch(beforeDispatch.record.paths.root, { dispatchId: beforeDispatch.dispatchId, rootKind: 'poster' })).status, 'sent');
  await finalizePosterGenerationFailure(failureArgs(beforeDispatch));
  assert.equal((await readForegroundDispatch(beforeDispatch.record.paths.root, { dispatchId: beforeDispatch.dispatchId, rootKind: 'poster' })).status, 'failed');

  const afterDispatch = await failureFixture(context, { acknowledged: true });
  await assert.rejects(finalizePosterGenerationFailure(failureArgs(afterDispatch, {
    hooks: { afterDispatchFailure: () => { throw new Error('simulated crash after dispatch'); } },
  })), /simulated crash/);
  assert.equal((await readForegroundDispatch(afterDispatch.record.paths.root, { dispatchId: afterDispatch.dispatchId, rootKind: 'poster' })).status, 'failed');
  await assert.doesNotReject(finalizePosterGenerationFailure(failureArgs(afterDispatch)));
});

test('failure finalizer rejects cancelled, completed, and late dispatches', async (context) => {
  const cancelled = await failureFixture(context);
  await controlPosterDispatch(cancelled.record.paths.root, { dispatchId: cancelled.dispatchId, action: 'cancel' });
  await assert.rejects(finalizePosterGenerationFailure(failureArgs(cancelled)), /已取消|ended/);

  const completed = await failureFixture(context, { acknowledged: true });
  await completeForegroundDispatch(completed.record.paths.root, { dispatchId: completed.dispatchId, rootKind: 'poster' });
  await assert.rejects(finalizePosterGenerationFailure(failureArgs(completed)), /已结束|ended/);
});
