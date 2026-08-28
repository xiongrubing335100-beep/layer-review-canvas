import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { deflateSync } from 'node:zlib';

import { authorizePosterRetry, initializePosterFastJob, initializePosterJob, mutatePosterJob, readPosterJob } from '../src/poster-job-store.js';
import { buildFastLayerSnapshot, createFastPosterPlan } from '../src/poster-fast-plan.js';
import { digestCanonicalJson } from '../src/poster-plan.js';
import { preparePosterJob } from './prepare-poster-job.mjs';
import { finalizePosterCandidate } from './finalize-poster-candidate.mjs';
import {
  acknowledgeForegroundDispatch,
  claimNextForegroundDispatchFromRoots,
  enqueueForegroundDispatch,
  finalizeForegroundDispatch,
  markForegroundDispatchDelivered,
  readForegroundDispatch,
} from '../src/foreground-dispatch.js';
import { controlPosterDispatch } from '../src/poster-dispatch-control.js';

const sourcePath = path.resolve('public/demo-source.png');

function crc32(...buffers) {
  let crc = 0xffffffff;
  for (const buffer of buffers) for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const typeBuffer = Buffer.from(type); const output = Buffer.alloc(data.length + 12);
  output.writeUInt32BE(data.length, 0); typeBuffer.copy(output, 4); data.copy(output, 8);
  output.writeUInt32BE(crc32(typeBuffer, data), data.length + 8); return output;
}
async function keyedPng(filePath, width = 1500, height = 3664, color = [0, 255, 0], rgba = false) {
  const channels = rgba ? 4 : 3; const raw = Buffer.alloc((width * channels + 1) * height);
  for (let row = 0; row < height; row += 1) for (let column = 0; column < width; column += 1) {
    const offset = row * (width * channels + 1) + 1 + column * channels;
    raw[offset] = color[0]; raw[offset + 1] = color[1]; raw[offset + 2] = color[2]; if (rgba) raw[offset + 3] = 255;
  }
  const header = Buffer.alloc(13); header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = rgba ? 6 : 2;
  await writeFile(filePath, Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', header), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]));
}

async function transparentPng(filePath, width = 1500, height = 3664) {
  const channels = 4; const raw = Buffer.alloc((width * channels + 1) * height);
  for (let row = 0; row < height; row += 1) for (let column = 0; column < width; column += 1) {
    const offset = row * (width * channels + 1) + 1 + column * channels;
    const foreground = column >= Math.floor(width * 0.35) && column < Math.ceil(width * 0.65)
      && row >= Math.floor(height * 0.2) && row < Math.ceil(height * 0.8);
    raw[offset] = foreground ? 210 : 0;
    raw[offset + 1] = foreground ? 30 : 0;
    raw[offset + 2] = foreground ? 20 : 0;
    raw[offset + 3] = foreground ? 255 : 0;
  }
  const header = Buffer.alloc(13); header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6;
  await writeFile(filePath, Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', header), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]));
}

async function authorize(outputRoot) {
  const record = await readPosterJob(outputRoot, 'poster-job-1');
  await mutatePosterJob(outputRoot, 'poster-job-1', record.manifest.revision, (current) => ({
    ...current, manifest: { ...current.manifest, layers: current.manifest.layers.map((entry) => entry.layer_index === 1
      ? { ...entry, status: 'GENERATION_AUTHORIZED', authorization_plan_version: current.plan.plan_version } : entry) },
  }));
}

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

async function routedCandidateFixture(context, { confirmModel = true, fast = false } = {}) {
  const outputRoot = await mkdtemp(path.join(os.tmpdir(), 'finalize-candidate-routed-'));
  context.after(() => rm(outputRoot, { recursive: true, force: true }));
  const base = plan();
  const fastPlan = fast ? buildFastLayerSnapshot(createFastPosterPlan({ ...base, status: 'PLAN_REVIEW', layers: base.layers.map((layer) => ({
    ...layer, processing_category: 'text', planning_confidence: 0.5, user_confirmed: false, remove_background: true,
  })) }), 1).plan : null;
  const record = fast
    ? await initializePosterFastJob({ outputRoot, jobId: 'poster-job-1', sourcePath, plan: fastPlan })
    : await initializePosterJob({ outputRoot, jobId: 'poster-job-1', sourcePath, plan: base });
  await authorize(outputRoot);
  const dispatchId = randomUUID();
  const persisted = await readPosterJob(outputRoot, 'poster-job-1');
  const spec = await preparePosterJob({ outputRoot, jobId: 'poster-job-1', phase: 'candidate', layerIndex: 1, dispatchId,
    ...(fast ? { planningMode: 'targeted_fast', snapshotPath: persisted.paths.plan,
      processingCategory: persisted.plan.layers[0].confirmed_snapshot.layer.processing_category,
      sourceFingerprint: digestCanonicalJson(persisted.plan.source) } : {}) });
  await enqueueForegroundDispatch(record.paths.root, {
    jobId: 'poster-job-1', taskKind: 'poster_candidate', planPath: record.paths.plan,
    layerIndex: spec.layer_index, candidateNumber: spec.candidate_number,
    authorizationId: spec.authorization_id, planVersion: spec.plan_version,
    ...(fast ? { planningMode: 'targeted_fast', snapshotId: spec.snapshot_id,
      sourceFingerprint: spec.source_fingerprint, manifestRevision: spec.reservation_manifest_revision } : {}),
    prompt: 'candidate', submittedAt: '2026-08-20T10:00:00.000Z', dispatchId,
  });
  const claim = await claimNextForegroundDispatchFromRoots([path.join(outputRoot, 'poster-jobs')], { bridgeId: 'bridge' });
  assert.deepEqual(
    { jobId: claim.jobId, dispatchId: claim.dispatchId, rootKind: claim.rootKind, taskKind: claim.taskKind },
    { jobId: 'poster-job-1', dispatchId, rootKind: 'poster', taskKind: 'poster_candidate' },
  );
  await markForegroundDispatchDelivered(record.paths.root, {
    bridgeId: 'bridge', claimToken: claim.claimToken, dispatchId, rootKind: 'poster',
  });
  if (confirmModel) {
    await acknowledgeForegroundDispatch(record.paths.root, undefined, {
      dispatchId, rootKind: 'poster', confirmationSource: 'codex_model_tool',
    });
  }
  const reportPath = path.join(record.paths.evidence, 'candidate-review.json');
  await writeFile(reportPath, JSON.stringify({
    verdict: 'NEEDS_USER_REVIEW', failure_codes: [],
    checks: { source_comparison: true, locked_anchors: true, repair_envelope: true, canvas_dimensions: true, key_field: true },
    job_id: 'poster-job-1', layer_index: 1, candidate_id: spec.candidate_id,
    authorization_id: spec.authorization_id, plan_version: 2, candidate_number: 1,
  }));
  const candidateInput = path.join(outputRoot, 'candidate.png');
  await keyedPng(candidateInput);
  return { outputRoot, record, dispatchId, spec, reportPath, candidateInput };
}

async function trustedInternalCandidateFixture(context) {
  const outputRoot = await mkdtemp(path.join(os.tmpdir(), 'finalize-candidate-trusted-internal-'));
  context.after(() => rm(outputRoot, { recursive: true, force: true }));
  const record = await initializePosterJob({ outputRoot, jobId: 'poster-job-1', sourcePath, plan: plan() });
  await authorize(outputRoot);
  const first = await preparePosterJob({ outputRoot, jobId: 'poster-job-1', phase: 'candidate', layerIndex: 1 });
  const candidateInput = path.join(outputRoot, 'candidate.png');
  await keyedPng(candidateInput);
  const firstReport = path.join(record.paths.evidence, 'candidate-review-1.json');
  await writeFile(firstReport, JSON.stringify({
    verdict: 'NEEDS_USER_REVIEW', failure_codes: [],
    checks: { source_comparison: true, locked_anchors: true, repair_envelope: true, canvas_dimensions: true, key_field: true },
    job_id: 'poster-job-1', layer_index: 1, candidate_id: first.candidate_id,
    authorization_id: first.authorization_id, plan_version: 2, candidate_number: 1,
  }));
  await finalizePosterCandidate({
    outputRoot, jobId: 'poster-job-1', layerIndex: 1,
    candidateInputPath: candidateInput, reviewReportPath: firstReport, trustedInternal: true,
  });
  return { outputRoot, record, candidateInput };
}

async function directRejectedCandidateFixture(context, { fast = false } = {}) {
  const outputRoot = await mkdtemp(path.join(os.tmpdir(), 'finalize-candidate-direct-rejected-'));
  context.after(() => rm(outputRoot, { recursive: true, force: true }));
  const base = plan();
  const fastPlan = fast ? buildFastLayerSnapshot(createFastPosterPlan({ ...base, status: 'PLAN_REVIEW', layers: base.layers.map((layer) => ({
    ...layer, processing_category: 'text', planning_confidence: 0.5, user_confirmed: false,
  })) }), 1).plan : null;
  const record = fast
    ? await initializePosterFastJob({ outputRoot, jobId: 'poster-job-1', sourcePath, plan: fastPlan })
    : await initializePosterJob({ outputRoot, jobId: 'poster-job-1', sourcePath, plan: base });
  await authorize(outputRoot);
  const persisted = await readPosterJob(outputRoot, 'poster-job-1');
  const spec = await preparePosterJob({
    outputRoot, jobId: 'poster-job-1', phase: 'candidate', layerIndex: 1,
    ...(fast ? { planningMode: 'targeted_fast', snapshotPath: persisted.paths.plan,
      processingCategory: persisted.plan.layers[0].confirmed_snapshot.layer.processing_category,
      sourceFingerprint: digestCanonicalJson(persisted.plan.source) } : {}),
  });
  const candidateInput = path.join(outputRoot, 'candidate.png');
  await keyedPng(candidateInput, 100, 100);
  const reportPath = path.join(record.paths.evidence, 'candidate-review-rejected.json');
  await writeFile(reportPath, JSON.stringify({
    verdict: 'HARD_REJECTED', failure_codes: ['CANVAS_OR_GREEN_FIELD_INVALID'],
    checks: { source_comparison: true, locked_anchors: true, repair_envelope: true, canvas_dimensions: false, key_field: true },
    job_id: 'poster-job-1', layer_index: 1, candidate_id: spec.candidate_id,
    authorization_id: spec.authorization_id, plan_version: 2, candidate_number: 1,
  }));
  return { outputRoot, record, spec, candidateInput, reportPath };
}

async function prepareTrustedInternalRetry(outputRoot) {
  const current = await readPosterJob(outputRoot, 'poster-job-1');
  await mutatePosterJob(outputRoot, 'poster-job-1', current.manifest.revision, (record) => ({
    ...record,
    manifest: {
      ...record.manifest,
      layers: record.manifest.layers.map((entry) => entry.layer_index === 1 ? {
        ...entry, status: 'RETRY_AUTHORIZED', authorization_plan_version: record.plan.plan_version, authorization_consumed: false,
      } : entry),
    },
  }));
  return preparePosterJob({ outputRoot, jobId: 'poster-job-1', phase: 'candidate', layerIndex: 1 });
}

async function writeTrustedInternalReview(record, spec, filename, checks) {
  const reportPath = path.join(record.paths.evidence, filename);
  await writeFile(reportPath, JSON.stringify({
    verdict: 'NEEDS_USER_REVIEW', failure_codes: [], checks,
    job_id: 'poster-job-1', layer_index: 1, candidate_id: spec.candidate_id,
    authorization_id: spec.authorization_id, plan_version: 2, candidate_number: spec.candidate_number,
  }));
  return reportPath;
}

test('routed candidate finalization completes its dispatch and releases the next queued job', async (context) => {
  const outputRoot = await mkdtemp(path.join(os.tmpdir(), 'finalize-candidate-'));
  context.after(() => rm(outputRoot, { recursive: true, force: true }));
  const record = await initializePosterJob({ outputRoot, jobId: 'poster-job-1', sourcePath, plan: plan() });
  await authorize(outputRoot);
  const dispatchId = randomUUID();
  const spec = await preparePosterJob({ outputRoot, jobId: 'poster-job-1', phase: 'candidate', layerIndex: 1, dispatchId });
  await enqueueForegroundDispatch(record.paths.root, { jobId: 'poster-job-1', taskKind: 'poster_candidate', planPath: record.paths.plan,
    layerIndex: spec.layer_index, candidateNumber: spec.candidate_number, authorizationId: spec.authorization_id, planVersion: spec.plan_version,
    prompt: 'candidate', submittedAt: '2026-08-20T10:00:00.000Z', dispatchId });
  const jobsDirectory = path.join(outputRoot, 'jobs'); const nextDirectory = path.join(jobsDirectory, 'next-ui');
  await mkdir(nextDirectory, { recursive: true }); await writeFile(path.join(nextDirectory, 'layer-review-plan.json'), JSON.stringify({ status: 'queued' }));
  await enqueueForegroundDispatch(nextDirectory, { jobId: 'next-ui', prompt: 'next', submittedAt: '2026-08-20T10:00:01.000Z' });
  const claim = await claimNextForegroundDispatchFromRoots([path.join(outputRoot, 'poster-jobs'), jobsDirectory], { bridgeId: 'bridge' });
  assert.deepEqual(
    { jobId: claim.jobId, dispatchId: claim.dispatchId, rootKind: claim.rootKind, taskKind: claim.taskKind },
    { jobId: 'poster-job-1', dispatchId, rootKind: 'poster', taskKind: 'poster_candidate' },
  );
  assert.equal((await readForegroundDispatch(record.paths.root, { dispatchId, rootKind: 'poster' })).status, 'claimed');
  await markForegroundDispatchDelivered(record.paths.root, { bridgeId: 'bridge', claimToken: claim.claimToken, dispatchId, rootKind: 'poster' });
  assert.equal((await readForegroundDispatch(record.paths.root, { dispatchId, rootKind: 'poster' })).status, 'delivered');
  await acknowledgeForegroundDispatch(record.paths.root, undefined, { dispatchId, rootKind: 'poster', confirmationSource: 'codex_model_tool' });
  assert.equal((await readForegroundDispatch(record.paths.root, { dispatchId, rootKind: 'poster' })).status, 'sent');
  const reportPath = path.join(record.paths.evidence, 'candidate-review.json');
  await writeFile(reportPath, JSON.stringify({ verdict: 'NEEDS_USER_REVIEW', failure_codes: [], checks: { source_comparison: true, locked_anchors: true, repair_envelope: true, canvas_dimensions: true, key_field: true }, job_id: 'poster-job-1', layer_index: 1, candidate_id: spec.candidate_id, authorization_id: spec.authorization_id, plan_version: 2, candidate_number: 1 }));
  const candidateInput = path.join(outputRoot, 'candidate.png');
  await keyedPng(candidateInput);

  const result = await finalizePosterCandidate({
    outputRoot, jobId: 'poster-job-1', layerIndex: 1, candidateInputPath: candidateInput, reviewReportPath: reportPath, dispatchId,
  });
  assert.equal(result.status, 'NEEDS_USER_REVIEW');
  assert.deepEqual(await readdir(result.layersDirectory), []);
  const saved = await readPosterJob(outputRoot, 'poster-job-1');
  assert.equal(saved.manifest.candidates.length, 1);
  assert.equal(saved.manifest.candidates[0].status, 'NEEDS_USER_REVIEW');
  assert.match(saved.manifest.candidates[0].candidate_sha256, /^[a-f0-9]{64}$/);
  assert.equal(saved.manifest.candidates[0].candidate_sha256,
    createHash('sha256').update(await readFile(saved.manifest.candidates[0].path)).digest('hex'));
  assert.equal(saved.manifest.candidates[0].release_gate.candidateSha256,
    saved.manifest.candidates[0].candidate_sha256);
  assert.equal((await readForegroundDispatch(record.paths.root, { dispatchId, rootKind: 'poster' })).status, 'completed');
  const nextClaim = await claimNextForegroundDispatchFromRoots([path.join(outputRoot, 'poster-jobs'), jobsDirectory], { bridgeId: 'bridge' });
  assert.deepEqual(
    { jobId: nextClaim.jobId, rootKind: nextClaim.rootKind, taskKind: nextClaim.taskKind },
    { jobId: 'next-ui', rootKind: 'ui', taskKind: 'ui_layer_review' },
  );
  await assert.rejects(finalizePosterCandidate({ outputRoot, jobId: 'poster-job-1', layerIndex: 1, candidateInputPath: candidateInput, reviewReportPath: reportPath, dispatchId }));
  await assert.rejects(preparePosterJob({ outputRoot, jobId: 'poster-job-1', phase: 'candidate', layerIndex: 1 }), /GENERATION_AUTHORIZED|RETRY_AUTHORIZED/);
});

test('a persisted fast PLAN_REVIEW snapshot can finalize one bound candidate', async (context) => {
  const fixture = await routedCandidateFixture(context, { fast: true });
  const result = await finalizePosterCandidate({
    outputRoot: fixture.outputRoot, jobId: 'poster-job-1', layerIndex: 1,
    candidateInputPath: fixture.candidateInput, reviewReportPath: fixture.reportPath, dispatchId: fixture.dispatchId,
  });
  assert.equal(result.status, 'NEEDS_USER_REVIEW');
  const saved = await readPosterJob(fixture.outputRoot, 'poster-job-1');
  assert.equal(saved.plan.status, 'PLAN_REVIEW');
  assert.equal(saved.manifest.candidates[0].layer_index, 1);
  assert.equal(saved.manifest.authorizations[0].snapshot_id, saved.plan.layers[0].snapshot_id);
});

test('a targeted fast remove-background candidate persists a full-canvas RMBG preview', async (context) => {
  const fixture = await routedCandidateFixture(context, { fast: true });
  const transparentPreviewPath = path.join(fixture.record.paths.evidence, 'candidate-rmbg-preview.png');
  await transparentPng(transparentPreviewPath);
  await finalizePosterCandidate({
    outputRoot: fixture.outputRoot, jobId: 'poster-job-1', layerIndex: 1,
    candidateInputPath: fixture.candidateInput, reviewReportPath: fixture.reportPath,
    transparentPreviewPath, dispatchId: fixture.dispatchId,
  });
  const saved = await readPosterJob(fixture.outputRoot, 'poster-job-1');
  assert.equal(saved.manifest.candidates[0].transparent_preview.path, transparentPreviewPath);
  assert.equal(saved.manifest.candidates[0].transparent_preview.model, 'BRIA RMBG 2.0');
  assert.deepEqual(saved.manifest.candidates[0].transparent_preview.dimensions, { width: 1500, height: 3664 });
  assert.match(saved.manifest.candidates[0].transparent_preview.candidate_sha256, /^[a-f0-9]{64}$/);
});

test('targeted fast returns the first green-screen PNG after RMBG without a Codex visual gate', async (context) => {
  const fastFinalizer = await import('./finalize-poster-fast-rmbg-candidate.mjs').catch(() => ({}));
  assert.equal(typeof fastFinalizer.finalizePosterFastRmbgCandidate, 'function');
  const fixture = await routedCandidateFixture(context, { fast: true });
  const steps = [];
  const result = await fastFinalizer.finalizePosterFastRmbgCandidate({
    jobDirectory: fixture.record.paths.root,
    jobId: 'poster-job-1',
    layerIndex: 1,
    rawInputPath: fixture.candidateInput,
    dispatchId: fixture.dispatchId,
    runRmbgStep: async ({ outputPath, expectedWidth, expectedHeight }) => {
      steps.push('rmbg');
      await transparentPng(outputPath, expectedWidth, expectedHeight);
      return { engine: 'rembg', model: 'bria-rmbg', real_alpha: true, alpha_source: 'bria_rmbg' };
    },
    runPrepareStep: async ({ alphaOutputPath, keyedOutputPath, sourceWidth, sourceHeight, fillColor }) => {
      steps.push('prepare');
      await transparentPng(alphaOutputPath, sourceWidth, sourceHeight);
      await keyedPng(keyedOutputPath, sourceWidth, sourceHeight, fillColor === '#000000' ? [0, 0, 0] : [0, 255, 0]);
      return {
        native: { width: sourceWidth, height: sourceHeight },
        output: { width: sourceWidth, height: sourceHeight },
        scaled: { width: sourceWidth, height: sourceHeight },
        offset: { x: 0, y: 0 },
        fill_color: fillColor,
        real_alpha: true,
      };
    },
  });

  assert.equal(result.status, 'NEEDS_USER_REVIEW');
  assert.deepEqual(steps, ['rmbg', 'prepare']);
  const saved = await readPosterJob(fixture.outputRoot, 'poster-job-1');
  const candidate = saved.manifest.candidates[0];
  const report = JSON.parse(await readFile(candidate.review_report, 'utf8'));
  assert.equal(report.review_mode, 'targeted_fast_passthrough_v1');
  assert.equal(report.visual_comparison.performed, false);
  assert.equal(report.visual_comparison.deferred_to, 'workbench_user');
  assert.deepEqual(report.checks, {
    source_comparison: true,
    locked_anchors: true,
    repair_envelope: true,
    canvas_dimensions: true,
    key_field: true,
  });
  assert.equal(candidate.status, 'NEEDS_USER_REVIEW');
  assert.equal(candidate.transparent_preview.model, 'BRIA RMBG 2.0');
  assert.equal(saved.manifest.layers[0].fast_execution.current_stage, 'review_ready');
  assert.equal(saved.manifest.layers[0].fast_execution.status, 'completed');
  assert.equal(saved.manifest.layers[0].fast_execution.stages.rmbg.status, 'completed');
  assert.equal(saved.manifest.layers[0].fast_execution.stages.canvas_mapping.status, 'completed');
  assert.equal(saved.manifest.layers[0].fast_execution.stages.finalizing.status, 'completed');
});

test('targeted fast jobDirectory rejects a directory that does not match the job id', async (context) => {
  const fastFinalizer = await import('./finalize-poster-fast-rmbg-candidate.mjs');
  const fixture = await routedCandidateFixture(context, { fast: true });
  await assert.rejects(fastFinalizer.finalizePosterFastRmbgCandidate({
    jobDirectory: path.join(fixture.outputRoot, 'poster-jobs', 'another-job'),
    jobId: 'poster-job-1',
    layerIndex: 1,
    rawInputPath: fixture.candidateInput,
    dispatchId: fixture.dispatchId,
  }), /job directory.*jobId/i);
});

test('a fast finalizing replay accepts the post-publication manifest revision', async (context) => {
  const fixture = await routedCandidateFixture(context, { fast: true });
  await finalizePosterCandidate({
    outputRoot: fixture.outputRoot, jobId: 'poster-job-1', layerIndex: 1,
    candidateInputPath: fixture.candidateInput, reviewReportPath: fixture.reportPath, dispatchId: fixture.dispatchId,
  });
  const journal = path.join(fixture.record.paths.root, 'foreground-dispatches', `${fixture.dispatchId}.json`);
  const dispatch = JSON.parse(await readFile(journal, 'utf8'));
  await writeFile(journal, JSON.stringify({ ...dispatch, status: 'finalizing' }));
  await assert.doesNotReject(finalizePosterCandidate({
    outputRoot: fixture.outputRoot, jobId: 'poster-job-1', layerIndex: 1,
    candidateInputPath: fixture.candidateInput, reviewReportPath: fixture.reportPath, dispatchId: fixture.dispatchId,
  }));
});

test('fast candidate finalization rejects stale snapshot, source, authorization, version, layer, and revision journals', async (context) => {
  for (const [field, value] of Object.entries({
    snapshotId: 'stale-snapshot', sourceFingerprint: 'changed-source', layerIndex: 2,
    authorizationId: 'stale-authorization', planVersion: 999, manifestRevision: 999,
  })) {
    const fixture = await routedCandidateFixture(context, { fast: true });
    const journal = path.join(fixture.record.paths.root, 'foreground-dispatches', `${fixture.dispatchId}.json`);
    const dispatch = JSON.parse(await readFile(journal, 'utf8'));
    await writeFile(journal, JSON.stringify({ ...dispatch, [field]: value }));
    await assert.rejects(finalizePosterCandidate({
      outputRoot: fixture.outputRoot, jobId: 'poster-job-1', layerIndex: 1,
      candidateInputPath: fixture.candidateInput, reviewReportPath: fixture.reportPath, dispatchId: fixture.dispatchId,
    }), /stale|binding|dispatch/i, field);
  }
});

test('routed PNG validation failure persists a retryable generation failure and releases FIFO', async (context) => {
  const { outputRoot, record, dispatchId, spec, reportPath, candidateInput } = await routedCandidateFixture(context);
  const jobsDirectory = path.join(outputRoot, 'jobs');
  const nextDirectory = path.join(jobsDirectory, 'next-ui');
  await mkdir(nextDirectory, { recursive: true });
  await writeFile(path.join(nextDirectory, 'layer-review-plan.json'), JSON.stringify({ status: 'queued' }));
  await enqueueForegroundDispatch(nextDirectory, {
    jobId: 'next-ui', prompt: 'next', submittedAt: '2026-08-20T10:00:01.000Z',
  });
  await writeFile(candidateInput, 'not a PNG');

  await assert.rejects(finalizePosterCandidate({
    outputRoot, jobId: 'poster-job-1', layerIndex: 1, candidateInputPath: candidateInput,
    reviewReportPath: reportPath, dispatchId,
  }), /PNG|signature|invalid/i);

  const failed = await readPosterJob(outputRoot, 'poster-job-1');
  assert.equal(failed.manifest.layers[0].status, 'HARD_REJECTED');
  assert.deepEqual(failed.manifest.layers[0].failure_codes, ['CANVAS_OR_GREEN_FIELD_INVALID']);
  assert.match(failed.manifest.layers[0].generation_error, /PNG|signature|invalid/i);
  assert.equal(failed.manifest.candidates[0].status, 'HARD_REJECTED');
  assert.deepEqual(failed.manifest.candidates[0].failure_codes, ['CANVAS_OR_GREEN_FIELD_INVALID']);
  assert.equal((await readForegroundDispatch(record.paths.root, { dispatchId, rootKind: 'poster' })).status, 'failed');
  const retry = await authorizePosterRetry({
    outputRoot, jobId: 'poster-job-1', layerIndex: 1, expectedRevision: failed.manifest.revision,
  });
  assert.equal(retry.manifest.layers[0].status, 'RETRY_AUTHORIZED');
  const next = await claimNextForegroundDispatchFromRoots([
    path.join(outputRoot, 'poster-jobs'), jobsDirectory,
  ], { bridgeId: 'next-bridge' });
  assert.deepEqual({ jobId: next.jobId, rootKind: next.rootKind, taskKind: next.taskKind }, {
    jobId: 'next-ui', rootKind: 'ui', taskKind: 'ui_layer_review',
  });
  await assert.rejects(finalizePosterCandidate({
    outputRoot, jobId: 'poster-job-1', layerIndex: 1, candidateInputPath: candidateInput,
    reviewReportPath: reportPath, dispatchId,
  }));
  assert.equal(await readFile(spec.candidate_path, 'utf8'), 'not a PNG');
});

test('a rejected full-canvas PNG remains a reviewable raw candidate with its release findings', async (context) => {
  const fixture = await routedCandidateFixture(context, { fast: true });
  await keyedPng(fixture.candidateInput, 100, 100);
  const report = JSON.parse(await readFile(fixture.reportPath, 'utf8'));
  report.verdict = 'HARD_REJECTED';
  report.failure_codes = ['CANVAS_OR_GREEN_FIELD_INVALID'];
  report.checks.canvas_dimensions = false;
  await writeFile(fixture.reportPath, JSON.stringify(report));

  await assert.rejects(finalizePosterCandidate({
    outputRoot: fixture.outputRoot, jobId: 'poster-job-1', layerIndex: 1,
    candidateInputPath: fixture.candidateInput, reviewReportPath: fixture.reportPath, dispatchId: fixture.dispatchId,
  }), /dimensions/i);
  const saved = await readPosterJob(fixture.outputRoot, 'poster-job-1');
  const candidate = saved.manifest.candidates[0];
  assert.equal(candidate.status, 'HARD_REJECTED');
  assert.deepEqual(candidate.failure_codes, ['CANVAS_OR_GREEN_FIELD_INVALID']);
  assert.equal(candidate.review_report, fixture.reportPath);
  assert.equal(candidate.dimensions.width, 100);
  assert.equal(candidate.release_gate.checks.canvas_dimensions, false);
  assert.equal(await lstat(candidate.path).then(() => true), true);
  assert.equal(saved.manifest.layers[0].candidate_output, candidate.path);
  assert.deepEqual(await readdir(saved.paths.layers), []);
});

for (const fast of [false, true]) {
  test(`trusted internal ${fast ? 'fast' : 'high-quality'} rejected PNG persists raw review evidence`, async (context) => {
    const fixture = await directRejectedCandidateFixture(context, { fast });
    await assert.rejects(finalizePosterCandidate({
      outputRoot: fixture.outputRoot, jobId: 'poster-job-1', layerIndex: 1,
      candidateInputPath: fixture.candidateInput, reviewReportPath: fixture.reportPath, trustedInternal: true,
    }), /dimensions/i);
    const saved = await readPosterJob(fixture.outputRoot, 'poster-job-1');
    const candidate = saved.manifest.candidates[0];
    assert.equal(candidate.status, 'HARD_REJECTED');
    assert.equal(candidate.path, saved.manifest.layers[0].candidate_output);
    assert.equal(candidate.review_report, fixture.reportPath);
    assert.deepEqual(candidate.failure_codes, ['CANVAS_OR_GREEN_FIELD_INVALID']);
    assert.deepEqual(await readdir(saved.paths.layers), []);
  });
}

for (const [scenario, tamper] of [
  ['missing candidate bytes', async (candidatePath) => rm(candidatePath)],
  ['candidate digest drift', async (candidatePath) => writeFile(candidatePath, 'candidate bytes changed after authority publish')],
]) {
  test(`finalizing replay fails closed and persists recovery failure for ${scenario}`, async (context) => {
    const { outputRoot, record, dispatchId, spec, reportPath, candidateInput } = await routedCandidateFixture(context);
    await finalizePosterCandidate({
      outputRoot, jobId: 'poster-job-1', layerIndex: 1, candidateInputPath: candidateInput,
      reviewReportPath: reportPath, dispatchId,
    });
    const dispatchPath = path.join(record.paths.root, 'foreground-dispatches', `${dispatchId}.json`);
    const dispatch = JSON.parse(await readFile(dispatchPath, 'utf8'));
    await writeFile(dispatchPath, JSON.stringify({ ...dispatch, status: 'finalizing' }));
    await tamper(spec.candidate_path);

    await assert.rejects(finalizePosterCandidate({
      outputRoot, jobId: 'poster-job-1', layerIndex: 1, candidateInputPath: candidateInput,
      reviewReportPath: reportPath, dispatchId,
    }), /candidate|SHA-256|PNG|missing|drift/i);
    const failed = await readPosterJob(outputRoot, 'poster-job-1');
    assert.equal(failed.manifest.layers[0].status, 'HARD_REJECTED');
    assert.deepEqual(failed.manifest.layers[0].failure_codes, ['GENERATION_FAILED']);
    assert.equal(failed.manifest.candidates[0].status, 'HARD_REJECTED');
    assert.equal((await readForegroundDispatch(record.paths.root, { dispatchId, rootKind: 'poster' })).status, 'failed');
  });
}

test('trusted internal local candidate retry records its hard-rejected second candidate', async (context) => {
  const { outputRoot, record, candidateInput } = await trustedInternalCandidateFixture(context);
  const retry = await prepareTrustedInternalRetry(outputRoot);
  assert.equal(retry.candidate_number, 2);
  const retryReport = path.join(record.paths.evidence, 'candidate-review-2.json');
  await writeFile(retryReport, JSON.stringify({ verdict: 'NEEDS_USER_REVIEW', failure_codes: [], checks: { source_comparison: false, locked_anchors: true, repair_envelope: true, canvas_dimensions: true, key_field: true }, job_id: 'poster-job-1', layer_index: 1, candidate_id: retry.candidate_id, authorization_id: retry.authorization_id, plan_version: 2, candidate_number: 2 }));
  const retryResult = await finalizePosterCandidate({ outputRoot, jobId: 'poster-job-1', layerIndex: 1, candidateInputPath: candidateInput, reviewReportPath: retryReport, trustedInternal: true });
  assert.equal(retryResult.status, 'HARD_REJECTED');
  assert.equal((await readPosterJob(outputRoot, 'poster-job-1')).manifest.candidates.length, 2);
});

test('candidate finalization rejects an unknown release code as an invalid report', async (context) => {
  const { outputRoot, record, candidateInput } = await trustedInternalCandidateFixture(context);
  const retry = await prepareTrustedInternalRetry(outputRoot);
  const reportPath = path.join(record.paths.evidence, 'candidate-review-unknown-code.json');
  await writeFile(reportPath, JSON.stringify({
    verdict: 'HARD_REJECTED', failure_codes: ['NOT_A_V3_1_CODE'],
    checks: { source_comparison: true, locked_anchors: true, repair_envelope: true, canvas_dimensions: true, key_field: true },
    job_id: 'poster-job-1', layer_index: 1, candidate_id: retry.candidate_id,
    authorization_id: retry.authorization_id, plan_version: 2, candidate_number: retry.candidate_number,
  }));

  await assert.rejects(finalizePosterCandidate({
    outputRoot, jobId: 'poster-job-1', layerIndex: 1,
    candidateInputPath: candidateInput, reviewReportPath: reportPath, trustedInternal: true,
  }), /unknown poster failure code/i);
  const saved = await readPosterJob(outputRoot, 'poster-job-1');
  assert.equal(saved.manifest.candidates.length, 2);
  assert.equal(saved.manifest.candidates.at(-1).status, 'HARD_REJECTED');
});

test('trusted internal local candidate finalizer rejects a symlinked review report', async (context) => {
  const { outputRoot, record, candidateInput } = await trustedInternalCandidateFixture(context);
  await prepareTrustedInternalRetry(outputRoot);
  const outside = path.join(outputRoot, 'outside');
  await mkdir(outside);
  await writeFile(path.join(outside, 'report.json'), '{}');
  await symlink(outside, path.join(record.paths.evidence, 'escape'));
  await assert.rejects(finalizePosterCandidate({ outputRoot, jobId: 'poster-job-1', layerIndex: 1, candidateInputPath: candidateInput, reviewReportPath: path.join(record.paths.evidence, 'escape', 'report.json'), trustedInternal: true }), /symlink/);
});

test('trusted internal local candidate finalizer preserves a divergent existing target', async (context) => {
  const { outputRoot, record, candidateInput } = await trustedInternalCandidateFixture(context);
  const retry = await prepareTrustedInternalRetry(outputRoot);
  const reportPath = await writeTrustedInternalReview(record, retry, 'candidate-review-existing-target.json', {
    source_comparison: true, locked_anchors: true, repair_envelope: true, canvas_dimensions: true, key_field: true,
  });
  await writeFile(retry.candidate_path, 'sentinel candidate must survive');
  await assert.rejects(finalizePosterCandidate({
    outputRoot, jobId: 'poster-job-1', layerIndex: 1,
    candidateInputPath: candidateInput, reviewReportPath: reportPath, trustedInternal: true,
  }));
  assert.equal(await readFile(retry.candidate_path, 'utf8'), 'sentinel candidate must survive');
});

test('trusted internal local candidate finalizer removes a new target after metadata failure', async (context) => {
  const { outputRoot, record, candidateInput } = await trustedInternalCandidateFixture(context);
  const retry = await prepareTrustedInternalRetry(outputRoot);
  const reportPath = await writeTrustedInternalReview(record, retry, 'candidate-review-cleanup.json', {
    source_comparison: true, locked_anchors: true, repair_envelope: true, canvas_dimensions: true, key_field: true,
  });
  await assert.rejects(finalizePosterCandidate({
    outputRoot, jobId: 'poster-job-1', layerIndex: 1, candidateInputPath: candidateInput, reviewReportPath: reportPath,
    afterCandidatePublished: () => { throw new Error('injected metadata persistence failure'); }, trustedInternal: true,
  }), /injected metadata persistence failure/);
  await assert.rejects(readFile(retry.candidate_path), /ENOENT/);
});

test('candidate finalization rejects publication bytes changed before metadata commit', async (context) => {
  const { outputRoot, record, candidateInput } = await trustedInternalCandidateFixture(context);
  const retry = await prepareTrustedInternalRetry(outputRoot);
  const reportPath = await writeTrustedInternalReview(record, retry, 'candidate-review-mutated-target.json', {
    source_comparison: true, locked_anchors: true, repair_envelope: true, canvas_dimensions: true, key_field: true,
  });

  await assert.rejects(finalizePosterCandidate({
    outputRoot, jobId: 'poster-job-1', layerIndex: 1,
    candidateInputPath: candidateInput, reviewReportPath: reportPath, trustedInternal: true,
    afterCandidatePublished: (targetPath) => writeFile(targetPath, 'changed after review'),
  }), /bytes changed|SHA-256/i);

  const saved = await readPosterJob(outputRoot, 'poster-job-1');
  assert.equal(saved.manifest.candidates.length, 2);
  assert.equal(saved.manifest.candidates.at(-1).status, 'HARD_REJECTED');
  await assert.rejects(readFile(retry.candidate_path), /ENOENT/);
});

test('routed candidate retry commits metadata when the exact target survived a finalizing crash', async (context) => {
  const fixture = await routedCandidateFixture(context);
  const { outputRoot, record, dispatchId, spec, reportPath, candidateInput } = fixture;
  const manifestBeforeCrash = structuredClone((await readPosterJob(outputRoot, 'poster-job-1')).manifest);
  const candidateBytes = await readFile(candidateInput);

  await assert.rejects(finalizeForegroundDispatch(record.paths.root, {
    dispatchId, rootKind: 'poster',
    binding: {
      taskKind: 'poster_candidate', layerIndex: 1, candidateNumber: spec.candidate_number,
      authorizationId: spec.authorization_id, planVersion: spec.plan_version,
    },
    publish: async () => {
      await writeFile(spec.candidate_path, candidateBytes);
      throw new Error('simulated crash after candidate publication');
    },
  }), (error) => {
    assert.equal(error.message, 'simulated crash after candidate publication');
    return true;
  });
  assert.equal((await readForegroundDispatch(record.paths.root, { dispatchId, rootKind: 'poster' })).status, 'finalizing');
  assert.deepEqual((await readPosterJob(outputRoot, 'poster-job-1')).manifest, manifestBeforeCrash);

  const result = await finalizePosterCandidate({
    outputRoot, jobId: 'poster-job-1', layerIndex: 1,
    candidateInputPath: candidateInput, reviewReportPath: reportPath, dispatchId,
  });
  assert.equal(result.status, 'NEEDS_USER_REVIEW');
  assert.deepEqual(await readFile(spec.candidate_path), candidateBytes);
  const saved = await readPosterJob(outputRoot, 'poster-job-1');
  assert.equal(saved.manifest.candidates.length, 1);
  assert.equal(saved.manifest.candidates[0].candidate_id, spec.candidate_id);
  assert.equal((await readForegroundDispatch(record.paths.root, { dispatchId, rootKind: 'poster' })).status, 'completed');
});

test('routed candidate retry records a recoverable failure for a different surviving target', async (context) => {
  const fixture = await routedCandidateFixture(context);
  const { outputRoot, record, dispatchId, spec, reportPath, candidateInput } = fixture;
  const differentTarget = Buffer.from('different candidate bytes that must survive');

  await assert.rejects(finalizeForegroundDispatch(record.paths.root, {
    dispatchId, rootKind: 'poster',
    publish: async () => {
      await writeFile(spec.candidate_path, differentTarget);
      throw new Error('simulated crash after divergent publication');
    },
  }));
  await assert.rejects(finalizePosterCandidate({
    outputRoot, jobId: 'poster-job-1', layerIndex: 1,
    candidateInputPath: candidateInput, reviewReportPath: reportPath, dispatchId,
  }), (error) => {
    assert.equal(error.message, 'existing candidate target differs from the exact staged candidate');
    return true;
  });
  assert.deepEqual(await readFile(spec.candidate_path), differentTarget);
  const failed = await readPosterJob(outputRoot, 'poster-job-1');
  assert.equal(failed.manifest.layers[0].status, 'HARD_REJECTED');
  assert.deepEqual(failed.manifest.candidates[0].failure_codes, ['GENERATION_FAILED']);
  assert.equal((await readForegroundDispatch(record.paths.root, { dispatchId, rootKind: 'poster' })).status, 'failed');
});

for (const action of ['cancel', 'abandon']) {
  test(`${action}ed routed candidate dispatch rejects its public finalizer without publishing`, async (context) => {
    const fixture = await routedCandidateFixture(context, { confirmModel: action === 'abandon' });
    const { outputRoot, record, dispatchId, spec, reportPath, candidateInput } = fixture;

    const controlled = await controlPosterDispatch(record.paths.root, { dispatchId, action });
    assert.equal(controlled.status, 'CANCELLED');
    await assert.rejects(finalizePosterCandidate({
      outputRoot, jobId: 'poster-job-1', layerIndex: 1,
      candidateInputPath: candidateInput, reviewReportPath: reportPath, dispatchId,
    }));
    const controlledJob = await readPosterJob(outputRoot, 'poster-job-1');
    if (action === 'cancel') {
      assert.equal(controlledJob.manifest.layers[0].status, 'GENERATION_AUTHORIZED');
      assert.equal(controlledJob.manifest.layers[0].authorization_consumed, false);
      assert.deepEqual(controlledJob.manifest.authorizations, []);
    } else {
      assert.equal(controlledJob.manifest.layers[0].status, 'HARD_REJECTED');
      assert.deepEqual(controlledJob.manifest.layers[0].failure_codes, ['GENERATION_FAILED', 'GENERATION_ABANDONED']);
      assert.equal(controlledJob.manifest.authorizations[0].finalized, true);
    }
    await assert.rejects(readFile(spec.candidate_path), (error) => error.code === 'ENOENT');
    assert.equal((await readForegroundDispatch(record.paths.root, { dispatchId, rootKind: 'poster' })).status, 'cancelled');
    await assert.doesNotReject(controlPosterDispatch(record.paths.root, { dispatchId, action }), 'control replay must finish an interrupted reservation repair');
  });
}

test('idempotent cancel and abandon never rewrite a completed candidate manifest', async (context) => {
  for (const action of ['cancel', 'abandon']) {
    const fixture = await routedCandidateFixture(context);
    await finalizePosterCandidate({
      outputRoot: fixture.outputRoot, jobId: 'poster-job-1', layerIndex: 1, dispatchId: fixture.dispatchId,
      candidateInputPath: fixture.candidateInput, reviewReportPath: fixture.reportPath,
    });
    const completed = await readPosterJob(fixture.outputRoot, 'poster-job-1');
    await assert.doesNotReject(controlPosterDispatch(fixture.record.paths.root, { dispatchId: fixture.dispatchId, action }));
    assert.deepEqual((await readPosterJob(fixture.outputRoot, 'poster-job-1')).manifest, completed.manifest, `${action} preserves completed manifest`);
    assert.equal((await readForegroundDispatch(fixture.record.paths.root, { dispatchId: fixture.dispatchId, rootKind: 'poster' })).status, 'completed');
  }
});
