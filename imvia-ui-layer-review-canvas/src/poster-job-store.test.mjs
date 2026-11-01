import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { copyFile, link, lstat, mkdir, mkdtemp, open, readFile, readdir, rename, rm, stat, symlink, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { deflateSync } from 'node:zlib';
import { unzipSync } from 'fflate';
import {
  acceptPosterCandidate,
  authorizePosterFastPostprocessRetry,
  authorizePosterRetry,
  createPosterExportArchive,
  fsyncDirectory,
  initializePosterFastJob,
  initializePosterJob,
  mutatePosterJob,
  readPosterJob,
  reauthorizePosterAuditLayer,
  recordPosterCandidate,
  recordPosterGenerationFailure,
  resolvePosterManifestTemplatePath,
  runPosterRecompositionAudit,
  synchronizeFastPosterManifest,
} from './poster-job-store.js';
import { readPosterPng } from './poster-png.js';
import { buildFastLayerSnapshot, createFastPosterPlan, suggestPosterFastLayers } from './poster-fast-plan.js';

const fixturePng = path.resolve('public/demo-source.png');

function planFixture(overrides = {}) {
  return {
    version: '1.0',
    task: 'poster_layering',
    job_id: 'poster-job-1',
    project_id: 'project-1',
    image_id: 'image-1',
    source: { path: 'untrusted-source.png', width: 1920, height: 1080, aspect_ratio: 16 / 9, target_2x: false },
    document_mode: 'poster',
    status: 'PLAN_REVIEW',
    plan_version: 1,
    skill_contract: {
      base: 'lovart-poster-layering-v3-1',
      adapter: 'imvia-poster-layering-workbench-v1',
      auto_retry: false,
      full_canvas: true,
    },
    layers: [{ layer_index: 1, layer_name: '标题', status: 'PENDING', generation_count: 0 }],
    output_directory: 'untrusted-output',
    ...overrides,
  };
}

test('fast plan edits keep manifest projects aligned without reusing a deleted project state', () => {
  const manifest = {
    revision: 9,
    layers: [
      { layer_index: 1, layer_name: '主体', status: 'ACCEPTED', generation_count: 1 },
      { layer_index: 2, layer_name: '文字', status: 'HARD_REJECTED', generation_count: 1 },
      { layer_index: 3, layer_name: '背景', status: 'PENDING', generation_count: 0 },
    ],
    candidates: [
      { candidate_id: 'keep', layer_index: 1 },
      { candidate_id: 'delete', layer_index: 2 },
    ],
    authorizations: [{ authorization_id: 'delete-auth', layer_index: 2 }],
  };
  const plan = {
    planning_mode: 'targeted_fast',
    layers: [
      { layer_index: 1, layer_name: '主体', processing_category: 'subject' },
      { layer_index: 3, layer_name: '背景', processing_category: 'background' },
      { layer_index: 7, layer_name: '新文字', processing_category: 'text' },
    ],
  };

  const result = synchronizeFastPosterManifest(manifest, plan);

  assert.deepEqual(result.layers.map((layer) => [layer.layer_index, layer.status]), [
    [1, 'ACCEPTED'], [3, 'PENDING'], [7, 'PENDING'],
  ]);
  assert.deepEqual(result.candidates.map((candidate) => candidate.candidate_id), ['keep']);
  assert.deepEqual(result.authorizations, []);
});

async function createJob(context, options = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'poster-jobs-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  return {
    root,
    record: await initializePosterJob({
      outputRoot: root,
      jobId: 'poster-job-1',
      sourcePath: fixturePng,
      plan: planFixture(),
      ...options,
    }),
  };
}

function crc32(...buffers) {
  let crc = 0xffffffff;
  for (const buffer of buffers) for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const typeBytes = Buffer.from(type);
  const output = Buffer.alloc(data.length + 12);
  output.writeUInt32BE(data.length, 0);
  typeBytes.copy(output, 4);
  data.copy(output, 8);
  output.writeUInt32BE(crc32(typeBytes, data), data.length + 8);
  return output;
}

async function keyedPng(target, {
  width = 4, height = 2, alpha = 255, contaminated = false, marker = false,
} = {}) {
  const channels = alpha === null ? 3 : 4;
  const raw = Buffer.alloc((width * channels + 1) * height);
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    const offset = y * (width * channels + 1) + 1 + x * channels;
    raw[offset] = 0;
    raw[offset + 1] = 255;
    raw[offset + 2] = 0;
    if (channels === 4) raw[offset + 3] = alpha;
  }
  if (contaminated) raw[2] = 254;
  if (marker) {
    const offset = 1 + channels;
    raw[offset] = 255;
    raw[offset + 1] = 0;
    raw[offset + 2] = 0;
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = channels === 4 ? 6 : 2;
  await writeFile(target, Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', header), pngChunk('IDAT', deflateSync(raw)), pngChunk('IEND', Buffer.alloc(0)),
  ]));
}

async function rgbPng(target, { width = 4, height = 2, pixels } = {}) {
  const colors = pixels || Array.from({ length: width * height }, () => [0, 255, 0]);
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    const offset = y * (width * 3 + 1) + 1 + x * 3;
    const color = colors[y * width + x];
    raw[offset] = color[0];
    raw[offset + 1] = color[1];
    raw[offset + 2] = color[2];
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  await writeFile(target, Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', header), pngChunk('IDAT', deflateSync(raw)), pngChunk('IEND', Buffer.alloc(0)),
  ]));
}

async function fileSha256(target) {
  return createHash('sha256').update(await readFile(target)).digest('hex');
}

async function reviewCandidateFixture(context, {
  status = 'NEEDS_USER_REVIEW', failureCodes = [], contaminated = false, releaseGate = true,
} = {}) {
  const plan = planFixture({
    status: 'PLAN_CONFIRMED', plan_version: 2,
    source: { path: 'source.png', width: 4, height: 2, aspect_ratio: 2, target_2x: false },
    layers: [{
      layer_index: 1, layer_name: 'Title', status: 'PENDING', generation_count: 1,
      fill_color: '#00FF00', compositing_mode: 'Normal',
    }],
  });
  const { root, record } = await createJob(context, { plan });
  const candidatePath = path.join(record.paths.candidates, 'layer_1_title_candidate-01.png');
  await keyedPng(candidatePath, { alpha: null, contaminated });
  const candidateSha256 = await fileSha256(candidatePath);
  const candidate = {
    candidate_id: 'candidate-review', layer_index: 1, candidate_number: 1,
    plan_version: 2, path: candidatePath, status, failure_codes: failureCodes, accepted: false,
    candidate_sha256: candidateSha256,
    ...(releaseGate ? { release_gate: {
      verdict: status, failureCodes,
      checks: { source_comparison: true, locked_anchors: true, repair_envelope: true, canvas_dimensions: true, key_field: true },
      candidateId: 'candidate-review', planVersion: 2, candidateSha256,
    } } : {}),
  };
  const reviewed = await mutatePosterJob(root, 'poster-job-1', 1, (current) => ({
    ...current,
    manifest: {
      ...current.manifest,
      candidates: [candidate],
      layers: current.manifest.layers.map((layer) => layer.layer_index === 1 ? {
        ...layer, status, generation_count: 1, candidate_output: candidatePath,
        visual_inspection: {
          performed: true, verdict: status, failure_codes: failureCodes,
          candidate_id: 'candidate-review', plan_version: 2, candidate_sha256: candidateSha256,
        },
      } : layer),
    },
  }));
  return { root, record: reviewed, candidate, candidatePath };
}

async function acceptedAuditFixture(context, { duplicateOwnership = false } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'poster-audit-store-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const sourcePath = path.join(root, 'fixture-source.png');
  const red = [255, 0, 0];
  const blue = [20, 40, 80];
  const green = [0, 255, 0];
  await rgbPng(sourcePath, { pixels: [red, red, ...Array(6).fill(blue)] });
  const plan = planFixture({
    status: 'PLAN_CONFIRMED', plan_version: 3,
    source: { path: 'source.png', width: 4, height: 2, aspect_ratio: 2, target_2x: false },
    layers: [1, 2].map((layer_index) => ({
      layer_index, z_order: layer_index, layer_name: `Layer ${layer_index}`, status: 'PENDING',
      included_content: [duplicateOwnership ? 'shared' : `owned-${layer_index}`],
      fill_color: '#00FF00', compositing_mode: 'Normal',
      occludes: [], occluded_by: [],
    })),
  });
  const initialized = await initializePosterJob({
    outputRoot: root, jobId: 'poster-job-1', sourcePath, plan,
  });
  const accepted = [];
  const candidates = [];
  for (const layer of plan.layers) {
    const target = path.join(initialized.paths.layers, `layer_${layer.layer_index}_source.png`);
    await rgbPng(target, { pixels: layer.layer_index === 1
      ? [red, red, ...Array(6).fill(green)]
      : [green, green, ...Array(6).fill(blue)] });
    const sourceDigest = await fileSha256(target);
    const candidateId = `candidate-${layer.layer_index}`;
    const candidatePath = path.join(initialized.paths.candidates, `layer_${layer.layer_index}.png`);
    await rgbPng(candidatePath, { pixels: layer.layer_index === 1
      ? [red, red, ...Array(6).fill(green)]
      : [green, green, ...Array(6).fill(blue)] });
    const candidateDigest = await fileSha256(candidatePath);
    accepted.push({
      ...layer, status: 'ACCEPTED', accepted_plan_version: 3,
      accepted_candidate_id: candidateId, candidate_output: candidatePath, generation_count: 1,
      source_output: target, source_sha256: sourceDigest,
      visual_inspection: {
        performed: true, verdict: 'NEEDS_USER_REVIEW', failure_codes: [],
        candidate_id: candidateId, plan_version: 3, candidate_sha256: candidateDigest,
      },
    });
    candidates.push({
      candidate_id: candidateId, candidate_number: 1, layer_index: layer.layer_index,
      plan_version: 3, path: candidatePath, status: 'NEEDS_USER_REVIEW', failure_codes: [],
      candidate_sha256: candidateDigest, accepted: true,
      accepted_source_output: target, accepted_source_sha256: sourceDigest,
      release_gate: {
        verdict: 'NEEDS_USER_REVIEW', failureCodes: [],
        checks: {
          source_comparison: true, locked_anchors: true, repair_envelope: true,
          canvas_dimensions: true, key_field: true,
        },
        candidateId, planVersion: 3, candidateSha256: candidateDigest,
      },
    });
  }
  const record = await mutatePosterJob(root, 'poster-job-1', 1, (current) => ({
    ...current, manifest: { ...current.manifest, layers: accepted, candidates },
  }));
  await writeFile(path.join(initialized.paths.candidates, 'raw-candidate.png'), 'excluded');
  return { root, record };
}

test('initialization creates an isolated poster package with its immutable manifest settings', async (context) => {
  const { record } = await createJob(context);

  assert.equal(path.basename(record.paths.source), 'source.png');
  assert.deepEqual((await readdir(record.paths.root)).sort(), [
    'candidates', 'evidence', 'layer_manifest.json', 'layers',
    'poster-execution-report.json', 'poster-layer-plan.json', 'source.png',
  ].sort());
  assert.equal(record.manifest.execution.candidate_visibility, 'hidden');
  assert.equal(record.manifest.revision, 1);
  assert.equal(record.plan.source.path, 'source.png');
  assert.equal(record.plan.output_directory, record.paths.root);
});

test('fast initialization creates the normal package locally at PLAN_REVIEW', async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'poster-fast-jobs-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const record = await initializePosterFastJob({
    outputRoot: root, jobId: 'poster-fast-1', sourcePath: fixturePng,
    plan: planFixture({ planning_mode: 'targeted_fast', status: 'PLAN_REVIEW' }),
  });
  assert.equal(record.plan.status, 'PLAN_REVIEW');
  assert.deepEqual((await readdir(record.paths.root)).filter((name) => ['evidence', 'candidates', 'layers'].includes(name)).sort(), ['candidates', 'evidence', 'layers']);
  await assert.rejects(initializePosterFastJob({
    outputRoot: root, jobId: 'poster-fast-2', sourcePath: fixturePng,
    plan: planFixture({ planning_mode: 'targeted_fast', status: 'ANALYZING' }),
  }), /快速海报任务/);
});

test('generation failure retains a concrete rejected candidate instead of fabricating no-PNG state', async (context) => {
  const { root } = await createJob(context);
  const prepared = await mutatePosterJob(root, 'poster-job-1', 1, (record) => ({
    ...record,
    plan: { ...record.plan, status: 'PLAN_CONFIRMED' },
    manifest: {
      ...record.manifest,
      authorizations: [{
        authorization_id: 'poster-job-1:1:1:1', layer_index: 1, plan_version: 1,
        candidate_number: 1, consumed: true, finalized: false,
      }],
      layers: record.manifest.layers.map((entry) => entry.layer_index === 1 ? {
        ...entry, status: 'GENERATING', authorization_consumed: true, generation_count: 1,
      } : entry),
    },
  }));
  const input = path.join(root, 'raw-rejected.png');
  await copyFile(fixturePng, input);
  const digest = createHash('sha256').update(await readFile(input)).digest('hex');
  const saved = await recordPosterGenerationFailure({
    outputRoot: root, jobId: 'poster-job-1', layerIndex: 1, authorizationId: 'poster-job-1:1:1:1',
    candidateNumber: 1, planVersion: prepared.plan.plan_version, error: 'full canvas check failed',
    failureCodes: ['CANVAS_OR_GREEN_FIELD_INVALID'],
    candidateEvidence: {
      input_path: input, candidate_sha256: digest, dimensions: { width: 1920, height: 1080 },
      review_report: path.join(prepared.paths.evidence, 'candidate-review.json'),
      release_gate: { verdict: 'HARD_REJECTED', failureCodes: ['CANVAS_OR_GREEN_FIELD_INVALID'], checks: { canvas_dimensions: false } },
    },
  });
  const candidate = saved.manifest.candidates[0];
  assert.equal(candidate.path, saved.manifest.layers[0].candidate_output);
  assert.equal(candidate.candidate_sha256, digest);
  assert.equal(candidate.failure_codes[0], 'CANVAS_OR_GREEN_FIELD_INVALID');
  assert.equal(await lstat(candidate.path).then(() => true), true);
});

test('a completed mutation advances the revision so stale reviews cannot overwrite it', async (context) => {
  const { root } = await createJob(context);
  const updated = await mutatePosterJob(root, 'poster-job-1', 1, (record) => ({
    ...record,
    plan: { ...record.plan, status: 'PLAN_CONFIRMED' },
  }));

  assert.equal(updated.manifest.revision, 2);
  await assert.rejects(
    mutatePosterJob(root, 'poster-job-1', 1, (record) => record),
    /版本已变化/,
  );
  assert.equal((await readPosterJob(root, 'poster-job-1')).plan.status, 'PLAN_CONFIRMED');
});

test('job IDs cannot traverse outside the poster-jobs root', async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'poster-jobs-'));
  context.after(() => rm(root, { recursive: true, force: true }));

  await assert.rejects(
    initializePosterJob({ outputRoot: root, jobId: '../escape', sourcePath: fixturePng, plan: planFixture() }),
    /jobId/i,
  );
  assert.deepEqual(await readdir(root), []);
});

test('concurrent mutations from the same revision allow exactly one writer', async (context) => {
  const { root } = await createJob(context);
  const results = await Promise.allSettled([
    mutatePosterJob(root, 'poster-job-1', 1, (record) => ({
      ...record,
      plan: { ...record.plan, status: 'PLAN_CONFIRMED' },
    })),
    mutatePosterJob(root, 'poster-job-1', 1, (record) => ({
      ...record,
      plan: { ...record.plan, status: 'ANALYSIS_FAILED' },
    })),
  ]);

  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter((result) => result.status === 'rejected').length, 1);
  assert.match(results.find((result) => result.status === 'rejected').reason.message, /版本已变化/);
  assert.equal((await readPosterJob(root, 'poster-job-1')).manifest.revision, 2);
});

test('candidate recording retains each candidate instead of replacing earlier review evidence', async (context) => {
  const { root, record } = await createJob(context);
  const firstPath = path.join(record.paths.candidates, 'layer_1_title_candidate-1.png');
  const secondPath = path.join(record.paths.candidates, 'layer_1_title_candidate-2.png');
  await copyFile(fixturePng, firstPath);
  await copyFile(fixturePng, secondPath);

  await recordPosterCandidate(root, 'poster-job-1', {
    candidate_id: 'candidate-1', layer_index: 1, path: firstPath, status: 'NEEDS_USER_REVIEW',
  });
  const saved = await recordPosterCandidate(root, 'poster-job-1', {
    candidate_id: 'candidate-2', layer_index: 1, path: secondPath, status: 'HARD_REJECTED',
  });

  assert.deepEqual(saved.manifest.candidates.map((candidate) => candidate.candidate_id), [
    'candidate-1', 'candidate-2',
  ]);
  assert.ok((await stat(firstPath)).size > 0);
  assert.equal(saved.manifest.revision, 3);
});

test('a missing package recovers as null instead of a partial record', async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'poster-jobs-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  assert.equal(await readPosterJob(root, 'not-created'), null);
});

test('partial packages and wrong package entry types fail closed with a store error', async (context) => {
  const { root, record } = await createJob(context);
  await rm(record.paths.candidates, { recursive: true, force: true });

  await assert.rejects(readPosterJob(root, 'poster-job-1'), /不完整|损坏/);

  for (const [jobId, directory] of [['poster-job-2', 'evidence'], ['poster-job-3', 'layers']]) {
    const partial = await initializePosterJob({
      outputRoot: root, jobId, sourcePath: fixturePng, plan: planFixture({ job_id: jobId }),
    });
    await rm(partial.paths[directory], { recursive: true, force: true });
    await assert.rejects(readPosterJob(root, jobId), /不完整|损坏/);
  }

  const wrongType = await initializePosterJob({
    outputRoot: root, jobId: 'poster-job-4', sourcePath: fixturePng,
    plan: planFixture({ job_id: 'poster-job-4' }),
  });
  await unlink(wrongType.paths.source);
  await mkdir(wrongType.paths.source);

  await assert.rejects(readPosterJob(root, 'poster-job-4'), /不完整|损坏/);
});

test('malformed package metadata fails closed instead of returning an unsafe reload record', async (context) => {
  const { root, record } = await createJob(context);
  await writeFile(record.paths.manifest, '{not json');

  await assert.rejects(readPosterJob(root, 'poster-job-1'), /损坏/);
});

test('failed or interrupted initialization leaves no poisoned final job and a retry succeeds', async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'poster-jobs-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const badTemplate = path.join(root, 'bad-template.json');
  await writeFile(badTemplate, '{not json');

  await assert.rejects(
    initializePosterJob({
      outputRoot: root, jobId: 'poster-job-1', sourcePath: fixturePng, plan: planFixture(),
      manifestTemplatePath: badTemplate,
    }),
    /模板|JSON/,
  );
  assert.equal(await readPosterJob(root, 'poster-job-1'), null);

  const interrupted = path.join(root, 'poster-jobs', '.poster-job-1.tmp-interrupted');
  await mkdir(interrupted, { recursive: true });
  const partialFinal = path.join(root, 'poster-jobs', 'poster-job-1');
  await mkdir(partialFinal, { recursive: true });
  await writeFile(path.join(partialFinal, 'poster-layer-plan.json'), '{}');
  const recovered = await initializePosterJob({
    outputRoot: root, jobId: 'poster-job-1', sourcePath: fixturePng, plan: planFixture(),
  });

  assert.equal(recovered.manifest.revision, 1);
  assert.equal((await readdir(path.dirname(recovered.paths.root))).includes(path.basename(interrupted)), false);
  assert.equal((await readdir(recovered.paths.root)).includes('source.png'), true);
});

test('the manifest template resolves from this portable module bundle', async () => {
  const templatePath = resolvePosterManifestTemplatePath();
  const expectedPath = fileURLToPath(new URL('./assets/poster-layer-manifest-v3.1.json', import.meta.url));
  assert.equal(templatePath, expectedPath);
  assert.equal(path.basename(templatePath), 'poster-layer-manifest-v3.1.json');
  const template = JSON.parse(await readFile(templatePath, 'utf8'));
  assert.equal(template.execution.candidate_visibility, 'hidden');
});

test('a dangling final-job symlink is removed under lock so a retry can initialize safely', async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'poster-jobs-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const jobsRoot = path.join(root, 'poster-jobs');
  const finalJob = path.join(jobsRoot, 'poster-job-1');
  await mkdir(jobsRoot);
  await symlink(path.join(root, 'missing-job'), finalJob);

  const recovered = await initializePosterJob({
    outputRoot: root, jobId: 'poster-job-1', sourcePath: fixturePng, plan: planFixture(),
  });

  assert.equal((await lstat(finalJob)).isSymbolicLink(), false);
  assert.equal(recovered.paths.root, finalJob);
  await assert.rejects(
    initializePosterJob({ outputRoot: root, jobId: 'poster-job-1', sourcePath: fixturePng, plan: planFixture() }),
    /已存在/,
  );
});

test('a symlinked poster-jobs ancestor is rejected before any package is written outside outputRoot', async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'poster-jobs-'));
  const outside = await mkdtemp(path.join(os.tmpdir(), 'poster-jobs-outside-'));
  context.after(() => Promise.all([
    rm(root, { recursive: true, force: true }), rm(outside, { recursive: true, force: true }),
  ]));
  await symlink(outside, path.join(root, 'poster-jobs'));

  await assert.rejects(
    initializePosterJob({ outputRoot: root, jobId: 'poster-job-1', sourcePath: fixturePng, plan: planFixture() }),
    /符号链接|安全/,
  );
  assert.deepEqual(await readdir(outside), []);

  const linkedOutputRoot = path.join(root, 'linked-output-root');
  await symlink(outside, linkedOutputRoot);
  await assert.rejects(
    initializePosterJob({ outputRoot: linkedOutputRoot, jobId: 'poster-job-2', sourcePath: fixturePng, plan: planFixture() }),
    /符号链接|安全/,
  );
  assert.deepEqual(await readdir(outside), []);
});

test('accepting a bound reviewed candidate atomically publishes its normalized canonical layer', async (context) => {
  const { root, record } = await reviewCandidateFixture(context);

  const accepted = await acceptPosterCandidate({
    outputRoot: root, jobId: 'poster-job-1', layerIndex: 1,
    candidateId: 'candidate-review', expectedRevision: record.manifest.revision,
  });

  const layer = accepted.manifest.layers.find((entry) => entry.layer_index === 1);
  const candidate = accepted.manifest.candidates.find((entry) => entry.candidate_id === 'candidate-review');
  assert.equal(path.basename(layer.source_output), 'layer_1_title_source.png');
  assert.equal(layer.status, 'ACCEPTED');
  assert.deepEqual(layer.final_dimensions, { width: 4, height: 2 });
  assert.equal(candidate.accepted, true);
  assert.equal(candidate.accepted_source_output, layer.source_output);
  assert.match(candidate.accepted_source_sha256, /^[a-f0-9]{64}$/u);
  assert.equal(layer.source_sha256, candidate.accepted_source_sha256);
  const output = await readPosterPng(layer.source_output);
  assert.deepEqual({ width: output.width, height: output.height, colorType: output.colorType }, {
    width: 4, height: 2, colorType: 2,
  });
});

test('hard failures and stale candidate bindings cannot be accepted', async (context) => {
  const hard = await reviewCandidateFixture(context, {
    status: 'HARD_REJECTED', failureCodes: ['TEXT_OR_LOGO_MUTATED'],
  });
  await assert.rejects(acceptPosterCandidate({
    outputRoot: hard.root, jobId: 'poster-job-1', layerIndex: 1,
    candidateId: 'candidate-review', expectedRevision: hard.record.manifest.revision,
  }), /硬失败候选不能接受/);

  const clean = await reviewCandidateFixture(context);
  await assert.rejects(acceptPosterCandidate({
    outputRoot: clean.root, jobId: 'poster-job-1', layerIndex: 1,
    candidateId: 'stale-candidate', expectedRevision: clean.record.manifest.revision,
  }), /候选.*不匹配|不匹配.*候选/);
  assert.deepEqual(await readdir(clean.record.paths.layers), []);
});

test('a passing label without an exact release-gate binding cannot be accepted', async (context) => {
  const fixture = await reviewCandidateFixture(context, { releaseGate: false });

  await assert.rejects(acceptPosterCandidate({
    outputRoot: fixture.root, jobId: 'poster-job-1', layerIndex: 1,
    candidateId: 'candidate-review', expectedRevision: fixture.record.manifest.revision,
  }), /release gate|发布检查|绑定/i);
  assert.deepEqual(await readdir(fixture.record.paths.layers), []);
});

test('acceptance rejects a reviewed candidate path whose bytes were replaced', async (context) => {
  const fixture = await reviewCandidateFixture(context);
  await keyedPng(fixture.candidatePath, { alpha: null, marker: true });

  await assert.rejects(acceptPosterCandidate({
    outputRoot: fixture.root, jobId: 'poster-job-1', layerIndex: 1,
    candidateId: 'candidate-review', expectedRevision: fixture.record.manifest.revision,
  }), /SHA-256|digest|bytes|内容/i);

  const saved = await readPosterJob(fixture.root, 'poster-job-1');
  assert.equal(saved.manifest.revision, fixture.record.manifest.revision);
  assert.equal(saved.manifest.layers[0].status, 'NEEDS_USER_REVIEW');
  assert.deepEqual(await readdir(saved.paths.layers), []);
});

test('normalization failure publishes neither accepted metadata nor a canonical layer', async (context) => {
  const fixture = await reviewCandidateFixture(context, { contaminated: true });

  await assert.rejects(acceptPosterCandidate({
    outputRoot: fixture.root, jobId: 'poster-job-1', layerIndex: 1,
    candidateId: 'candidate-review', expectedRevision: fixture.record.manifest.revision,
  }), /KEY_UNUSABLE/);

  const saved = await readPosterJob(fixture.root, 'poster-job-1');
  assert.equal(saved.manifest.revision, fixture.record.manifest.revision);
  assert.equal(saved.manifest.layers[0].status, 'NEEDS_USER_REVIEW');
  assert.deepEqual(await readdir(saved.paths.layers), []);
});

test('a failure after normalization but before publication leaves review state untouched', async (context) => {
  const fixture = await reviewCandidateFixture(context);

  await assert.rejects(acceptPosterCandidate({
    outputRoot: fixture.root, jobId: 'poster-job-1', layerIndex: 1,
    candidateId: 'candidate-review', expectedRevision: fixture.record.manifest.revision,
    hooks: { afterNormalized: () => { throw new Error('injected before metadata commit'); } },
  }), /injected before metadata commit/);

  const saved = await readPosterJob(fixture.root, 'poster-job-1');
  assert.equal(saved.manifest.revision, fixture.record.manifest.revision);
  assert.equal(saved.manifest.layers[0].status, 'NEEDS_USER_REVIEW');
  assert.deepEqual(await readdir(saved.paths.layers), []);
});

test('acceptance cleans an interrupted invocation and resumes an exact orphaned publication', async (context) => {
  const fixture = await reviewCandidateFixture(context);
  let publishedBytes;

  await assert.rejects(acceptPosterCandidate({
    outputRoot: fixture.root, jobId: 'poster-job-1', layerIndex: 1,
    candidateId: 'candidate-review', expectedRevision: fixture.record.manifest.revision,
    hooks: { afterTargetPublished: async ({ targetPath }) => {
      publishedBytes = await readFile(targetPath);
      throw new Error('injected after target publish');
    } },
  }), /injected after target publish/);
  assert.deepEqual(await readdir(fixture.record.paths.layers), []);

  const targetPath = path.join(fixture.record.paths.layers, 'layer_1_title_source.png');
  await writeFile(targetPath, publishedBytes);
  const recovered = await acceptPosterCandidate({
    outputRoot: fixture.root, jobId: 'poster-job-1', layerIndex: 1,
    candidateId: 'candidate-review', expectedRevision: fixture.record.manifest.revision,
  });

  assert.equal(recovered.manifest.layers[0].status, 'ACCEPTED');
  assert.equal(await fileSha256(targetPath), recovered.manifest.layers[0].source_sha256);
});

test('acceptance crash boundaries expose recoverable old or new state around durable canonical publication', async (context) => {
  for (const [hookName, committed] of [
    ['beforeCanonicalFileSynced', false],
    ['afterCanonicalFileSynced', false],
    ['afterCanonicalDirectorySynced', false],
    ['afterManifestParentSynced', true],
  ]) {
    const fixture = await reviewCandidateFixture(context);
    const oldRevision = fixture.record.manifest.revision;
    await assert.rejects(acceptPosterCandidate({
      outputRoot: fixture.root, jobId: 'poster-job-1', layerIndex: 1,
      candidateId: 'candidate-review', expectedRevision: oldRevision,
      hooks: { [hookName]: () => {
        throw Object.assign(new Error(`crash at ${hookName}`), { code: 'SIMULATED_PROCESS_DEATH' });
      } },
    }), new RegExp(hookName));

    const interrupted = await readPosterJob(fixture.root, 'poster-job-1');
    assert.equal(interrupted.manifest.revision, oldRevision + (committed ? 1 : 0), hookName);
    assert.equal(interrupted.manifest.layers[0].status, committed ? 'ACCEPTED' : 'NEEDS_USER_REVIEW', hookName);
    const canonicalPath = path.join(interrupted.paths.layers, 'layer_1_title_source.png');
    assert.equal((await stat(canonicalPath)).isFile(), true, hookName);

    const recovered = await acceptPosterCandidate({
      outputRoot: fixture.root, jobId: 'poster-job-1', layerIndex: 1,
      candidateId: 'candidate-review', expectedRevision: oldRevision,
    });
    assert.equal(recovered.manifest.revision, oldRevision + 1, hookName);
    assert.equal(recovered.manifest.layers[0].status, 'ACCEPTED', hookName);
    assert.equal(await fileSha256(canonicalPath), recovered.manifest.layers[0].source_sha256, hookName);
  }
});

test('acceptance durability ordering syncs canonical inode and layers before manifest publication', async (context) => {
  const fixture = await reviewCandidateFixture(context);
  const events = [];
  await acceptPosterCandidate({
    outputRoot: fixture.root, jobId: 'poster-job-1', layerIndex: 1,
    candidateId: 'candidate-review', expectedRevision: fixture.record.manifest.revision,
    hooks: {
      beforeCanonicalFileSynced: () => events.push('canonical-file:before'),
      afterCanonicalFileSynced: () => events.push('canonical-file:after'),
      syncLayersDirectory: async (directoryPath) => {
        events.push(`sync:${path.basename(directoryPath)}`);
        const handle = await open(directoryPath, fsConstants.O_RDONLY | (fsConstants.O_DIRECTORY || 0));
        try { await handle.sync(); } finally { await handle.close(); }
      },
      afterCanonicalDirectorySynced: () => events.push('canonical-directory:after'),
      afterManifestTemporarySynced: () => events.push('manifest-temp:after'),
      afterManifestRenamed: () => events.push('manifest-rename:after'),
      syncManifestDirectory: async (directoryPath) => {
        events.push(`sync:${path.basename(directoryPath)}`);
        const handle = await open(directoryPath, fsConstants.O_RDONLY | (fsConstants.O_DIRECTORY || 0));
        try { await handle.sync(); } finally { await handle.close(); }
      },
      afterManifestParentSynced: () => events.push('manifest-parent:after'),
    },
  });
  assert.deepEqual(events, [
    'canonical-file:before',
    'canonical-file:after',
    'sync:layers',
    'canonical-directory:after',
    'manifest-temp:after',
    'manifest-rename:after',
    `sync:${path.basename(fixture.record.paths.root)}`,
    'manifest-parent:after',
  ]);
});

test('acceptance rollback unlinks an invocation-created canonical and syncs layers', async (context) => {
  const fixture = await reviewCandidateFixture(context);
  let rollbackSynced = false;
  await assert.rejects(acceptPosterCandidate({
    outputRoot: fixture.root, jobId: 'poster-job-1', layerIndex: 1,
    candidateId: 'candidate-review', expectedRevision: fixture.record.manifest.revision,
    hooks: {
      afterCanonicalDirectorySynced: () => { throw new Error('ordinary pre-manifest failure'); },
      afterCanonicalRollbackDirectorySynced: () => { rollbackSynced = true; },
    },
  }), /ordinary pre-manifest failure/);
  assert.equal(rollbackSynced, true);
  assert.deepEqual(await readdir(fixture.record.paths.layers), []);
  assert.equal((await readPosterJob(fixture.root, 'poster-job-1')).manifest.revision,
    fixture.record.manifest.revision);
});

test('store audit records an exact current binding without advancing the manifest revision', async (context) => {
  const fixture = await acceptedAuditFixture(context);

  const audited = await runPosterRecompositionAudit({
    outputRoot: fixture.root,
    jobId: 'poster-job-1',
    expectedRevision: fixture.record.manifest.revision,
  });

  assert.equal(audited.report.recomposition_audit.status, 'passed');
  assert.equal(audited.report.recomposition_audit.binding.manifest_revision, 2);
  assert.equal(audited.manifest.revision, 2);
  assert.deepEqual(audited.report.recomposition_audit.composite_order, [2, 1]);
  assert.equal(path.basename(path.dirname(audited.report.recomposition_audit.preview_path)), 'audit');
  assert.notEqual(path.dirname(audited.report.recomposition_audit.preview_path), audited.paths.layers);
});

test('export archive contains only canonical package files and accepted full-canvas layers', async (context) => {
  const fixture = await acceptedAuditFixture(context);
  await runPosterRecompositionAudit({
    outputRoot: fixture.root, jobId: 'poster-job-1', expectedRevision: 2,
  });

  const archive = await createPosterExportArchive({
    outputRoot: fixture.root, jobId: 'poster-job-1',
  });
  const files = Object.keys(unzipSync(archive.bytes)).sort();

  assert.equal(archive.fileName, 'poster-job-1-poster-layers.zip');
  assert.deepEqual(files, [
    'layer_manifest.json',
    'layers/layer_1_source.png',
    'layers/layer_2_source.png',
    'poster-execution-report.json',
    'poster-layer-plan.json',
    'source.png',
  ]);
  assert.equal(files.some((name) => name.includes('candidate') || name.includes('preview')), false);
});

test('failed audit preserves accepted layers and blocks archive export', async (context) => {
  const fixture = await acceptedAuditFixture(context, { duplicateOwnership: true });

  const audited = await runPosterRecompositionAudit({
    outputRoot: fixture.root, jobId: 'poster-job-1', expectedRevision: 2,
  });

  assert.equal(audited.report.recomposition_audit.status, 'failed');
  assert.deepEqual(audited.report.recomposition_audit.conflict_layers, [1, 2]);
  assert.equal((await readdir(audited.paths.layers)).length, 2);
  await assert.rejects(
    createPosterExportArchive({ outputRoot: fixture.root, jobId: 'poster-job-1' }),
    /审计|导出/,
  );
});

test('a later manifest mutation invalidates a previously passed audit', async (context) => {
  const fixture = await acceptedAuditFixture(context);
  const audited = await runPosterRecompositionAudit({
    outputRoot: fixture.root, jobId: 'poster-job-1', expectedRevision: 2,
  });
  await mutatePosterJob(fixture.root, 'poster-job-1', 2, (current) => ({
    ...current,
    manifest: {
      ...current.manifest,
      layers: current.manifest.layers.map((layer) => layer.layer_index === 1
        ? { ...layer, review_note: 'changed after audit' }
        : layer),
    },
  }));

  assert.equal(audited.report.recomposition_audit.status, 'passed');
  await assert.rejects(
    createPosterExportArchive({ outputRoot: fixture.root, jobId: 'poster-job-1' }),
    /审计|版本|导出/,
  );
});

test('failed audit can reauthorize only an implicated accepted layer while preserving immutable history', async (context) => {
  const fixture = await acceptedAuditFixture(context, { duplicateOwnership: true });
  const audited = await runPosterRecompositionAudit({
    outputRoot: fixture.root, jobId: 'poster-job-1', expectedRevision: 2,
  });
  const previous = audited.manifest.layers.find((layer) => layer.layer_index === 1);
  const previousBytes = await readFile(previous.source_output);

  const remediated = await reauthorizePosterAuditLayer({
    outputRoot: fixture.root, jobId: 'poster-job-1', layerIndex: 1, expectedRevision: 2,
  });

  const selected = remediated.manifest.layers.find((layer) => layer.layer_index === 1);
  const untouched = remediated.manifest.layers.find((layer) => layer.layer_index === 2);
  const superseded = remediated.manifest.candidates.find((candidate) => candidate.candidate_id === 'candidate-1');
  assert.equal(remediated.manifest.revision, 3);
  assert.equal(selected.status, 'RETRY_AUTHORIZED');
  assert.equal(selected.authorization_plan_version, 3);
  assert.match(selected.retry_authorization_id, /^audit-remediation:/);
  assert.equal(selected.authorization_consumed, false);
  assert.equal(selected.accepted_candidate_id, null);
  assert.equal(selected.source_output, null);
  assert.equal(selected.source_sha256, null);
  assert.equal(untouched.status, 'ACCEPTED');
  assert.equal(superseded.superseded, true);
  assert.equal(superseded.accepted, true);
  assert.equal(selected.superseded_acceptances.length, 1);
  const history = selected.superseded_acceptances[0];
  assert.equal(history.candidate_id, 'candidate-1');
  assert.equal(history.source_sha256, previous.source_sha256);
  assert.deepEqual(await readFile(history.canonical_history_path), previousBytes);
  assert.equal(JSON.parse(await readFile(history.metadata_history_path, 'utf8')).candidate.candidate_id, 'candidate-1');
  await assert.rejects(lstat(previous.source_output), { code: 'ENOENT' });
  assert.equal((await readdir(remediated.paths.root)).some((name) => name.includes('foreground-dispatch')), false);
});

test('audit remediation rolls back history publication and leaves accepted bytes on a precommit failure', async (context) => {
  const fixture = await acceptedAuditFixture(context, { duplicateOwnership: true });
  const audited = await runPosterRecompositionAudit({
    outputRoot: fixture.root, jobId: 'poster-job-1', expectedRevision: 2,
  });
  const previous = audited.manifest.layers[0];
  const previousBytes = await readFile(previous.source_output);

  await assert.rejects(reauthorizePosterAuditLayer({
    outputRoot: fixture.root, jobId: 'poster-job-1', layerIndex: 1, expectedRevision: 2,
    hooks: { afterHistoryPublished: () => { throw new Error('injected remediation failure'); } },
  }), /injected remediation failure/);

  const saved = await readPosterJob(fixture.root, 'poster-job-1');
  assert.equal(saved.manifest.revision, 2);
  assert.equal(saved.manifest.layers[0].status, 'ACCEPTED');
  assert.deepEqual(await readFile(previous.source_output), previousBytes);
  const historyRoot = path.join(saved.paths.evidence, 'history');
  assert.deepEqual(await readdir(historyRoot).catch((error) => error.code === 'ENOENT' ? [] : Promise.reject(error)), []);
});

test('audit remediation recovers idempotently after process death between durable rename and metadata commit', async (context) => {
  const fixture = await acceptedAuditFixture(context, { duplicateOwnership: true });
  const audited = await runPosterRecompositionAudit({
    outputRoot: fixture.root, jobId: 'poster-job-1', expectedRevision: 2,
  });
  const previous = audited.manifest.layers[0];
  const previousBytes = await readFile(previous.source_output);
  const simulatedDeath = Object.assign(new Error('simulated process death'), {
    code: 'SIMULATED_PROCESS_DEATH',
  });

  await assert.rejects(reauthorizePosterAuditLayer({
    outputRoot: fixture.root, jobId: 'poster-job-1', layerIndex: 1, expectedRevision: 2,
    hooks: { afterCanonicalRelocated: () => { throw simulatedDeath; } },
  }), /simulated process death/);

  const interrupted = await readPosterJob(fixture.root, 'poster-job-1');
  assert.equal(interrupted.manifest.revision, 2);
  assert.equal(interrupted.manifest.layers[0].status, 'ACCEPTED');
  await assert.rejects(lstat(previous.source_output), { code: 'ENOENT' });
  const historyRoot = path.join(interrupted.paths.evidence, 'history');
  const historyPng = (await readdir(historyRoot)).find((name) => name.endsWith('.png'));
  assert.deepEqual(await readFile(path.join(historyRoot, historyPng)), previousBytes);

  let canonicalAbsentAtCommit = false;
  const recovered = await reauthorizePosterAuditLayer({
    outputRoot: fixture.root, jobId: 'poster-job-1', layerIndex: 1, expectedRevision: 2,
    hooks: { afterMetadataCommitted: async () => {
      canonicalAbsentAtCommit = await lstat(previous.source_output)
        .then(() => false, (error) => error.code === 'ENOENT');
    } },
  });

  assert.equal(canonicalAbsentAtCommit, true);
  assert.equal(recovered.manifest.revision, 3);
  assert.equal(recovered.manifest.layers[0].status, 'RETRY_AUTHORIZED');
  assert.deepEqual(await readFile(recovered.manifest.layers[0].superseded_acceptances[0].canonical_history_path), previousBytes);
  await assert.rejects(lstat(previous.source_output), { code: 'ENOENT' });
});

test('audit remediation recovers every abrupt crash boundary in its durability protocol', async (context) => {
  for (const hookName of [
    'afterHistoryMetadataFileSynced',
    'afterHistoryParentSynced',
    'afterCanonicalRenamed',
    'afterDestinationDirectorySynced',
    'afterSourceDirectorySynced',
  ]) {
    const fixture = await acceptedAuditFixture(context, { duplicateOwnership: true });
    const audited = await runPosterRecompositionAudit({
      outputRoot: fixture.root, jobId: 'poster-job-1', expectedRevision: 2,
    });
    const previous = audited.manifest.layers[0];
    const previousBytes = await readFile(previous.source_output);

    await assert.rejects(reauthorizePosterAuditLayer({
      outputRoot: fixture.root, jobId: 'poster-job-1', layerIndex: 1, expectedRevision: 2,
      hooks: { [hookName]: () => {
        throw Object.assign(new Error(`crash at ${hookName}`), { code: 'SIMULATED_PROCESS_DEATH' });
      } },
    }), new RegExp(hookName));

    const recovered = await reauthorizePosterAuditLayer({
      outputRoot: fixture.root, jobId: 'poster-job-1', layerIndex: 1, expectedRevision: 2,
    });
    const history = recovered.manifest.layers[0].superseded_acceptances[0];
    assert.equal(recovered.manifest.revision, 3, hookName);
    assert.equal(recovered.manifest.layers[0].status, 'RETRY_AUTHORIZED', hookName);
    assert.deepEqual(await readFile(history.canonical_history_path), previousBytes, hookName);
    await assert.rejects(lstat(previous.source_output), { code: 'ENOENT' });
  }
});

test('audit remediation exposes only old or new complete JSON across manifest publication crashes', async (context) => {
  for (const [hookName, visibleRevision] of [
    ['afterManifestTemporarySynced', 2],
    ['afterManifestRenamed', 3],
  ]) {
    const fixture = await acceptedAuditFixture(context, { duplicateOwnership: true });
    const audited = await runPosterRecompositionAudit({
      outputRoot: fixture.root, jobId: 'poster-job-1', expectedRevision: 2,
    });
    const previous = audited.manifest.layers[0];
    const planIdentity = await lstat(audited.paths.plan);
    let observedRevision = null;

    await assert.rejects(reauthorizePosterAuditLayer({
      outputRoot: fixture.root, jobId: 'poster-job-1', layerIndex: 1, expectedRevision: 2,
      hooks: { [hookName]: async () => {
        const visible = await readPosterJob(fixture.root, 'poster-job-1');
        observedRevision = visible.manifest.revision;
        const visiblePlanIdentity = await lstat(visible.paths.plan);
        assert.equal(visiblePlanIdentity.dev, planIdentity.dev);
        assert.equal(visiblePlanIdentity.ino, planIdentity.ino);
        assert.equal(JSON.parse(await readFile(visible.paths.manifest, 'utf8')).revision, visibleRevision);
        throw Object.assign(new Error(`crash at ${hookName}`), { code: 'SIMULATED_PROCESS_DEATH' });
      } },
    }), new RegExp(hookName));

    assert.equal(observedRevision, visibleRevision, hookName);
    const interrupted = await readPosterJob(fixture.root, 'poster-job-1');
    assert.equal(interrupted.manifest.revision, visibleRevision, hookName);
    assert.equal(JSON.parse(await readFile(interrupted.paths.manifest, 'utf8')).revision, visibleRevision);
    if (visibleRevision === 2) await assert.rejects(lstat(previous.source_output), { code: 'ENOENT' });

    const recovered = await reauthorizePosterAuditLayer({
      outputRoot: fixture.root, jobId: 'poster-job-1', layerIndex: 1, expectedRevision: 2,
    });
    assert.equal(recovered.manifest.revision, 3, hookName);
    assert.equal(recovered.manifest.layers[0].status, 'RETRY_AUTHORIZED', hookName);
  }
});

test('audit remediation rolls back before manifest rename and replays after parent-sync failure', async (context) => {
  const beforeFixture = await acceptedAuditFixture(context, { duplicateOwnership: true });
  const beforeAudit = await runPosterRecompositionAudit({
    outputRoot: beforeFixture.root, jobId: 'poster-job-1', expectedRevision: 2,
  });
  const beforeCanonical = beforeAudit.manifest.layers[0].source_output;
  const beforeBytes = await readFile(beforeCanonical);
  await assert.rejects(reauthorizePosterAuditLayer({
    outputRoot: beforeFixture.root, jobId: 'poster-job-1', layerIndex: 1, expectedRevision: 2,
    hooks: { afterManifestTemporarySynced: () => { throw new Error('pre-rename manifest sync failure'); } },
  }), /pre-rename manifest sync failure/);
  const rolledBack = await readPosterJob(beforeFixture.root, 'poster-job-1');
  assert.equal(rolledBack.manifest.revision, 2);
  assert.deepEqual(await readFile(beforeCanonical), beforeBytes);
  assert.deepEqual((await readdir(rolledBack.paths.root)).filter(
    (name) => name.startsWith('.layer_manifest.json.') && name.endsWith('.tmp'),
  ), []);
  assert.equal((await reauthorizePosterAuditLayer({
    outputRoot: beforeFixture.root, jobId: 'poster-job-1', layerIndex: 1, expectedRevision: 2,
  })).manifest.revision, 3);

  const afterFixture = await acceptedAuditFixture(context, { duplicateOwnership: true });
  await runPosterRecompositionAudit({
    outputRoot: afterFixture.root, jobId: 'poster-job-1', expectedRevision: 2,
  });
  await assert.rejects(reauthorizePosterAuditLayer({
    outputRoot: afterFixture.root, jobId: 'poster-job-1', layerIndex: 1, expectedRevision: 2,
    hooks: { syncManifestDirectory: () => { throw new Error('manifest parent sync failure'); } },
  }), /manifest parent sync failure/);
  const published = await readPosterJob(afterFixture.root, 'poster-job-1');
  assert.equal(published.manifest.revision, 3);
  assert.equal(published.manifest.layers[0].status, 'RETRY_AUTHORIZED');
  const replayed = await reauthorizePosterAuditLayer({
    outputRoot: afterFixture.root, jobId: 'poster-job-1', layerIndex: 1, expectedRevision: 2,
  });
  assert.equal(replayed.manifest.revision, 3);
});

test('manifest temp cleanup never removes a replacement path it no longer owns', async (context) => {
  const fixture = await acceptedAuditFixture(context, { duplicateOwnership: true });
  await runPosterRecompositionAudit({
    outputRoot: fixture.root, jobId: 'poster-job-1', expectedRevision: 2,
  });
  let replacedTemporary;

  await assert.rejects(reauthorizePosterAuditLayer({
    outputRoot: fixture.root, jobId: 'poster-job-1', layerIndex: 1, expectedRevision: 2,
    hooks: { afterManifestTemporarySynced: async ({ temporaryPath }) => {
      replacedTemporary = temporaryPath;
      await rename(temporaryPath, `${temporaryPath}.owned-original`);
      await writeFile(temporaryPath, 'replacement sentinel');
      throw new Error('replacement temp failure');
    } },
  }), /replacement temp failure/);

  assert.equal(await readFile(replacedTemporary, 'utf8'), 'replacement sentinel');
  assert.equal((await readPosterJob(fixture.root, 'poster-job-1')).manifest.revision, 2);
});

test('audit remediation syncs history metadata and rename destination before the source directory', async (context) => {
  const fixture = await acceptedAuditFixture(context, { duplicateOwnership: true });
  await runPosterRecompositionAudit({
    outputRoot: fixture.root, jobId: 'poster-job-1', expectedRevision: 2,
  });
  const events = [];

  await reauthorizePosterAuditLayer({
    outputRoot: fixture.root, jobId: 'poster-job-1', layerIndex: 1, expectedRevision: 2,
    hooks: {
      syncDirectory: async (directoryPath) => {
        events.push(`sync:${path.basename(directoryPath)}`);
        const handle = await open(directoryPath, fsConstants.O_RDONLY | (fsConstants.O_DIRECTORY || 0));
        try { await handle.sync(); } finally { await handle.close(); }
      },
      afterHistoryMetadataFileSynced: () => events.push('metadata-file-synced'),
      afterHistoryParentSynced: () => events.push('metadata-parent-synced'),
      afterCanonicalRenamed: () => events.push('canonical-renamed'),
      afterDestinationDirectorySynced: () => events.push('destination-synced'),
      afterSourceDirectorySynced: () => events.push('source-synced'),
    },
  });

  assert.deepEqual(events, [
    'metadata-file-synced',
    'sync:history',
    'metadata-parent-synced',
    'canonical-renamed',
    'sync:history',
    'destination-synced',
    'sync:layers',
    'source-synced',
  ]);
});

test('audit remediation recovers an exact dual-visible source and history state', async (context) => {
  const fixture = await acceptedAuditFixture(context, { duplicateOwnership: true });
  const audited = await runPosterRecompositionAudit({
    outputRoot: fixture.root, jobId: 'poster-job-1', expectedRevision: 2,
  });
  const previous = audited.manifest.layers[0];
  const previousBytes = await readFile(previous.source_output);

  await assert.rejects(reauthorizePosterAuditLayer({
    outputRoot: fixture.root, jobId: 'poster-job-1', layerIndex: 1, expectedRevision: 2,
    hooks: { afterHistoryParentSynced: async ({ canonicalPath, canonicalHistoryPath }) => {
      await link(canonicalPath, canonicalHistoryPath);
      throw Object.assign(new Error('dual-visible crash'), { code: 'SIMULATED_PROCESS_DEATH' });
    } },
  }), /dual-visible crash/);

  assert.deepEqual(await readFile(previous.source_output), previousBytes);
  const recovered = await reauthorizePosterAuditLayer({
    outputRoot: fixture.root, jobId: 'poster-job-1', layerIndex: 1, expectedRevision: 2,
  });
  assert.equal(recovered.manifest.revision, 3);
  await assert.rejects(lstat(previous.source_output), { code: 'ENOENT' });
  assert.deepEqual(await readFile(recovered.manifest.layers[0].superseded_acceptances[0].canonical_history_path), previousBytes);
});

test('audit remediation rejects a divergent dual-visible recovery state', async (context) => {
  const fixture = await acceptedAuditFixture(context, { duplicateOwnership: true });
  const audited = await runPosterRecompositionAudit({
    outputRoot: fixture.root, jobId: 'poster-job-1', expectedRevision: 2,
  });

  await assert.rejects(reauthorizePosterAuditLayer({
    outputRoot: fixture.root, jobId: 'poster-job-1', layerIndex: 1, expectedRevision: 2,
    hooks: { afterHistoryParentSynced: async ({ canonicalHistoryPath }) => {
      await writeFile(canonicalHistoryPath, Buffer.from('divergent history bytes'));
      throw Object.assign(new Error('divergent dual crash'), { code: 'SIMULATED_PROCESS_DEATH' });
    } },
  }), /divergent dual crash/);

  await assert.rejects(reauthorizePosterAuditLayer({
    outputRoot: fixture.root, jobId: 'poster-job-1', layerIndex: 1, expectedRevision: 2,
  }), /SHA-256|不一致|状态/);
  assert.equal((await readPosterJob(fixture.root, 'poster-job-1')).manifest.revision, 2);
});

test('audit remediation replays committed retry metadata after response loss', async (context) => {
  const fixture = await acceptedAuditFixture(context, { duplicateOwnership: true });
  await runPosterRecompositionAudit({
    outputRoot: fixture.root, jobId: 'poster-job-1', expectedRevision: 2,
  });

  await assert.rejects(reauthorizePosterAuditLayer({
    outputRoot: fixture.root, jobId: 'poster-job-1', layerIndex: 1, expectedRevision: 2,
    hooks: { afterMetadataCommitted: () => {
      throw Object.assign(new Error('lost committed response'), { code: 'SIMULATED_PROCESS_DEATH' });
    } },
  }), /lost committed response/);

  const replay = await reauthorizePosterAuditLayer({
    outputRoot: fixture.root, jobId: 'poster-job-1', layerIndex: 1, expectedRevision: 2,
  });
  assert.equal(replay.manifest.revision, 3);
  assert.equal(replay.manifest.layers[0].status, 'RETRY_AUTHORIZED');
  assert.equal(replay.manifest.layers[1].status, 'ACCEPTED');
});

test('audit remediation also resumes an exact metadata preparation left before canonical rename', async (context) => {
  const fixture = await acceptedAuditFixture(context, { duplicateOwnership: true });
  const audited = await runPosterRecompositionAudit({
    outputRoot: fixture.root, jobId: 'poster-job-1', expectedRevision: 2,
  });
  const previous = audited.manifest.layers[0];
  const previousBytes = await readFile(previous.source_output);

  await assert.rejects(reauthorizePosterAuditLayer({
    outputRoot: fixture.root, jobId: 'poster-job-1', layerIndex: 1, expectedRevision: 2,
    hooks: { afterHistoryPublished: () => {
      throw Object.assign(new Error('simulated preparation death'), { code: 'SIMULATED_PROCESS_DEATH' });
    } },
  }), /simulated preparation death/);
  assert.deepEqual(await readFile(previous.source_output), previousBytes);

  const recovered = await reauthorizePosterAuditLayer({
    outputRoot: fixture.root, jobId: 'poster-job-1', layerIndex: 1, expectedRevision: 2,
  });
  assert.equal(recovered.manifest.revision, 3);
  assert.equal(recovered.manifest.layers[0].status, 'RETRY_AUTHORIZED');
  await assert.rejects(lstat(previous.source_output), { code: 'ENOENT' });
});

test('audit remediation restores the accepted canonical when durable directory sync fails', async (context) => {
  const fixture = await acceptedAuditFixture(context, { duplicateOwnership: true });
  const audited = await runPosterRecompositionAudit({
    outputRoot: fixture.root, jobId: 'poster-job-1', expectedRevision: 2,
  });
  const previous = audited.manifest.layers[0];
  const previousBytes = await readFile(previous.source_output);

  await assert.rejects(reauthorizePosterAuditLayer({
    outputRoot: fixture.root, jobId: 'poster-job-1', layerIndex: 1, expectedRevision: 2,
    hooks: { syncDirectory: () => { throw new Error('injected directory fsync failure'); } },
  }), /injected directory fsync failure/);

  const saved = await readPosterJob(fixture.root, 'poster-job-1');
  assert.equal(saved.manifest.revision, 2);
  assert.equal(saved.manifest.layers[0].status, 'ACCEPTED');
  assert.deepEqual(await readFile(previous.source_output), previousBytes);
  assert.deepEqual(await readdir(path.join(saved.paths.evidence, 'history')), []);
});

test('audit remediation restores the accepted canonical on an ordinary post-rename precommit error', async (context) => {
  const fixture = await acceptedAuditFixture(context, { duplicateOwnership: true });
  const audited = await runPosterRecompositionAudit({
    outputRoot: fixture.root, jobId: 'poster-job-1', expectedRevision: 2,
  });
  const previous = audited.manifest.layers[0];
  const previousBytes = await readFile(previous.source_output);

  await assert.rejects(reauthorizePosterAuditLayer({
    outputRoot: fixture.root, jobId: 'poster-job-1', layerIndex: 1, expectedRevision: 2,
    hooks: { afterCanonicalRelocated: () => { throw new Error('injected precommit failure'); } },
  }), /injected precommit failure/);

  const saved = await readPosterJob(fixture.root, 'poster-job-1');
  assert.equal(saved.manifest.revision, 2);
  assert.equal(saved.manifest.layers[0].status, 'ACCEPTED');
  assert.deepEqual(await readFile(previous.source_output), previousBytes);
  assert.deepEqual(await readdir(path.join(saved.paths.evidence, 'history')), []);
});

test('audit remediation rejects a layer that was not implicated by the current failed audit', async (context) => {
  const fixture = await acceptedAuditFixture(context);
  await runPosterRecompositionAudit({
    outputRoot: fixture.root, jobId: 'poster-job-1', expectedRevision: 2,
  });

  await assert.rejects(reauthorizePosterAuditLayer({
    outputRoot: fixture.root, jobId: 'poster-job-1', layerIndex: 1, expectedRevision: 2,
  }), /失败审计|冲突图层|remediation/i);
});

test('export archives bytes from the same no-follow descriptor used for digest validation', async (context) => {
  const fixture = await acceptedAuditFixture(context);
  const audited = await runPosterRecompositionAudit({
    outputRoot: fixture.root, jobId: 'poster-job-1', expectedRevision: 2,
  });
  const first = audited.manifest.layers.find((layer) => layer.layer_index === 1);
  const second = audited.manifest.layers.find((layer) => layer.layer_index === 2);
  const acceptedBytes = await readFile(first.source_output);
  let replaced = false;

  const archive = await createPosterExportArchive({
    outputRoot: fixture.root, jobId: 'poster-job-1',
    hooks: { afterCanonicalOpened: async ({ targetPath }) => {
      if (targetPath !== first.source_output || replaced) return;
      replaced = true;
      await rename(targetPath, `${targetPath}.accepted-backup`);
      await copyFile(second.source_output, targetPath);
    } },
  });

  assert.equal(replaced, true);
  const files = unzipSync(archive.bytes);
  assert.deepEqual(Buffer.from(files['layers/layer_1_source.png']), acceptedBytes);
  assert.equal(createHash('sha256').update(files['layers/layer_1_source.png']).digest('hex'), first.source_sha256);
});

test('export rejects a symlinked canonical layer through O_NOFOLLOW', async (context) => {
  const fixture = await acceptedAuditFixture(context);
  const audited = await runPosterRecompositionAudit({
    outputRoot: fixture.root, jobId: 'poster-job-1', expectedRevision: 2,
  });
  const first = audited.manifest.layers.find((layer) => layer.layer_index === 1);
  const second = audited.manifest.layers.find((layer) => layer.layer_index === 2);
  await unlink(first.source_output);
  await symlink(second.source_output, first.source_output);

  await assert.rejects(
    createPosterExportArchive({ outputRoot: fixture.root, jobId: 'poster-job-1' }),
    /符号链接|no.?follow|安全|正式图层/i,
  );
});

test('export rechecks the exact raw candidate bytes audited for the accepted lineage', async (context) => {
  const fixture = await acceptedAuditFixture(context);
  const audited = await runPosterRecompositionAudit({
    outputRoot: fixture.root, jobId: 'poster-job-1', expectedRevision: 2,
  });
  const candidate = audited.manifest.candidates.find((entry) => entry.candidate_id === 'candidate-1');
  await writeFile(candidate.path, Buffer.from('replaced raw candidate'));

  await assert.rejects(
    createPosterExportArchive({ outputRoot: fixture.root, jobId: 'poster-job-1' }),
    /候选.*SHA-256|SHA-256.*候选|内容.*预期/i,
  );
});

test('export rejects exact outside candidate bytes after an injected candidates ancestor swap', async (context) => {
  const fixture = await acceptedAuditFixture(context);
  await runPosterRecompositionAudit({
    outputRoot: fixture.root, jobId: 'poster-job-1', expectedRevision: 2,
  });
  let swapped = false;

  await assert.rejects(createPosterExportArchive({
    outputRoot: fixture.root, jobId: 'poster-job-1',
    hooks: { afterCandidateDirectoryValidated: async ({ candidatesRoot, candidatePath }) => {
      if (swapped) return;
      swapped = true;
      const held = `${candidatesRoot}.held`;
      const outside = `${candidatesRoot}.outside`;
      const bytes = await readFile(candidatePath);
      await rename(candidatesRoot, held);
      await mkdir(outside);
      await writeFile(path.join(outside, path.basename(candidatePath)), bytes);
      await symlink(outside, candidatesRoot, 'dir');
    } },
  }), /候选|目录|安全|超出|变化/);
  assert.equal(swapped, true);
});

test('acceptance fails closed without replacing a divergent pre-existing canonical target', async (context) => {
  const fixture = await reviewCandidateFixture(context);
  const targetPath = path.join(fixture.record.paths.layers, 'layer_1_title_source.png');
  await keyedPng(targetPath, { alpha: null, marker: true });
  const divergentDigest = await fileSha256(targetPath);

  await assert.rejects(acceptPosterCandidate({
    outputRoot: fixture.root, jobId: 'poster-job-1', layerIndex: 1,
    candidateId: 'candidate-review', expectedRevision: fixture.record.manifest.revision,
  }), /canonical|正式图层|SHA-256|内容/i);

  assert.equal(await fileSha256(targetPath), divergentDigest);
  const saved = await readPosterJob(fixture.root, 'poster-job-1');
  assert.equal(saved.manifest.revision, fixture.record.manifest.revision);
  assert.equal(saved.manifest.layers[0].status, 'NEEDS_USER_REVIEW');
});

test('a post-commit failure never deletes the accepted layer and a stale replay is idempotent', async (context) => {
  const fixture = await reviewCandidateFixture(context);
  const request = {
    outputRoot: fixture.root, jobId: 'poster-job-1', layerIndex: 1,
    candidateId: 'candidate-review', expectedRevision: fixture.record.manifest.revision,
  };

  await assert.rejects(acceptPosterCandidate({
    ...request,
    hooks: { afterMetadataCommitted: () => { throw new Error('injected after metadata commit'); } },
  }), /injected after metadata commit/);

  const committed = await readPosterJob(fixture.root, 'poster-job-1');
  const targetPath = committed.manifest.layers[0].source_output;
  assert.equal(committed.manifest.layers[0].status, 'ACCEPTED');
  assert.equal((await stat(targetPath)).isFile(), true);
  const acceptedDigest = await fileSha256(targetPath);

  const replayed = await acceptPosterCandidate(request);
  assert.equal(replayed.manifest.revision, committed.manifest.revision);
  assert.equal(replayed.manifest.layers[0].status, 'ACCEPTED');
  assert.equal(await fileSha256(targetPath), acceptedDigest);
});

test('an acceptance manifest parent-sync failure preserves the published canonical for replay', async (context) => {
  const fixture = await reviewCandidateFixture(context);
  const request = {
    outputRoot: fixture.root, jobId: 'poster-job-1', layerIndex: 1,
    candidateId: 'candidate-review', expectedRevision: fixture.record.manifest.revision,
  };

  await assert.rejects(acceptPosterCandidate({
    ...request,
    hooks: { syncManifestDirectory: () => { throw new Error('acceptance manifest sync failure'); } },
  }), /acceptance manifest sync failure/);

  const committed = await readPosterJob(fixture.root, 'poster-job-1');
  const targetPath = committed.manifest.layers[0].source_output;
  assert.equal(committed.manifest.layers[0].status, 'ACCEPTED');
  assert.equal((await stat(targetPath)).isFile(), true);
  const replayed = await acceptPosterCandidate(request);
  assert.equal(replayed.manifest.revision, committed.manifest.revision);
  assert.equal(replayed.manifest.layers[0].source_sha256, committed.manifest.layers[0].source_sha256);
});

test('retry is an explicit state-only authorization and never enqueues generation', async (context) => {
  const { root, record } = await reviewCandidateFixture(context);

  const retried = await authorizePosterRetry({
    outputRoot: root, jobId: 'poster-job-1', layerIndex: 1,
    expectedRevision: record.manifest.revision,
  });

  assert.equal(retried.manifest.layers[0].status, 'RETRY_AUTHORIZED');
  assert.equal(retried.manifest.layers[0].authorization_plan_version, 2);
  assert.equal(retried.manifest.layers[0].candidate_output, null);
  assert.equal(retried.manifest.candidates.length, 1);
  assert.deepEqual(retried.manifest.authorizations || [], []);
  assert.equal((await readdir(retried.paths.root)).some((name) => name.includes('foreground-dispatch')), false);
  await assert.rejects(authorizePosterRetry({
    outputRoot: root, jobId: 'poster-job-1', layerIndex: 1,
    expectedRevision: record.manifest.revision,
  }), /版本已变化/);
});

test('targeted-fast retry is allowed while the root plan remains in PLAN_REVIEW', async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'poster-fast-retry-store-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const fastBase = createFastPosterPlan({
    job_id: 'poster-fast-retry', project_id: 'project-fast-retry', image_id: 'image-fast-retry',
    source: { path: 'source.png', width: 1500, height: 3664, aspect_ratio: 1500 / 3664, target_2x: false },
    document_mode: 'poster', status: 'PLAN_REVIEW', output_directory: 'output/poster-jobs/poster-fast-retry',
    layers: suggestPosterFastLayers({ data: new Uint8ClampedArray(4), width: 1, height: 1 }),
  });
  const { plan: fastPlan } = buildFastLayerSnapshot(fastBase, 1, {}, '2026-08-22T00:00:00.000Z');
  const record = await initializePosterFastJob({ outputRoot: root, jobId: 'poster-fast-retry', sourcePath: fixturePng, plan: fastPlan });
  const rejected = await mutatePosterJob(root, 'poster-fast-retry', record.manifest.revision, (current) => ({
    ...current,
    manifest: {
      ...current.manifest,
      layers: current.manifest.layers.map((layer) => layer.layer_index === 1
        ? { ...layer, status: 'HARD_REJECTED', generation_count: 1 } : layer),
    },
  }));
  const retried = await authorizePosterRetry({
    outputRoot: root, jobId: 'poster-fast-retry', layerIndex: 1,
    expectedRevision: rejected.manifest.revision,
  });
  assert.equal(retried.plan.status, 'PLAN_REVIEW');
  assert.equal(retried.plan.planning_mode, 'targeted_fast');
  assert.equal(retried.manifest.layers[0].status, 'RETRY_AUTHORIZED');
});

test('targeted-fast postprocess retry reuses retained raw PNG and the same ImageGen authorization', async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'poster-fast-postprocess-store-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const fastBase = createFastPosterPlan({
    job_id: 'poster-fast-postprocess', project_id: 'project-fast', image_id: 'image-fast',
    source: { path: 'source.png', width: 1500, height: 3664, aspect_ratio: 1500 / 3664, target_2x: false },
    document_mode: 'poster', status: 'PLAN_REVIEW', output_directory: 'output/poster-jobs/poster-fast-postprocess',
    layers: suggestPosterFastLayers({ data: new Uint8ClampedArray(4), width: 1, height: 1 }),
  });
  const { plan } = buildFastLayerSnapshot(fastBase, 1, {}, '2026-08-22T00:00:00.000Z');
  const created = await initializePosterFastJob({ outputRoot: root, jobId: plan.job_id, sourcePath: fixturePng, plan });
  const rawPath = path.join(created.paths.evidence, 'retained-raw.png');
  await copyFile(fixturePng, rawPath);
  const failed = await mutatePosterJob(root, plan.job_id, created.manifest.revision, (record) => ({
    ...record,
    manifest: {
      ...record.manifest,
      authorizations: [{ authorization_id: 'auth-1', layer_index: 1, candidate_number: 1, plan_version: 1, consumed: true, finalized: true }],
      candidates: [{ candidate_id: 'failed-placeholder', layer_index: 1, candidate_number: 1, plan_version: 1, status: 'HARD_REJECTED' }],
      layers: record.manifest.layers.map((layer) => layer.layer_index === 1 ? {
        ...layer, status: 'HARD_REJECTED', generation_count: 1, authorization_consumed: true,
        fast_execution: {
          dispatch_id: 'dispatch-1', authorization_id: 'auth-1', status: 'failed', current_stage: 'rmbg',
          started_at: '2026-08-22T00:00:00.000Z', completed_at: '2026-08-22T00:00:10.000Z', failure_stage: 'rmbg',
          recoverability: 'postprocess_only', raw_candidate_available: true, raw_candidate_path: rawPath,
          stages: {
            imagegen: { status: 'completed', started_at: '2026-08-22T00:00:00.000Z', completed_at: '2026-08-22T00:00:05.000Z' },
            rmbg: { status: 'failed', started_at: '2026-08-22T00:00:05.000Z', completed_at: '2026-08-22T00:00:10.000Z' },
            canvas_mapping: { status: 'pending', started_at: null, completed_at: null },
            finalizing: { status: 'pending', started_at: null, completed_at: null },
            review_ready: { status: 'pending', started_at: null, completed_at: null },
          },
        },
      } : layer),
    },
  }));
  const retried = await authorizePosterFastPostprocessRetry({
    outputRoot: root, jobId: plan.job_id, layerIndex: 1, expectedRevision: failed.manifest.revision,
  });
  assert.equal(retried.manifest.layers[0].status, 'GENERATING');
  assert.equal(retried.manifest.layers[0].fast_execution.current_stage, 'rmbg');
  assert.equal(retried.manifest.authorizations[0].finalized, false);
  assert.equal(retried.manifest.candidates.length, 0);
  assert.equal(retried.manifest.execution.postprocess_retries, 1);
});


test('directory fsync tolerates only Windows unsupported directory flushing', async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'poster-directory-sync-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  for (const platform of ['win32', 'darwin', 'linux']) {
    for (const code of ['EPERM', 'EACCES', 'EIO', 'EINVAL']) {
      const failure = Object.assign(new Error(`directory sync ${code}`), { code });
      let openedHandle;
      const operation = fsyncDirectory(root, {
        platform,
        openDirectory: async (...args) => {
          openedHandle = await open(...args);
          openedHandle.sync = async () => { throw failure; };
          return openedHandle;
        },
      });
      if (platform === 'win32' && code === 'EPERM') await operation;
      else await assert.rejects(operation, (error) => error === failure);
      await assert.rejects(openedHandle.stat(), { code: 'EBADF' });
    }
  }
});

test('Windows directory sync keeps open, stat and close failures visible', async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'poster-directory-errors-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  for (const stage of ['open', 'stat', 'close']) {
    const failure = Object.assign(new Error(`${stage} denied`), { code: 'EPERM' });
    await assert.rejects(fsyncDirectory(root, {
      platform: 'win32',
      openDirectory: async (...args) => {
        if (stage === 'open') throw failure;
        const handle = await open(...args);
        if (stage === 'stat') handle.stat = async () => { throw failure; };
        if (stage === 'close') {
          const close = handle.close.bind(handle);
          handle.close = async () => { await close(); throw failure; };
          handle.sync = async () => {};
        }
        return handle;
      },
    }), (error) => error === failure);
  }
});

test('Windows directory sync rejects a regular file before unsupported flushing', async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'poster-directory-type-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'ordinary.txt');
  await writeFile(file, 'content');
  await assert.rejects(fsyncDirectory(file, {
    platform: 'win32',
    openDirectory: async (target) => {
      const handle = await open(target, fsConstants.O_RDONLY);
      handle.sync = async () => { throw Object.assign(new Error('unsupported'), { code: 'EPERM' }); };
      return handle;
    },
  }), /持久化目标必须是目录/);
});
