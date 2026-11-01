import { isDirectExecution } from './direct-execution.mjs';
import { constants as fsConstants } from 'node:fs';
import { copyFile, link, lstat, open, readFile, realpath, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertPosterFastAuthorizationBinding, assertPosterTargetedDispatchBinding, fsyncDirectory, mutatePosterJob, readPosterJob, recordPosterGenerationFailure } from '../src/poster-job-store.js';
import { validatePosterPlan } from '../src/poster-plan.js';
import { candidateFileName } from '../src/poster-candidate-state.js';
import { assertPosterSourceDimensions, readPosterPng, readPosterPngDimensions, validateKeyedPosterCandidate, validateKeyedPosterCandidateBytes } from '../src/poster-png.js';
import { evaluatePosterRelease } from '../src/poster-release-gate.js';
import { assertForegroundDispatchBinding, assertForegroundDispatchPublishable, completeForegroundDispatch, failForegroundDispatch, finalizeForegroundDispatch, readForegroundDispatch } from '../src/foreground-dispatch.js';

function contained(root, target, label) {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(target);
  if (resolvedTarget !== resolvedRoot && !resolvedTarget.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error(`${label} escapes the poster job`);
  }
  return resolvedTarget;
}

function positiveInteger(value, label) {
  if (!Number.isInteger(value) || value < 1) throw new TypeError(`${label} must be a positive integer`);
  return value;
}

function slugForLayer(layer) {
  return String(layer.layer_name).trim().toLocaleLowerCase().replace(/\s+/gu, '-');
}

async function regularPng(target, label) {
  const info = await lstat(target);
  if (info.isSymbolicLink() || !info.isFile() || path.extname(target).toLowerCase() !== '.png') {
    throw new Error(`${label} must be a regular PNG file`);
  }
  return { path: target };
}

async function regularJson(target, label) {
  const info = await lstat(target);
  if (info.isSymbolicLink() || !info.isFile()) throw new Error(`${label} must be a regular file`);
  return JSON.parse(await readFile(target, 'utf8'));
}

function assertBoundReviewReport(report, binding) {
  if (!report || typeof report !== 'object' || Array.isArray(report)
    || report.job_id !== binding.jobId || report.layer_index !== binding.layerIndex
    || report.candidate_id !== binding.candidateId || report.authorization_id !== binding.authorizationId
    || report.plan_version !== binding.planVersion || report.candidate_number !== binding.candidateNumber
    || !report.checks || typeof report.checks !== 'object' || Array.isArray(report.checks)
    || Object.keys(report.checks).length === 0 || !Object.values(report.checks).every((value) => typeof value === 'boolean')) {
    throw new Error('review report is missing exact candidate binding or nonempty checks');
  }
}

function assertFinalizablePlan(plan, authorization = null) {
  const validation = validatePosterPlan(plan);
  if (!validation.valid) throw new Error(`poster plan is invalid: ${validation.errors.map((error) => error.code).join(', ')}`);
  if (plan.status !== 'PLAN_CONFIRMED' && !(plan.status === 'PLAN_REVIEW' && authorization?.planning_mode === 'targeted_fast')) {
    throw new Error('candidate finalization requires PLAN_CONFIRMED');
  }
}

function activeAuthorization(manifest, layerIndex, planVersion, candidateNumber) {
  const matching = (Array.isArray(manifest.authorizations) ? manifest.authorizations : []).filter((authorization) =>
    authorization?.layer_index === layerIndex && authorization?.plan_version === planVersion
      && authorization?.candidate_number === candidateNumber && authorization?.consumed === true && authorization?.finalized !== true);
  if (matching.length !== 1) throw new Error('exactly one consumed ImageGen authorization is required');
  return matching[0];
}

async function sha256(file) {
  return createHash('sha256').update(await readFile(file)).digest('hex');
}

async function readPinnedCandidate(root, target, label) {
  const lexical = contained(root, target, label);
  const rootEntry = await lstat(root);
  if (rootEntry.isSymbolicLink() || !rootEntry.isDirectory()) throw new Error(`${label} directory is unsafe`);
  const physicalRoot = await realpath(root);
  let handle;
  try {
    handle = await open(lexical, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const opened = await handle.stat();
    if (!opened.isFile()) throw new Error(`${label} must be a regular file`);
    const [currentRoot, currentTarget, physicalTarget] = await Promise.all([
      lstat(root), lstat(lexical), realpath(lexical),
    ]);
    if (currentRoot.isSymbolicLink() || !currentRoot.isDirectory()
      || currentRoot.dev !== rootEntry.dev || currentRoot.ino !== rootEntry.ino
      || currentTarget.isSymbolicLink() || !currentTarget.isFile()
      || currentTarget.dev !== opened.dev || currentTarget.ino !== opened.ino
      || path.dirname(physicalTarget) !== physicalRoot) {
      throw new Error(`${label} changed while it was being verified`);
    }
    const bytes = await handle.readFile();
    return {
      path: lexical,
      bytes,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      identity: { dev: opened.dev, ino: opened.ino },
    };
  } finally {
    await handle?.close();
  }
}

export async function syncPinnedCandidate(root, target, label, { platform = process.platform, openFile = open } = {}) {
  const pinned = await readPinnedCandidate(root, target, label);
  // Windows FlushFileBuffers needs write access; retain the pinned identity check.
  const access = platform === 'win32' ? fsConstants.O_RDWR : fsConstants.O_RDONLY;
  const handle = await openFile(pinned.path, access | fsConstants.O_NOFOLLOW);
  try {
    const current = await handle.stat();
    if (current.dev !== pinned.identity.dev || current.ino !== pinned.identity.ino) {
      throw new Error(`${label} changed before durability sync`);
    }
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fsyncDirectory(root);
  return pinned;
}

async function atomicCopy(source, target) {
  try {
    if (await sha256(source) === await sha256(target)) return false;
    throw new Error('existing candidate target differs from the exact staged candidate');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const temporary = path.join(path.dirname(target), `.${path.basename(target)}.${process.pid}.${Date.now()}.tmp`);
  try {
    await copyFile(source, temporary);
    await link(temporary, target);
    await syncPinnedCandidate(path.dirname(target), target, 'published candidate');
    return true;
  } finally {
    await rm(temporary, { force: true }).catch(() => {});
  }
}

async function physicallyContainedRegularFile(root, target, label) {
  const lexical = contained(root, target, label);
  const info = await lstat(lexical);
  if (info.isSymbolicLink() || !info.isFile()) throw new Error(`${label} must be a regular file`);
  const [physicalRoot, physicalTarget] = await Promise.all([realpath(root), realpath(lexical)]);
  if (!physicalTarget.startsWith(`${physicalRoot}${path.sep}`)) throw new Error(`${label} escapes through a symlink`);
  return lexical;
}

async function validatedTransparentPreview(record, target) {
  if (!target) return null;
  const previewPath = await physicallyContainedRegularFile(record.paths.evidence, target, 'transparent preview path');
  if (path.extname(previewPath).toLowerCase() !== '.png') throw new Error('transparent preview must be PNG');
  const decoded = await readPosterPng(previewPath, 'transparent preview');
  if (decoded.width !== record.plan.source.width || decoded.height !== record.plan.source.height) {
    throw new Error('transparent preview dimensions do not match the full source canvas');
  }
  if (decoded.colorType !== 6) throw new Error('transparent preview must contain an alpha channel');
  let alphaMin = 255;
  let alphaMax = 0;
  for (let offset = 3; offset < decoded.pixels.length; offset += 4) {
    alphaMin = Math.min(alphaMin, decoded.pixels[offset]);
    alphaMax = Math.max(alphaMax, decoded.pixels[offset]);
  }
  if (alphaMin !== 0 || alphaMax === 0) throw new Error('transparent preview must contain usable transparent pixels');
  return {
    path: previewPath,
    candidate_sha256: await sha256(previewPath),
    dimensions: { width: decoded.width, height: decoded.height },
    model: 'BRIA RMBG 2.0',
  };
}

async function verifyPersistedCandidate(record, layer, candidate, dispatch) {
  if (!candidate || candidate.layer_index !== dispatch.layerIndex
    || candidate.candidate_number !== dispatch.candidateNumber
    || candidate.plan_version !== dispatch.planVersion
    || typeof candidate.candidate_id !== 'string' || candidate.candidate_id.length === 0
    || typeof candidate.path !== 'string' || !/^[a-f0-9]{64}$/u.test(candidate.candidate_sha256 || '')) {
    throw new Error('persisted candidate binding is invalid');
  }
  const state = record.manifest.layers?.find((entry) => entry?.layer_index === dispatch.layerIndex);
  if (!state || state.candidate_output !== candidate.path || state.generation_count !== dispatch.candidateNumber) {
    throw new Error('persisted candidate layer binding is invalid');
  }
  const pinned = await syncPinnedCandidate(record.paths.candidates, candidate.path, 'persisted candidate');
  if (pinned.sha256 !== candidate.candidate_sha256) throw new Error('persisted candidate SHA-256 binding changed');
  const dimensions = validateKeyedPosterCandidateBytes(pinned.bytes, {
    width: record.plan.source.width, height: record.plan.source.height, fillColor: layer.fill_color,
  });
  if (candidate.dimensions?.width !== dimensions.width || candidate.dimensions?.height !== dimensions.height
    || candidate.dimensions?.fillColor !== dimensions.fillColor) {
    throw new Error('persisted candidate dimensions or key binding changed');
  }
  return candidate;
}

export async function finalizePosterCandidate({ outputRoot, jobId, layerIndex, candidateInputPath, reviewReportPath, transparentPreviewPath, afterCandidatePublished, dispatchId, trustedInternal = false } = {}) {
  if (afterCandidatePublished !== undefined && typeof afterCandidatePublished !== 'function') {
    throw new TypeError('afterCandidatePublished must be a function');
  }
  const targetIndex = positiveInteger(layerIndex, 'layerIndex');
  if (!dispatchId && !trustedInternal) throw new Error('dispatchId is required for routed poster finalization');
  const jobDirectory = path.join(outputRoot, 'poster-jobs', jobId);
  if (dispatchId) await assertForegroundDispatchBinding(jobDirectory, { dispatchId, rootKind: 'poster', taskKind: 'poster_candidate', layerIndex: targetIndex });
  const record = await readPosterJob(outputRoot, jobId);
  if (!record) throw new Error('poster job does not exist');
  if (dispatchId) {
    const dispatch = await readForegroundDispatch(jobDirectory, { dispatchId, rootKind: 'poster' });
    const alreadyPublished = (record.manifest.candidates || []).find((entry) => entry.layer_index === targetIndex
      && entry.candidate_number === dispatch.candidateNumber && entry.plan_version === dispatch.planVersion);
    if (dispatch.status === 'finalizing' && alreadyPublished) {
      try {
        const replayAuthorization = (record.manifest.authorizations || []).find((entry) => entry?.authorization_id === dispatch.authorizationId);
        if (!replayAuthorization || replayAuthorization.layer_index !== targetIndex
          || replayAuthorization.candidate_number !== dispatch.candidateNumber
          || replayAuthorization.plan_version !== dispatch.planVersion) {
          throw new Error('replayed candidate authorization is stale');
        }
        if (replayAuthorization.planning_mode === 'targeted_fast') {
          assertPosterFastAuthorizationBinding(record, replayAuthorization);
          await assertPosterTargetedDispatchBinding(record, replayAuthorization, dispatchId);
        }
        const layer = record.plan.layers.find((entry) => entry?.layer_index === targetIndex);
        if (!layer) throw new Error('persisted candidate layer is missing');
        await verifyPersistedCandidate(record, layer, alreadyPublished, dispatch);
        await completeForegroundDispatch(jobDirectory, { dispatchId, rootKind: 'poster' });
        return { status: alreadyPublished.status, candidatePath: alreadyPublished.path, layersDirectory: record.paths.layers, candidateId: alreadyPublished.candidate_id };
      } catch (error) {
        await failForegroundDispatch(jobDirectory, {
          dispatchId, rootKind: 'poster', error,
          binding: {
            taskKind: 'poster_candidate', layerIndex: targetIndex, candidateNumber: dispatch.candidateNumber,
            authorizationId: dispatch.authorizationId, planVersion: dispatch.planVersion,
          },
          persistFailure: () => recordPosterGenerationFailure({
            outputRoot, jobId, layerIndex: targetIndex, authorizationId: dispatch.authorizationId,
            candidateNumber: dispatch.candidateNumber, planVersion: dispatch.planVersion, dispatchId, error,
          }),
        });
        throw error;
      }
    }
  }
  const initialValidation = validatePosterPlan(record.plan);
  if (!initialValidation.valid) throw new Error(`poster plan is invalid: ${initialValidation.errors.map((error) => error.code).join(', ')}`);
  await assertPosterSourceDimensions(record.paths.source, record.plan.source);
  const layer = record.plan.layers.find((entry) => entry?.layer_index === targetIndex);
  if (!layer) throw new Error(`authorized target layer does not exist: ${targetIndex}`);
  const state = record.manifest.layers?.find((entry) => entry?.layer_index === targetIndex);
  if (state?.status !== 'GENERATING' || state?.authorization_consumed !== true) {
    throw new Error('candidate finalization requires the consumed Task 3 generation state');
  }
  const authorization = activeAuthorization(record.manifest, targetIndex, record.plan.plan_version, state.generation_count);
  assertFinalizablePlan(record.plan, authorization);
  if (authorization.planning_mode === 'targeted_fast') assertPosterFastAuthorizationBinding(record, authorization);
  if (authorization.planning_mode === 'targeted_fast' && dispatchId) {
    await assertPosterTargetedDispatchBinding(record, authorization, dispatchId);
  }
  if (dispatchId) {
    await assertForegroundDispatchBinding(jobDirectory, { dispatchId, rootKind: 'poster', taskKind: 'poster_candidate',
      layerIndex: targetIndex, candidateNumber: authorization.candidate_number, authorizationId: authorization.authorization_id, planVersion: record.plan.plan_version });
    await assertForegroundDispatchPublishable(jobDirectory, { dispatchId, rootKind: 'poster' });
  }
  const failureBinding = {
    taskKind: 'poster_candidate', layerIndex: targetIndex,
    candidateNumber: authorization.candidate_number, authorizationId: authorization.authorization_id,
    planVersion: record.plan.plan_version,
  };
  let failureRecorded = false;
  let retainedFailureEvidence = null;
  const persistFailure = async (error) => {
    await recordPosterGenerationFailure({
      outputRoot, jobId, layerIndex: targetIndex, authorizationId: authorization.authorization_id,
      candidateNumber: authorization.candidate_number, planVersion: record.plan.plan_version, dispatchId, error,
      failureCodes: retainedFailureEvidence?.failure_codes ?? ['GENERATION_FAILED'],
      candidateEvidence: retainedFailureEvidence?.candidate_evidence,
    });
    failureRecorded = true;
  };
  try {
  const candidate = await regularPng(path.resolve(candidateInputPath), 'candidate input');
  if (transparentPreviewPath && (authorization.planning_mode !== 'targeted_fast' || layer.remove_background !== true)) {
    throw new Error('transparent preview is only allowed for targeted fast remove-background candidates');
  }
  const transparentPreview = await validatedTransparentPreview(record, transparentPreviewPath);
  const candidateSha256 = await sha256(candidate.path);
  const targetPath = path.join(record.paths.candidates, candidateFileName({
    layerIndex: targetIndex, slug: slugForLayer(layer), generationCount: authorization.candidate_number,
  }));
  const candidateId = `${record.plan.job_id}:layer-${targetIndex}:candidate-${String(authorization.candidate_number).padStart(2, '0')}`;
  const reportPath = await physicallyContainedRegularFile(record.paths.evidence, reviewReportPath, 'review report path');
  const report = await regularJson(reportPath, 'review report path');
  assertBoundReviewReport(report, { jobId: record.plan.job_id, layerIndex: targetIndex, candidateId,
    authorizationId: authorization.authorization_id, planVersion: record.plan.plan_version, candidateNumber: authorization.candidate_number });
  const releaseGate = evaluatePosterRelease({
    layer,
    candidate: {
      candidate_id: candidateId, plan_version: record.plan.plan_version,
      candidate_sha256: candidateSha256,
    },
    review: report,
  });
  try {
    await validateKeyedPosterCandidate(candidate.path, { width: record.plan.source.width,
      height: record.plan.source.height, fillColor: layer.fill_color });
  } catch (error) {
    const observed = await readPosterPngDimensions(candidate.path, 'candidate input').catch(() => null);
    const validationCode = /key field|alpha channel|key color/i.test(error.message)
      ? 'KEY_UNUSABLE' : 'CANVAS_OR_GREEN_FIELD_INVALID';
    const failureCodes = [...new Set([...releaseGate.failureCodes, validationCode])];
    retainedFailureEvidence = {
      failure_codes: failureCodes,
      candidate_evidence: {
        input_path: candidate.path,
        candidate_sha256: candidateSha256,
        dimensions: {
          width: observed?.width ?? null, height: observed?.height ?? null,
          expected_width: record.plan.source.width, expected_height: record.plan.source.height,
          fillColor: layer.fill_color, validation_error: error.message,
        },
        review_report: reportPath,
        release_gate: releaseGate,
        key_findings: releaseGate.checks,
      },
    };
    throw error;
  }
  const outcome = { status: releaseGate.verdict, failureCodes: releaseGate.failureCodes };
  let saved;
  let published = false;
  let authorityPublished = false;
  let publishedDimensions;
  try {
  const publish = async () => {
    const committed = await mutatePosterJob(outputRoot, jobId, record.manifest.revision, async (current) => {
    const currentState = current.manifest.layers?.find((entry) => entry?.layer_index === targetIndex);
    const currentAuthorization = activeAuthorization(current.manifest, targetIndex, current.plan.plan_version, currentState?.generation_count);
    assertFinalizablePlan(current.plan, currentAuthorization);
    if (currentAuthorization.planning_mode === 'targeted_fast') assertPosterFastAuthorizationBinding(current, currentAuthorization);
    if (currentAuthorization.planning_mode === 'targeted_fast' && dispatchId) {
      await assertPosterTargetedDispatchBinding(current, currentAuthorization, dispatchId);
    }
    const currentLayer = current.plan.layers.find((entry) => entry?.layer_index === targetIndex);
    if (!currentLayer) throw new Error('target layer no longer exists');
    if (currentState?.status !== 'GENERATING' || currentState?.authorization_consumed !== true) {
      throw new Error('candidate generation state is no longer current');
    }
    if (currentAuthorization.authorization_id !== authorization.authorization_id
      || currentAuthorization.candidate_number !== authorization.candidate_number) throw new Error('ImageGen authorization is stale');
    const duplicate = (current.manifest.candidates || []).some((entry) => entry?.layer_index === targetIndex
      && entry?.candidate_number === currentAuthorization.candidate_number);
    if (duplicate) throw new Error('candidate number has already been finalized');
    published = await atomicCopy(candidate.path, targetPath);
    let pinned = await syncPinnedCandidate(current.paths.candidates, targetPath, 'published candidate');
    if (pinned.sha256 !== candidateSha256) {
      throw new Error('published candidate bytes differ from the reviewed SHA-256 binding');
    }
    publishedDimensions = validateKeyedPosterCandidateBytes(pinned.bytes, { width: current.plan.source.width,
      height: current.plan.source.height, fillColor: currentLayer.fill_color });
    await afterCandidatePublished?.(targetPath);
    pinned = await syncPinnedCandidate(current.paths.candidates, targetPath, 'published candidate');
    if (pinned.sha256 !== candidateSha256) {
      throw new Error('published candidate bytes changed before metadata commit');
    }
    publishedDimensions = validateKeyedPosterCandidateBytes(pinned.bytes, { width: current.plan.source.width,
      height: current.plan.source.height, fillColor: currentLayer.fill_color });
    const candidateRecord = {
      candidate_id: candidateId, layer_index: targetIndex, candidate_number: currentAuthorization.candidate_number,
      plan_version: current.plan.plan_version, path: targetPath, status: outcome.status,
      failure_codes: outcome.failureCodes, review_report: reportPath,
      dimensions: publishedDimensions, accepted: false, release_gate: releaseGate, candidate_sha256: candidateSha256,
      ...(transparentPreview ? { transparent_preview: transparentPreview } : {}),
    };
    return {
      ...current,
      manifest: {
        ...current.manifest,
        candidates: [...(current.manifest.candidates || []), candidateRecord],
        authorizations: current.manifest.authorizations.map((entry) => entry.authorization_id === currentAuthorization.authorization_id
          ? { ...entry, finalized: true, finalized_at: new Date().toISOString() } : entry),
        layers: (current.manifest.layers || []).map((entry) => entry.layer_index === targetIndex ? {
          ...entry, status: outcome.status, generation_count: currentAuthorization.candidate_number,
          candidate_output: targetPath, visual_inspection: {
            performed: true, verdict: outcome.status, failure_codes: outcome.failureCodes,
            checks: releaseGate.checks, candidate_id: candidateId, plan_version: current.plan.plan_version,
            candidate_sha256: candidateSha256,
          }, source_output: null,
        } : entry),
      },
    };
    });
    authorityPublished = true;
    return committed;
  };
  saved = dispatchId
    ? await finalizeForegroundDispatch(jobDirectory, { dispatchId, rootKind: 'poster', binding: { taskKind: 'poster_candidate',
      layerIndex: targetIndex, candidateNumber: authorization.candidate_number, authorizationId: authorization.authorization_id, planVersion: record.plan.plan_version },
    publish })
    : await publish();
  } catch (error) {
    if (published && !authorityPublished) await rm(targetPath, { force: true }).catch(() => {});
    throw error;
  }
  return { status: outcome.status, candidatePath: targetPath, layersDirectory: saved.paths.layers, candidateId };
  } catch (error) {
    if (!failureRecorded && dispatchId) {
      await failForegroundDispatch(jobDirectory, {
        dispatchId, rootKind: 'poster', binding: failureBinding, error,
        persistFailure: () => persistFailure(error),
      }).catch(() => {});
    } else if (!failureRecorded) {
      await persistFailure(error);
    }
    throw error;
  }
}

function flagValue(flag) {
  const index = process.argv.indexOf(flag);
  const value = index >= 0 ? process.argv[index + 1] : null;
  if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`);
  return value;
}

function optionalFlagValue(flag) {
  const index = process.argv.indexOf(flag);
  if (index < 0) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`);
  return value;
}

if (await isDirectExecution(import.meta.url)) {
  finalizePosterCandidate({
    outputRoot: process.argv.includes('--output-root') ? flagValue('--output-root') : path.resolve('output'),
    jobId: flagValue('--job-id'), layerIndex: Number(flagValue('--layer-index')),
    candidateInputPath: flagValue('--candidate-input'), reviewReportPath: flagValue('--review-report'),
    transparentPreviewPath: optionalFlagValue('--transparent-preview'),
    dispatchId: flagValue('--dispatch-id'),
  }).then((result) => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)).catch((error) => {
    process.stderr.write(`Poster candidate finalization failed: ${error.message}\n`); process.exitCode = 1;
  });
}
