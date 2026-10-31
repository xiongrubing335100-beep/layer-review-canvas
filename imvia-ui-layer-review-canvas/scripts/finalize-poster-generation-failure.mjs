import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { lstat, readFile } from 'node:fs/promises';

import { assertPosterFastAuthorizationBinding, assertPosterTargetedDispatchBinding, readPosterJob, recordPosterGenerationFailure } from '../src/poster-job-store.js';
import { validatePosterPlan } from '../src/poster-plan.js';
import { readPosterPngDimensions } from '../src/poster-png.js';
import { failForegroundDispatch, readForegroundDispatch } from '../src/foreground-dispatch.js';

function requiredString(value, label) {
  if (typeof value !== 'string' || value.trim().length === 0) throw new TypeError(`${label} is required`);
  return value.trim();
}

function positiveInteger(value, label) {
  if (!Number.isInteger(value) || value < 1) throw new TypeError(`${label} must be a positive integer`);
  return value;
}

function reportedFailureCode(value) {
  const code = requiredString(value, 'failureCode');
  if (!/^[A-Z][A-Z0-9_:-]{0,95}$/u.test(code)) throw new TypeError('failureCode must be an uppercase machine-readable code');
  return code;
}

function boundFailureCodes(code) {
  return code === 'GENERATION_FAILED' ? ['GENERATION_FAILED'] : ['GENERATION_FAILED', code];
}

async function readCandidateEvidence(candidateEvidencePath) {
  const evidencePath = path.resolve(requiredString(candidateEvidencePath, 'candidateEvidencePath'));
  const entry = await lstat(evidencePath);
  if (entry.isSymbolicLink() || !entry.isFile() || path.extname(evidencePath).toLowerCase() !== '.json') {
    throw new Error('candidate evidence must be a regular JSON file');
  }
  const evidence = JSON.parse(await readFile(evidencePath, 'utf8'));
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) {
    throw new TypeError('candidate evidence JSON must contain an object');
  }
  return evidence;
}

async function verifiedCandidateEvidence(candidateEvidence, plan) {
  if (candidateEvidence === undefined) return undefined;
  if (!candidateEvidence || typeof candidateEvidence !== 'object' || Array.isArray(candidateEvidence)) {
    throw new TypeError('candidateEvidence must be an object');
  }
  const inputPath = path.resolve(requiredString(candidateEvidence.input_path, 'candidateEvidence.input_path'));
  const actual = await readPosterPngDimensions(inputPath, 'candidate evidence');
  const declared = candidateEvidence.dimensions || {};
  if ((declared.width !== undefined && declared.width !== actual.width)
    || (declared.height !== undefined && declared.height !== actual.height)) {
    throw new Error('candidate evidence dimensions do not match the PNG');
  }
  return {
    ...candidateEvidence,
    input_path: inputPath,
    dimensions: {
      ...declared,
      width: actual.width,
      height: actual.height,
      expected_width: declared.expected_width ?? declared.expectedWidth ?? plan.source.width,
      expected_height: declared.expected_height ?? declared.expectedHeight ?? plan.source.height,
    },
  };
}

/**
 * Ends one already-dispatched poster generation without making its result
 * reviewable. A structurally usable PNG may be retained as unreviewed evidence;
 * IMAGEGEN_NO_PNG is reserved for calls without candidate evidence. The
 * dispatch, rather than caller parameters, owns the authorization binding.
 */
export async function finalizePosterGenerationFailure({
  outputRoot,
  jobId,
  layerIndex,
  dispatchId,
  failureCode = 'GENERATION_FAILED',
  message = 'ImageGen did not produce a usable PNG or review report',
  candidateEvidence,
  hooks = {},
} = {}) {
  requiredString(outputRoot, 'outputRoot');
  requiredString(jobId, 'jobId');
  const requestedLayerIndex = positiveInteger(layerIndex, 'layerIndex');
  const exactDispatchId = requiredString(dispatchId, 'dispatchId');
  const code = reportedFailureCode(failureCode);
  const failureMessage = requiredString(String(message), 'message');
  if (code === 'IMAGEGEN_NO_PNG' && candidateEvidence !== undefined) {
    throw new Error('IMAGEGEN_NO_PNG cannot be used with candidate evidence');
  }
  if (!hooks || typeof hooks !== 'object' || Array.isArray(hooks)) throw new TypeError('hooks must be an object');

  const jobDirectory = path.join(path.resolve(outputRoot), 'poster-jobs', jobId);
  const dispatch = await readForegroundDispatch(jobDirectory, { dispatchId: exactDispatchId, rootKind: 'poster' });
  if (dispatch.status === 'cancelled' || dispatch.status === 'completed') {
    throw new Error('foreground dispatch 已取消或已结束，禁止发布迟到失败');
  }
  if (dispatch.taskKind !== 'poster_candidate') throw new Error('foreground dispatch is not a poster candidate generation');
  if (dispatch.layerIndex !== requestedLayerIndex) throw new Error('foreground dispatch layerIndex does not match requested layer');
  for (const [label, value] of Object.entries({ candidateNumber: dispatch.candidateNumber, planVersion: dispatch.planVersion })) {
    positiveInteger(value, `dispatch ${label}`);
  }
  requiredString(dispatch.authorizationId, 'dispatch authorizationId');
  const record = await readPosterJob(outputRoot, jobId);
  if (!record) throw new Error('poster job does not exist');
  const validation = validatePosterPlan(record.plan);
  if (!validation.valid) throw new Error(`poster plan is invalid: ${validation.errors.map((error) => error.code).join(', ')}`);
  const authorization = (record.manifest.authorizations || []).find((entry) => entry?.authorization_id === dispatch.authorizationId);
  if (!authorization || authorization.layer_index !== dispatch.layerIndex
    || authorization.candidate_number !== dispatch.candidateNumber || authorization.plan_version !== dispatch.planVersion
    || authorization.dispatch_id !== exactDispatchId) {
    throw new Error('poster generation failure authorization is stale');
  }
  const existingCandidate = (record.manifest.candidates || []).find((entry) => entry?.layer_index === dispatch.layerIndex
    && entry?.candidate_number === dispatch.candidateNumber && entry?.plan_version === dispatch.planVersion);
  if (code === 'IMAGEGEN_NO_PNG' && existingCandidate?.path) {
    throw new Error('IMAGEGEN_NO_PNG cannot relabel an existing candidate PNG');
  }
  if (authorization.planning_mode === 'targeted_fast') {
    assertPosterFastAuthorizationBinding(record, authorization);
    await assertPosterTargetedDispatchBinding(record, authorization, exactDispatchId);
  }
  if (record.plan.status === 'PLAN_REVIEW' && authorization.planning_mode !== 'targeted_fast') {
    throw new Error('poster generation failure requires PLAN_CONFIRMED');
  }
  const retainedEvidence = await verifiedCandidateEvidence(candidateEvidence, record.plan);

  const binding = {
    taskKind: 'poster_candidate', layerIndex: dispatch.layerIndex, candidateNumber: dispatch.candidateNumber,
    authorizationId: dispatch.authorizationId, planVersion: dispatch.planVersion,
  };
  const failureCodes = boundFailureCodes(code);
  await failForegroundDispatch(jobDirectory, {
    dispatchId: exactDispatchId,
    rootKind: 'poster',
    binding,
    allowedStatuses: ['delivered', 'sent', 'finalizing'],
    failureCodes,
    error: failureMessage,
    persistFailure: () => recordPosterGenerationFailure({
      outputRoot, jobId, layerIndex: dispatch.layerIndex, authorizationId: dispatch.authorizationId,
      candidateNumber: dispatch.candidateNumber, planVersion: dispatch.planVersion, dispatchId: exactDispatchId,
      error: failureMessage, failureCodes, candidateEvidence: retainedEvidence,
    }),
    afterPersistFailure: hooks.afterManifestFailure,
    afterDispatchFailure: hooks.afterDispatchFailure,
  });
  return {
    status: 'failed', job_id: jobId, layer_index: dispatch.layerIndex, dispatch_id: exactDispatchId,
    candidate_number: dispatch.candidateNumber, authorization_id: dispatch.authorizationId, plan_version: dispatch.planVersion,
    failure_codes: failureCodes,
  };
}

function flagValue(flag) {
  const index = process.argv.indexOf(flag);
  const value = index >= 0 ? process.argv[index + 1] : null;
  if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`);
  return value;
}

async function runCli() {
  const candidateEvidence = process.argv.includes('--candidate-evidence')
    ? await readCandidateEvidence(flagValue('--candidate-evidence'))
    : undefined;
  return finalizePosterGenerationFailure({
    outputRoot: process.argv.includes('--output-root') ? flagValue('--output-root') : path.resolve('output'),
    jobId: flagValue('--job-id'), layerIndex: Number(flagValue('--layer-index')), dispatchId: flagValue('--dispatch-id'),
    failureCode: flagValue('--failure-code'), message: flagValue('--message'), candidateEvidence,
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runCli().then((result) => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)).catch((error) => {
    process.stderr.write(`Poster generation failure finalization failed: ${error.message}\n`); process.exitCode = 1;
  });
}
