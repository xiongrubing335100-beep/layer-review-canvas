import { lstat, readFile, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mutatePosterJob, readPosterJob } from '../src/poster-job-store.js';
import { validatePosterPlan } from '../src/poster-plan.js';
import { assertPosterSourceDimensions } from '../src/poster-png.js';
import { assertForegroundDispatchBinding, assertForegroundDispatchPublishable, completeForegroundDispatch, finalizeForegroundDispatch, readForegroundDispatch } from '../src/foreground-dispatch.js';

function contained(root, target, label) {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(target);
  if (resolvedTarget !== resolvedRoot && !resolvedTarget.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error(`${label} escapes the poster job`);
  }
  return resolvedTarget;
}

async function regularFile(target, label) {
  const info = await lstat(target);
  if (info.isSymbolicLink() || !info.isFile()) throw new Error(`${label} must be a regular file`);
  return target;
}

async function physicallyContainedRegularFile(root, target, label) {
  const lexical = contained(root, target, label);
  await regularFile(lexical, label);
  const [physicalRoot, physicalTarget] = await Promise.all([realpath(root), realpath(lexical)]);
  if (!physicalTarget.startsWith(`${physicalRoot}${path.sep}`)) throw new Error(`${label} escapes through a symlink`);
  return lexical;
}

function assertPlanMatchesJob(plan, record) {
  const validation = validatePosterPlan(plan);
  if (!validation.valid) throw new Error(`analysis plan is invalid: ${validation.errors.map((error) => error.code).join(', ')}`);
  if (plan.job_id !== record.plan.job_id || plan.project_id !== record.plan.project_id || plan.image_id !== record.plan.image_id) {
    throw new Error('analysis plan source identity does not match this job');
  }
  if (plan.source?.path !== 'source.png' || plan.source?.width !== record.plan.source?.width
    || plan.source?.height !== record.plan.source?.height || plan.source?.aspect_ratio !== record.plan.source?.aspect_ratio) {
    throw new Error('analysis plan source identity or dimensions do not match');
  }
  if (plan.plan_version !== record.plan.plan_version) throw new Error('analysis plan version is stale');
  if (path.resolve(plan.output_directory) !== record.paths.root) throw new Error('analysis output directory is not contained by this job');
}
function planFingerprint(plan) { return createHash('sha256').update(JSON.stringify(plan)).digest('hex'); }

function same(value, other) { return JSON.stringify(value) === JSON.stringify(other); }

function publishedAnalysisPlan(submitted, record) {
  return {
    ...submitted,
    status: 'PLAN_REVIEW',
    output_directory: record.paths.root,
    source: { ...submitted.source, path: 'source.png' },
  };
}

const OWNERSHIP_LAYER_FIELDS = [
  'layer_index', 'layer_name', 'asset_role', 'layer_type', 'z_order', 'position',
  'visible_content', 'included_content', 'excluded_content', 'occludes', 'occluded_by',
  'source_evidence', 'support_components', 'ui_independence', 'repair_envelope',
  'locked_visible_anchors', 'completion_required', 'completion_regions', 'risk_level',
  'processing_mode', 'fill_color', 'compositing_mode', 'separation_reason',
];

function initialManifestLayer(layer, planVersion) {
  const ownership = Object.fromEntries(
    OWNERSHIP_LAYER_FIELDS.map((field) => [field, structuredClone(layer[field])]),
  );
  return {
    ...ownership,
    status: 'PENDING',
    authorization_plan_version: planVersion,
    authorization_consumed: false,
    generation_count: 0,
  };
}

function initialManifestLayers(plan) {
  return plan.layers.map((layer) => initialManifestLayer(layer, plan.plan_version));
}

function completeAnalysisInvariant(record, submitted) {
  return same(record.plan, publishedAnalysisPlan(submitted, record))
    && record.manifest.phase === 'PLAN_REVIEW'
    && record.manifest.analysis_preflight === undefined
    && same(record.manifest.layers, initialManifestLayers(submitted));
}

async function assertEvidencePaths(plan, record) {
  for (const layer of plan.layers) {
    for (const evidence of layer.source_evidence) {
      if (typeof evidence?.path !== 'string' || evidence.path.length === 0) {
        throw new Error('analysis plan evidence path is required');
      }
      await physicallyContainedRegularFile(record.paths.evidence, path.resolve(record.paths.root, evidence.path), 'evidence path');
    }
  }
}

export async function finalizePosterAnalysis({ outputRoot, jobId, analysisPlanPath, dispatchId, trustedInternal = false } = {}) {
  if (!dispatchId && !trustedInternal) throw new Error('dispatchId is required for routed poster finalization');
  const jobDirectory = path.join(outputRoot, 'poster-jobs', jobId);
  if (dispatchId) {
    await assertForegroundDispatchBinding(jobDirectory, { dispatchId, rootKind: 'poster', taskKind: 'poster_analysis', planVersion: (await readPosterJob(outputRoot, jobId))?.plan.plan_version });
    const dispatch = await readForegroundDispatch(jobDirectory, { dispatchId, rootKind: 'poster' });
    const existing = await readPosterJob(outputRoot, jobId);
    if (dispatch.status !== 'finalizing') await assertForegroundDispatchPublishable(jobDirectory, { dispatchId, rootKind: 'poster' });
  }
  const record = await readPosterJob(outputRoot, jobId);
  if (!record) throw new Error('poster job does not exist');
  await assertPosterSourceDimensions(record.paths.source, record.plan.source);
  const expectedCandidatePath = path.join(record.paths.evidence, 'poster-layer-plan.candidate.json');
  if (path.resolve(analysisPlanPath) !== expectedCandidatePath) throw new Error('analysis plan path must be the trusted evidence candidate path');
  const submittedPath = await physicallyContainedRegularFile(record.paths.evidence, analysisPlanPath, 'analysis plan path');
  const plan = JSON.parse(await readFile(submittedPath, 'utf8'));
  assertPlanMatchesJob(plan, record);
  await assertEvidencePaths(plan, record);
  if (dispatchId && (await readForegroundDispatch(jobDirectory, { dispatchId, rootKind: 'poster' })).status === 'finalizing'
    && completeAnalysisInvariant(record, plan)) {
    await completeForegroundDispatch(jobDirectory, { dispatchId, rootKind: 'poster' });
    return { status: 'PLAN_REVIEW', planPath: record.paths.plan, outputDirectory: record.paths.root };
  }
  const partialPlanWrite = same(record.plan, publishedAnalysisPlan(plan, record))
    && record.manifest.analysis_preflight?.plan_version === plan.plan_version
    && record.manifest.phase !== 'PLAN_REVIEW';
  if (!partialPlanWrite && (record.manifest.analysis_preflight?.plan_version !== record.plan.plan_version
    || record.manifest.analysis_preflight?.plan_fingerprint !== planFingerprint(record.plan))) {
    throw new Error('analysis preflight is missing or authoritative plan changed');
  }
  if ((record.manifest.candidates?.length || 0) > 0 || (record.manifest.authorizations?.length || 0) > 0) {
    throw new Error('analysis cannot finalize after candidate activity');
  }
  const publish = () => mutatePosterJob(outputRoot, jobId, record.manifest.revision, (current) => {
    if ((current.manifest.candidates?.length || 0) > 0 || (current.manifest.authorizations?.length || 0) > 0) {
      throw new Error('analysis cannot finalize after candidate activity');
    }
    assertPlanMatchesJob(plan, current);
    const partial = same(current.plan, publishedAnalysisPlan(plan, current))
      && current.manifest.analysis_preflight?.plan_version === plan.plan_version && current.manifest.phase !== 'PLAN_REVIEW';
    if (!partial && (current.manifest.analysis_preflight?.plan_version !== current.plan.plan_version
      || current.manifest.analysis_preflight?.plan_fingerprint !== planFingerprint(current.plan))) {
      throw new Error('authoritative plan changed after analysis preflight');
    }
    return {
      ...current,
      plan: publishedAnalysisPlan(plan, current),
      manifest: {
        ...current.manifest,
        phase: 'PLAN_REVIEW',
        layers: initialManifestLayers(plan),
        analysis_preflight: undefined,
      },
    };
  });
  const saved = dispatchId
    ? await finalizeForegroundDispatch(jobDirectory, { dispatchId, rootKind: 'poster', binding: { taskKind: 'poster_analysis', planVersion: record.plan.plan_version }, publish })
    : await publish();
  if (!completeAnalysisInvariant(saved, plan)) throw new Error('analysis plan and manifest finalization invariant failed');
  return { status: 'PLAN_REVIEW', planPath: saved.paths.plan, outputDirectory: saved.paths.root };
}

function flagValue(flag) {
  const index = process.argv.indexOf(flag);
  const value = index >= 0 ? process.argv[index + 1] : null;
  if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`);
  return value;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  finalizePosterAnalysis({
    outputRoot: process.argv.includes('--output-root') ? flagValue('--output-root') : path.resolve('output'),
    jobId: flagValue('--job-id'), analysisPlanPath: flagValue('--analysis-plan'),
    dispatchId: flagValue('--dispatch-id'),
  }).then((result) => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)).catch((error) => {
    process.stderr.write(`Poster analysis finalization failed: ${error.message}\n`); process.exitCode = 1;
  });
}
