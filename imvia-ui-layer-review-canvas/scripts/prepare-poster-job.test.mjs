import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { initializePosterJob, mutatePosterJob, readPosterJob } from '../src/poster-job-store.js';
import { buildFastLayerSnapshot, createFastPosterPlan } from '../src/poster-fast-plan.js';
import { digestCanonicalJson } from '../src/poster-plan.js';
import {
  preparePosterJob,
  reconcilePreparedPosterCandidate,
  restoreUnsentPosterCandidateAuthorization,
  rollbackPreparedPosterCandidate,
} from './prepare-poster-job.mjs';

const sourcePath = path.resolve('public/demo-source.png');

function layer(overrides = {}) {
  return {
    layer_index: 1, layer_name: 'Title', asset_role: 'headline', layer_type: 'graphic', z_order: 1,
    position: 'top center', visible_content: ['Title'], included_content: ['Title'], excluded_content: [],
    occludes: [], occluded_by: [], source_evidence: [{ description: 'title', region: [0, 0, 1, 1] }],
    support_components: [], ui_independence: 'not_applicable',
    repair_envelope: { description: '', covered_segment: [], seam_band: '', forbidden_regions: [] },
    locked_visible_anchors: ['glyphs'], completion_required: false, completion_regions: [], risk_level: 'high',
    processing_mode: 'graphic_completion', fill_color: '#00FF00', compositing_mode: 'Normal',
    separation_reason: 'independent title', status: 'PENDING',
    ...overrides,
  };
}

function plan(status = 'PLAN_REVIEW') {
  return {
    version: '1.0', task: 'poster_layering', job_id: 'poster-job-1', project_id: 'project-1', image_id: 'image-1',
    source: { path: 'source.png', width: 1500, height: 3664, aspect_ratio: 1500 / 3664, target_2x: false },
    document_mode: 'poster', status, plan_version: 2,
    skill_contract: { base: 'lovart-poster-layering-v3-1', adapter: 'imvia-poster-layering-workbench-v1', auto_retry: false, full_canvas: true },
    layers: [layer()], output_directory: 'ignored',
  };
}

async function createJob(context, status) {
  const outputRoot = await mkdtemp(path.join(os.tmpdir(), 'prepare-poster-'));
  context.after(() => rm(outputRoot, { recursive: true, force: true }));
  await initializePosterJob({ outputRoot, jobId: 'poster-job-1', sourcePath, plan: plan(status) });
  return outputRoot;
}

async function authorize(outputRoot, status = 'GENERATION_AUTHORIZED') {
  const record = await readPosterJob(outputRoot, 'poster-job-1');
  await mutatePosterJob(outputRoot, 'poster-job-1', record.manifest.revision, (current) => ({
    ...current,
    manifest: { ...current.manifest, layers: current.manifest.layers.map((entry) => entry.layer_index === 1
      ? { ...entry, status, authorization_plan_version: current.plan.plan_version } : entry) },
  }));
}

async function createFastJob(context) {
  const outputRoot = await mkdtemp(path.join(os.tmpdir(), 'prepare-fast-poster-'));
  context.after(() => rm(outputRoot, { recursive: true, force: true }));
  const fast = buildFastLayerSnapshot(createFastPosterPlan({
    ...plan('PLAN_REVIEW'), layers: [layer({ processing_category: 'text', planning_confidence: 0.5, user_confirmed: false })],
  }), 1).plan;
  const { initializePosterFastJob } = await import('../src/poster-job-store.js');
  await initializePosterFastJob({ outputRoot, jobId: 'poster-job-1', sourcePath, plan: fast });
  await authorize(outputRoot);
  const record = await readPosterJob(outputRoot, 'poster-job-1');
  const snapshotPath = path.join(outputRoot, 'confirmed-snapshot.json');
  await writeFile(snapshotPath, `${JSON.stringify(record.plan.layers[0].confirmed_snapshot, null, 2)}\n`);
  return { outputRoot, record, snapshotPath };
}

test('analysis preparation emits only the trusted package paths', async (context) => {
  const outputRoot = await createJob(context, 'PLAN_REVIEW');
  const spec = await preparePosterJob({ outputRoot, jobId: 'poster-job-1', phase: 'analysis' });
  assert.deepEqual(spec, {
    task_kind: 'poster_analysis', job_id: 'poster-job-1', plan_version: 2,
    authoritative_plan_path: path.join(outputRoot, 'poster-jobs', 'poster-job-1', 'poster-layer-plan.json'),
    plan_path: path.join(outputRoot, 'poster-jobs', 'poster-job-1', 'evidence', 'poster-layer-plan.candidate.json'),
    analysis_plan_path: path.join(outputRoot, 'poster-jobs', 'poster-job-1', 'evidence', 'poster-layer-plan.candidate.json'),
    source_path: path.join(outputRoot, 'poster-jobs', 'poster-job-1', 'source.png'),
    output_directory: path.join(outputRoot, 'poster-jobs', 'poster-job-1'),
  });
});

test('candidate preparation consumes one authorization for the next exact candidate', async (context) => {
  const outputRoot = await createJob(context, 'PLAN_CONFIRMED');
  await authorize(outputRoot);
  const spec = await preparePosterJob({ outputRoot, jobId: 'poster-job-1', phase: 'candidate', layerIndex: 1 });
  assert.equal(spec.task_kind, 'poster_candidate');
  assert.equal(spec.layer_index, 1);
  assert.equal(spec.candidate_number, 1);
  assert.match(spec.authorization_id, /^poster-job-1:2:1:1$/);
  await assert.rejects(
    preparePosterJob({ outputRoot, jobId: 'poster-job-1', phase: 'candidate', layerIndex: 1 }),
    /GENERATION_AUTHORIZED|RETRY_AUTHORIZED/,
  );
  const saved = await readPosterJob(outputRoot, 'poster-job-1');
  assert.equal(saved.manifest.authorizations[0].consumed, true);
  assert.equal(saved.manifest.layers[0].status, 'GENERATING');
});

test('a routed prepare without its dispatch is reconciled back to an explicit authorization', async (context) => {
  const outputRoot = await createJob(context, 'PLAN_CONFIRMED');
  await authorize(outputRoot);
  await preparePosterJob({ outputRoot, jobId: 'poster-job-1', phase: 'candidate', layerIndex: 1, dispatchId: 'dispatch-crashed' });
  assert.equal((await readPosterJob(outputRoot, 'poster-job-1')).manifest.layers[0].status, 'GENERATING');
  const recovered = await reconcilePreparedPosterCandidate({ outputRoot, jobId: 'poster-job-1' });
  assert.equal(recovered.manifest.layers[0].status, 'GENERATION_AUTHORIZED');
  assert.equal(recovered.manifest.layers[0].authorization_consumed, false);
  assert.deepEqual(recovered.manifest.authorizations, []);
});

test('a failed first-time submission restores PENDING instead of displaying a false generating state', async (context) => {
  const outputRoot = await createJob(context, 'PLAN_CONFIRMED');
  await authorize(outputRoot);

  const restored = await restoreUnsentPosterCandidateAuthorization({
    outputRoot,
    jobId: 'poster-job-1',
    layerIndex: 1,
    planVersion: 2,
    previousStatus: 'PENDING',
  });

  assert.equal(restored.manifest.layers[0].status, 'PENDING');
  assert.equal(restored.manifest.layers[0].authorization_plan_version, undefined);
  assert.equal(restored.manifest.layers[0].authorization_consumed, false);
});

test('a replayed cancellation cannot roll back a later dispatch with the same deterministic authorization id', async (context) => {
  const outputRoot = await createJob(context, 'PLAN_CONFIRMED');
  await authorize(outputRoot);
  const first = await preparePosterJob({ outputRoot, jobId: 'poster-job-1', phase: 'candidate', layerIndex: 1, dispatchId: 'dispatch-a' });
  await rollbackPreparedPosterCandidate({ outputRoot, jobId: 'poster-job-1', authorizationId: first.authorization_id, dispatchId: 'dispatch-a' });
  const second = await preparePosterJob({ outputRoot, jobId: 'poster-job-1', phase: 'candidate', layerIndex: 1, dispatchId: 'dispatch-b' });
  assert.equal(second.authorization_id, first.authorization_id);
  await rollbackPreparedPosterCandidate({ outputRoot, jobId: 'poster-job-1', authorizationId: first.authorization_id, dispatchId: 'dispatch-a', idempotent: true });
  const current = await readPosterJob(outputRoot, 'poster-job-1');
  assert.equal(current.manifest.layers[0].status, 'GENERATING');
  assert.equal(current.manifest.authorizations[0].dispatch_id, 'dispatch-b');
});

test('routed reservation dispatch ids are path-safe and unreadable journals fail closed', async (context) => {
  const outputRoot = await createJob(context, 'PLAN_CONFIRMED');
  await authorize(outputRoot);
  await assert.rejects(
    preparePosterJob({ outputRoot, jobId: 'poster-job-1', phase: 'candidate', layerIndex: 1, dispatchId: '../outside' }),
    /dispatchId is invalid/,
  );
  const spec = await preparePosterJob({ outputRoot, jobId: 'poster-job-1', phase: 'candidate', layerIndex: 1, dispatchId: 'safe-dispatch' });
  const record = await readPosterJob(outputRoot, 'poster-job-1');
  await mutatePosterJob(outputRoot, 'poster-job-1', record.manifest.revision, (current) => ({
    ...current, manifest: { ...current.manifest, authorizations: current.manifest.authorizations.map((entry) => entry.authorization_id === spec.authorization_id
      ? { ...entry, dispatch_id: '../outside' } : entry) },
  }));
  await assert.rejects(reconcilePreparedPosterCandidate({ outputRoot, jobId: 'poster-job-1' }), /persisted dispatch_id is invalid/);
});

test('candidate preparation rejects a caller revision that went stale before the locked mutation', async (context) => {
  const outputRoot = await createJob(context, 'PLAN_CONFIRMED');
  await authorize(outputRoot);
  const staleRevision = (await readPosterJob(outputRoot, 'poster-job-1')).manifest.revision;
  await mutatePosterJob(outputRoot, 'poster-job-1', staleRevision, (current) => ({
    ...current, manifest: { ...current.manifest, audit_note: 'newer mutation' },
  }));
  await assert.rejects(
    preparePosterJob({ outputRoot, jobId: 'poster-job-1', phase: 'candidate', layerIndex: 1, expectedManifestRevision: staleRevision }),
    /revision is stale/,
  );
});

test('candidate preparation rejects an unconfirmed plan', async (context) => {
  const outputRoot = await createJob(context, 'PLAN_REVIEW');
  await assert.rejects(
    preparePosterJob({ outputRoot, jobId: 'poster-job-1', phase: 'candidate', layerIndex: 1 }),
    /PLAN_CONFIRMED/,
  );
});

test('candidate preparation never treats PENDING as an ImageGen authorization', async (context) => {
  const outputRoot = await createJob(context, 'PLAN_CONFIRMED');
  await assert.rejects(
    preparePosterJob({ outputRoot, jobId: 'poster-job-1', phase: 'candidate', layerIndex: 1 }),
    /GENERATION_AUTHORIZED|RETRY_AUTHORIZED/,
  );
});

test('an explicit retry authorization permits the next candidate number', async (context) => {
  const outputRoot = await createJob(context, 'PLAN_CONFIRMED');
  const record = await readPosterJob(outputRoot, 'poster-job-1');
  await mutatePosterJob(outputRoot, 'poster-job-1', record.manifest.revision, (current) => ({
    ...current,
    manifest: {
      ...current.manifest,
      candidates: [{ candidate_id: 'old', layer_index: 1, candidate_number: 1, status: 'HARD_REJECTED' }],
      layers: current.manifest.layers.map((entry) => entry.layer_index === 1
        ? { ...entry, status: 'RETRY_AUTHORIZED', authorization_plan_version: current.plan.plan_version } : entry),
    },
  }));
  const spec = await preparePosterJob({ outputRoot, jobId: 'poster-job-1', phase: 'candidate', layerIndex: 1 });
  assert.equal(spec.candidate_number, 2);
});

test('preparation rejects source dimensions that do not match the stored full canvas', async (context) => {
  const outputRoot = await mkdtemp(path.join(os.tmpdir(), 'prepare-poster-'));
  context.after(() => rm(outputRoot, { recursive: true, force: true }));
  await initializePosterJob({
    outputRoot, jobId: 'poster-job-1', sourcePath,
    plan: { ...plan('PLAN_REVIEW'), source: { path: 'source.png', width: 1000, height: 1000, aspect_ratio: 1, target_2x: false } },
  });
  await assert.rejects(
    preparePosterJob({ outputRoot, jobId: 'poster-job-1', phase: 'analysis' }),
    /source dimensions/,
  );
});

test('fast PLAN_REVIEW preflight reads the confirmed snapshot file and binds its single category', async (context) => {
  const { outputRoot, record, snapshotPath } = await createFastJob(context);
  const spec = await preparePosterJob({
    outputRoot, jobId: 'poster-job-1', phase: 'candidate', layerIndex: 1, planningMode: 'targeted_fast',
    snapshotPath, sourceFingerprint: digestCanonicalJson(record.plan.source), processingCategory: 'text',
    dispatchId: 'dispatch-fast-1',
  });
  assert.equal(spec.planning_mode, 'targeted_fast');
  assert.equal(spec.snapshot_path, snapshotPath);
  assert.match(spec.snapshot_sha256, /^[a-f0-9]{64}$/);
  assert.equal(spec.processing_category, 'text');
  const saved = await readPosterJob(outputRoot, 'poster-job-1');
  const execution = saved.manifest.layers[0].fast_execution;
  assert.equal(execution.dispatch_id, 'dispatch-fast-1');
  assert.equal(execution.authorization_id, spec.authorization_id);
  assert.equal(execution.current_stage, 'imagegen');
  assert.equal(execution.stages.imagegen.status, 'running');
  assert.equal(execution.stages.rmbg.status, 'pending');
});

test('fast preflight rejects absent, mismatched, and wrong-category snapshot bindings', async (context) => {
  const missing = await createFastJob(context);
  await assert.rejects(preparePosterJob({
    outputRoot: missing.outputRoot, jobId: 'poster-job-1', phase: 'candidate', layerIndex: 1,
    planningMode: 'targeted_fast', sourceFingerprint: digestCanonicalJson(missing.record.plan.source),
  }), /snapshot|category/i);
  await assert.rejects(preparePosterJob({
    outputRoot: missing.outputRoot, jobId: 'poster-job-1', phase: 'candidate', layerIndex: 1,
    planningMode: 'targeted_fast', layerSnapshot: missing.record.plan.layers[0].confirmed_snapshot,
    sourceFingerprint: digestCanonicalJson(missing.record.plan.source),
  }), /requires snapshotPath/i);

  const mismatched = await createFastJob(context);
  const forged = structuredClone(mismatched.record.plan.layers[0].confirmed_snapshot);
  forged.layer_index = 2;
  await writeFile(mismatched.snapshotPath, JSON.stringify(forged));
  await assert.rejects(preparePosterJob({
    outputRoot: mismatched.outputRoot, jobId: 'poster-job-1', phase: 'candidate', layerIndex: 1,
    planningMode: 'targeted_fast', snapshotPath: mismatched.snapshotPath,
    sourceFingerprint: digestCanonicalJson(mismatched.record.plan.source),
  }), /snapshot/i);

  const nonRegular = await createFastJob(context);
  await assert.rejects(preparePosterJob({
    outputRoot: nonRegular.outputRoot, jobId: 'poster-job-1', phase: 'candidate', layerIndex: 1,
    planningMode: 'targeted_fast', snapshotPath: nonRegular.outputRoot,
    sourceFingerprint: digestCanonicalJson(nonRegular.record.plan.source),
  }), /regular JSON file/i);

  const wrongCategory = await createFastJob(context);
  await assert.rejects(preparePosterJob({
    outputRoot: wrongCategory.outputRoot, jobId: 'poster-job-1', phase: 'candidate', layerIndex: 1,
    planningMode: 'targeted_fast', snapshotPath: wrongCategory.snapshotPath,
    sourceFingerprint: digestCanonicalJson(wrongCategory.record.plan.source), processingCategory: 'background',
  }), /category block/i);
});
