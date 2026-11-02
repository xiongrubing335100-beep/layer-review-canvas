import { isDirectExecution } from './direct-execution.mjs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { mutatePosterJob, readPosterJob } from '../src/poster-job-store.js';
import { validatePosterPlan } from '../src/poster-plan.js';
import { canonicalJson, digestCanonicalJson } from '../src/poster-plan.js';
import { candidateFileName } from '../src/poster-candidate-state.js';
import { assertPosterSourceDimensions } from '../src/poster-png.js';
import { createPosterFastExecution } from '../src/poster-fast-execution.js';

function requiredString(value, label) {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(`${label} is required`);
  return value;
}

function positiveInteger(value, label) {
  if (!Number.isInteger(value) || value < 1) throw new TypeError(`${label} must be a positive integer`);
  return value;
}

function dispatchIdentifier(value, label = 'dispatchId') {
  if (typeof value !== 'string' || !/^[A-Za-z0-9-]+$/u.test(value)) throw new TypeError(`${label} is invalid`);
  return value;
}

function assertTrustedPlan(plan) {
  const validation = validatePosterPlan(plan);
  if (!validation.valid) throw new Error(`poster plan is invalid: ${validation.errors.map((error) => error.code).join(', ')}`);
  if (plan.task !== 'poster_layering' || plan.version !== '1.0') throw new Error('poster job kind or plan version is invalid');
}
function planFingerprint(plan) { return createHash('sha256').update(JSON.stringify(plan)).digest('hex'); }

const TARGETED_PROCESSING_CATEGORIES = new Set([
  'subject', 'text', 'brand_ui', 'decoration_prop', 'effect', 'background',
]);

function targetedCategory(value) {
  if (!TARGETED_PROCESSING_CATEGORIES.has(value)) throw new Error('targeted fast category block is invalid');
  return value;
}

async function readSuppliedSnapshot(snapshotPath, layerIndex) {
  const target = path.resolve(requiredString(snapshotPath, 'snapshotPath'));
  const entry = await lstat(target);
  if (entry.isSymbolicLink() || !entry.isFile()) throw new Error('targeted fast snapshot must be a regular JSON file');
  const bytes = await readFile(target);
  let carrier;
  try {
    carrier = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new Error('targeted fast snapshot is not valid JSON');
  }
  if (carrier === null || typeof carrier !== 'object' || Array.isArray(carrier)) {
    throw new Error('targeted fast snapshot is invalid');
  }
  const snapshot = carrier.snapshot_id === undefined
    ? carrier.layers?.find((layer) => layer?.layer_index === layerIndex)?.confirmed_snapshot
    : carrier;
  if (snapshot === null || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
    throw new Error('targeted fast snapshot carrier does not contain the selected confirmed snapshot');
  }
  return {
    snapshot,
    path: target,
    fileSha256: createHash('sha256').update(bytes).digest('hex'),
    sha256: createHash('sha256').update(canonicalJson(snapshot)).digest('hex'),
  };
}

function slugForLayer(layer) {
  return String(layer.layer_name).trim().toLocaleLowerCase().replace(/\s+/gu, '-');
}

function candidatesForLayer(manifest, layerIndex) {
  return (Array.isArray(manifest.candidates) ? manifest.candidates : [])
    .filter((candidate) => candidate?.layer_index === layerIndex);
}

function activeAuthorization(manifest, layerIndex, planVersion) {
  return (Array.isArray(manifest.authorizations) ? manifest.authorizations : [])
    .find((authorization) => authorization?.layer_index === layerIndex
      && authorization?.plan_version === planVersion && authorization?.consumed === false);
}

function manifestLayer(manifest, layerIndex) {
  const layer = (Array.isArray(manifest.layers) ? manifest.layers : []).find((entry) => entry?.layer_index === layerIndex);
  if (!layer) throw new Error(`manifest layer is missing: ${layerIndex}`);
  return layer;
}

function assertTask3Authorization(layer, planVersion) {
  if (!['GENERATION_AUTHORIZED', 'RETRY_AUTHORIZED'].includes(layer.status)) {
    throw new Error('candidate generation requires Task 3 GENERATION_AUTHORIZED or RETRY_AUTHORIZED state');
  }
  const boundVersion = layer.authorization_plan_version ?? layer.authorizationPlanVersion;
  if (boundVersion !== planVersion) throw new Error('Task 3 authorization plan version is stale');
}

function authorizationSpec(record, authorization, layer, candidateNumber) {
  const candidateId = `${record.plan.job_id}:layer-${layer.layer_index}:candidate-${String(candidateNumber).padStart(2, '0')}`;
  return {
    task_kind: 'poster_candidate',
    job_id: record.plan.job_id,
    plan_version: record.plan.plan_version,
    layer_index: layer.layer_index,
    candidate_number: candidateNumber,
    authorization_id: authorization.authorization_id,
    reservation_manifest_revision: authorization.reservation_manifest_revision,
    candidate_id: candidateId,
    plan_path: record.paths.plan,
    source_path: record.paths.source,
    candidate_path: path.join(record.paths.candidates, candidateFileName({
      layerIndex: layer.layer_index, slug: slugForLayer(layer), generationCount: candidateNumber,
    })),
    output_directory: record.paths.root,
  };
}

export async function preparePosterJob({
  outputRoot, jobId, phase, layerIndex, expectedManifestRevision, dispatchId,
  planningMode, layerSnapshot, snapshotPath, sourceFingerprint, processingCategory, categoryBlock,
} = {}) {
  requiredString(outputRoot, 'outputRoot');
  requiredString(jobId, 'jobId');
  if (dispatchId !== undefined) dispatchIdentifier(dispatchId);
  if (!['analysis', 'candidate'].includes(phase)) throw new TypeError('phase must be analysis or candidate');
  const record = await readPosterJob(outputRoot, jobId);
  if (!record) throw new Error('poster job does not exist');
  if (expectedManifestRevision !== undefined && record.manifest.revision !== expectedManifestRevision) {
    throw new Error('poster manifest revision is stale');
  }
  assertTrustedPlan(record.plan);
  await assertPosterSourceDimensions(record.paths.source, record.plan.source);

  if (phase === 'analysis') {
    if ((record.manifest.candidates?.length || 0) > 0 || (record.manifest.authorizations?.length || 0) > 0) {
      throw new Error('analysis cannot run after a candidate request exists');
    }
    const saved = await mutatePosterJob(outputRoot, jobId, expectedManifestRevision ?? record.manifest.revision, (current) => ({
      ...current, manifest: { ...current.manifest, analysis_preflight: {
        plan_version: current.plan.plan_version, plan_fingerprint: planFingerprint(current.plan),
      } },
    }));
    return {
      task_kind: 'poster_analysis', job_id: saved.plan.job_id, plan_version: saved.plan.plan_version,
      authoritative_plan_path: saved.paths.plan,
      plan_path: path.join(saved.paths.evidence, 'poster-layer-plan.candidate.json'),
      analysis_plan_path: path.join(saved.paths.evidence, 'poster-layer-plan.candidate.json'),
      source_path: saved.paths.source, output_directory: saved.paths.root,
      ...(dispatchId ? { dispatch_id: dispatchId } : {}),
    };
  }

  const targetIndex = positiveInteger(layerIndex, 'layerIndex');
  const targetedFast = planningMode === 'targeted_fast';
  if (!targetedFast && record.plan.status !== 'PLAN_CONFIRMED') throw new Error('candidate generation requires PLAN_CONFIRMED');
  if (targetedFast && record.plan.status !== 'PLAN_REVIEW') throw new Error('targeted fast candidate requires PLAN_REVIEW');
  const target = record.plan.layers.find((layer) => layer?.layer_index === targetIndex);
  if (!target) throw new Error(`authorized target layer does not exist: ${targetIndex}`);
  let fastBinding = null;
  if (targetedFast) {
    if (layerSnapshot !== undefined) throw new Error('targeted fast preflight requires snapshotPath, not layerSnapshot');
    const supplied = await readSuppliedSnapshot(snapshotPath, targetIndex);
    const snapshot = supplied.snapshot;
    const snapshotPayload = snapshot && {
      job_id: snapshot.job_id, plan_version: snapshot.plan_version, layer_index: snapshot.layer_index,
      layer: snapshot.layer, source: snapshot.source,
    };
    const category = targetedCategory(snapshot?.layer?.processing_category);
    const requestedCategory = processingCategory ?? categoryBlock;
    if (requestedCategory !== undefined && requestedCategory !== category) {
      throw new Error('targeted fast category block does not match the confirmed layer');
    }
    if (!snapshot || snapshot.snapshot_id !== target.snapshot_id
      || snapshot.snapshot_id !== digestCanonicalJson(snapshotPayload)
      || canonicalJson(snapshot) !== canonicalJson(target.confirmed_snapshot)
      || snapshot.user_confirmed !== true || canonicalJson(snapshot.source) !== canonicalJson(record.plan.source)
      || sourceFingerprint !== digestCanonicalJson(record.plan.source)) {
      throw new Error('targeted fast snapshot binding is invalid');
    }
    fastBinding = { ...supplied, snapshot, category };
  }
  assertTask3Authorization(manifestLayer(record.manifest, targetIndex), record.plan.plan_version);
  if (activeAuthorization(record.manifest, targetIndex, record.plan.plan_version)) {
    throw new Error('candidate generation authorization is already pending');
  }
  const candidateNumber = candidatesForLayer(record.manifest, targetIndex).length + 1;
  const authorizationId = `${record.plan.job_id}:${record.plan.plan_version}:${targetIndex}:${candidateNumber}`;
  const saved = await mutatePosterJob(outputRoot, jobId, expectedManifestRevision ?? record.manifest.revision, (current) => {
    assertTrustedPlan(current.plan);
    if ((!targetedFast && current.plan.status !== 'PLAN_CONFIRMED')
      || (targetedFast && current.plan.status !== 'PLAN_REVIEW')
      || current.plan.plan_version !== record.plan.plan_version) {
      throw new Error('candidate plan version is no longer current');
    }
    if (activeAuthorization(current.manifest, targetIndex, current.plan.plan_version)) {
      throw new Error('candidate generation authorization is already pending');
    }
    const currentTarget = current.plan.layers.find((layer) => layer?.layer_index === targetIndex);
    if (!currentTarget) throw new Error('target layer no longer exists');
    const currentState = manifestLayer(current.manifest, targetIndex);
    assertTask3Authorization(currentState, current.plan.plan_version);
    return {
      ...current,
      manifest: {
        ...current.manifest,
        authorizations: [...(current.manifest.authorizations || []), {
          authorization_id: authorizationId, layer_index: targetIndex, plan_version: current.plan.plan_version,
          candidate_number: candidateNumber, consumed: true, authorization_status: currentState.status,
          reservation_manifest_revision: current.manifest.revision + 1,
          ...(targetedFast ? { planning_mode: 'targeted_fast', snapshot_id: fastBinding.snapshot.snapshot_id,
            source_fingerprint: sourceFingerprint, processing_category: fastBinding.category,
            snapshot_path: fastBinding.path, snapshot_sha256: fastBinding.sha256,
            snapshot_file_sha256: fastBinding.fileSha256 } : {}),
          ...(dispatchId ? { dispatch_id: dispatchId } : {}),
        }],
        layers: current.manifest.layers.map((entry) => entry.layer_index === targetIndex ? {
          ...entry, status: 'GENERATING', authorization_consumed: true, generation_count: candidateNumber,
          ...(targetedFast && dispatchId ? { fast_execution: createPosterFastExecution({
            dispatchId,
            authorizationId,
            removeBackground: fastBinding.snapshot.layer.remove_background !== false,
          }) } : {}),
        } : entry),
      },
    };
  });
  const authorization = saved.manifest.authorizations.find((entry) => entry.authorization_id === authorizationId);
  return { ...authorizationSpec(saved, authorization, target, candidateNumber),
    ...(targetedFast ? { planning_mode: 'targeted_fast', snapshot_id: fastBinding.snapshot.snapshot_id,
      source_fingerprint: sourceFingerprint, processing_category: fastBinding.category,
      snapshot_path: fastBinding.path, snapshot_sha256: fastBinding.sha256,
      snapshot_file_sha256: fastBinding.fileSha256 } : {}),
    ...(dispatchId ? { dispatch_id: dispatchId } : {}) };
}

export async function rollbackPreparedPosterCandidate({ outputRoot, jobId, authorizationId, dispatchId, idempotent = false } = {}) {
  requiredString(outputRoot, 'outputRoot');
  requiredString(jobId, 'jobId');
  requiredString(authorizationId, 'authorizationId');
  const record = await readPosterJob(outputRoot, jobId);
  if (!record) throw new Error('poster job does not exist');
  const existing = (record.manifest.authorizations || []).find((entry) => entry?.authorization_id === authorizationId);
  if (!existing && idempotent) return record;
  if (dispatchId !== undefined && existing?.dispatch_id !== dispatchId) {
    if (idempotent) return record;
    throw new Error('candidate authorization dispatch binding is no longer rollbackable');
  }
  return mutatePosterJob(outputRoot, jobId, record.manifest.revision, (current) => {
    const authorization = (current.manifest.authorizations || []).find((entry) => entry?.authorization_id === authorizationId);
    if (!authorization || authorization.consumed !== true || authorization.finalized === true) {
      if (idempotent && !authorization) return current;
      throw new Error('candidate authorization is no longer rollbackable');
    }
    if (dispatchId !== undefined && authorization.dispatch_id !== dispatchId) {
      if (idempotent) return current;
      throw new Error('candidate authorization dispatch binding is no longer rollbackable');
    }
    const state = manifestLayer(current.manifest, authorization.layer_index);
    if (state.status !== 'GENERATING' || state.authorization_consumed !== true
      || state.generation_count !== authorization.candidate_number
      || authorization.plan_version !== current.plan.plan_version
      || !['GENERATION_AUTHORIZED', 'RETRY_AUTHORIZED'].includes(authorization.authorization_status)) {
      throw new Error('candidate generation state is no longer rollbackable');
    }
    const completedCount = candidatesForLayer(current.manifest, authorization.layer_index).length;
    return {
      ...current,
      manifest: {
        ...current.manifest,
        authorizations: current.manifest.authorizations.filter((entry) => entry.authorization_id !== authorizationId),
        layers: current.manifest.layers.map((entry) => entry.layer_index === authorization.layer_index ? {
          ...entry,
          status: authorization.authorization_status,
          authorization_consumed: false,
          generation_count: completedCount,
        } : entry),
      },
    };
  });
}

export async function restoreUnsentPosterCandidateAuthorization({
  outputRoot, jobId, layerIndex, planVersion, previousStatus = 'PENDING',
} = {}) {
  requiredString(outputRoot, 'outputRoot');
  requiredString(jobId, 'jobId');
  const targetIndex = positiveInteger(layerIndex, 'layerIndex');
  const version = positiveInteger(planVersion, 'planVersion');
  if (previousStatus !== 'PENDING') throw new Error('only a first-time PENDING authorization can be restored');
  const record = await readPosterJob(outputRoot, jobId);
  if (!record) throw new Error('poster job does not exist');
  return mutatePosterJob(outputRoot, jobId, record.manifest.revision, (current) => {
    const currentLayer = manifestLayer(current.manifest, targetIndex);
    const stillReserved = (current.manifest.authorizations || []).some((entry) => (
      entry?.layer_index === targetIndex && entry?.plan_version === version
      && entry?.consumed === true && entry?.finalized !== true
    ));
    if (stillReserved) throw new Error('candidate authorization is still reserved');
    if (current.plan.plan_version !== version
      || currentLayer.status !== 'GENERATION_AUTHORIZED'
      || currentLayer.authorization_plan_version !== version) {
      return current;
    }
    return {
      ...current,
      manifest: {
        ...current.manifest,
        layers: current.manifest.layers.map((entry) => {
          if (entry.layer_index !== targetIndex) return entry;
          const {
            authorization_plan_version, authorization_consumed, authorizationPlanVersion, authorizationConsumed,
            ...restored
          } = entry;
          void authorization_plan_version; void authorization_consumed;
          void authorizationPlanVersion; void authorizationConsumed;
          return { ...restored, status: previousStatus, authorization_consumed: false };
        }),
      },
    };
  });
}

/** Recover only a routed reservation that has no exact foreground dispatch.
 * The persisted dispatch_id makes an old cancel/replay unable to touch a
 * newer attempt which reuses the deterministic candidate number. */
export async function reconcilePreparedPosterCandidate({ outputRoot, jobId } = {}) {
  requiredString(outputRoot, 'outputRoot');
  requiredString(jobId, 'jobId');
  const record = await readPosterJob(outputRoot, jobId);
  if (!record) throw new Error('poster job does not exist');
  const active = (record.manifest.authorizations || []).filter((entry) => entry?.consumed === true
    && entry?.finalized !== true && typeof entry?.dispatch_id === 'string');
  for (const authorization of active) {
    dispatchIdentifier(authorization.dispatch_id, 'persisted dispatch_id');
    let dispatch = null;
    try {
      dispatch = JSON.parse(await readFile(path.join(record.paths.root, 'foreground-dispatches', `${authorization.dispatch_id}.json`), 'utf8'));
    } catch (error) {
      // The caller serializes this read with active lifecycle writes. Once that
      // lock is held, an empty/partial file is durable evidence of an enqueue
      // crash and is recovered exactly like a missing journal entry.
      dispatch = null;
    }
    const bound = dispatch?.taskKind === 'poster_candidate' && dispatch?.dispatchId === authorization.dispatch_id
      && dispatch?.layerIndex === authorization.layer_index && dispatch?.candidateNumber === authorization.candidate_number
      && dispatch?.authorizationId === authorization.authorization_id && dispatch?.planVersion === authorization.plan_version
      && (authorization.planning_mode !== 'targeted_fast' || (dispatch?.planningMode === 'targeted_fast'
        && dispatch?.snapshotId === authorization.snapshot_id
        && dispatch?.sourceFingerprint === authorization.source_fingerprint
        && dispatch?.manifestRevision === authorization.reservation_manifest_revision));
    if (!bound) await rollbackPreparedPosterCandidate({
      outputRoot, jobId, authorizationId: authorization.authorization_id, dispatchId: authorization.dispatch_id, idempotent: true,
    });
  }
  return readPosterJob(outputRoot, jobId);
}

function flagValue(flag) {
  const index = process.argv.indexOf(flag);
  const value = index >= 0 ? process.argv[index + 1] : null;
  if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`);
  return value;
}

async function main() {
  const phase = flagValue('--phase');
  const spec = await preparePosterJob({
    outputRoot: process.argv.includes('--output-root') ? flagValue('--output-root') : path.resolve('output'),
    jobId: flagValue('--job-id'), phase,
    layerIndex: phase === 'candidate' ? Number(flagValue('--layer-index')) : undefined,
  });
  process.stdout.write(`${JSON.stringify(spec, null, 2)}\n`);
}

if (await isDirectExecution(import.meta.url)) {
  main().catch((error) => { process.stderr.write(`Poster preflight failed: ${error.message}\n`); process.exitCode = 1; });
}
