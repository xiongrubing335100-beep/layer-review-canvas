import { isDirectExecution } from './direct-execution.mjs';
import { constants as fsConstants } from 'node:fs';
import { access, copyFile, lstat, readFile, rename, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { mutatePosterJob, readPosterJob } from '../src/poster-job-store.js';
import { readPosterPngDimensions, validateKeyedPosterCandidate } from '../src/poster-png.js';
import { advancePosterFastExecution, failPosterFastExecution } from '../src/poster-fast-execution.js';
import { finalizePosterCandidate } from './finalize-poster-candidate.mjs';

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const RMBG_SCRIPT = path.join(SCRIPT_DIRECTORY, 'finalize-rmbg.py');
const PREPARE_SCRIPT = path.join(SCRIPT_DIRECTORY, 'prepare-poster-rmbg-candidate.py');
const REVIEW_MODE = 'targeted_fast_passthrough_v1';

function positiveInteger(value, label) {
  if (!Number.isInteger(value) || value < 1) throw new TypeError(`${label} must be a positive integer`);
  return value;
}

function requiredString(value, label) {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(`${label} is required`);
  return value;
}

export function resolvePosterOutputRootFromJobDirectory(jobDirectory, jobId) {
  const resolved = path.resolve(requiredString(jobDirectory, 'jobDirectory'));
  if (path.basename(resolved) !== requiredString(jobId, 'jobId')) {
    throw new Error('poster job directory does not match jobId');
  }
  const posterJobsDirectory = path.dirname(resolved);
  if (path.basename(posterJobsDirectory) !== 'poster-jobs') {
    throw new Error('poster job directory must be inside poster-jobs');
  }
  return path.dirname(posterJobsDirectory);
}

function layerSlug(layer) {
  const value = String(layer?.layer_name || 'layer').trim()
    .replace(/[^\p{Letter}\p{Number}._-]+/gu, '-')
    .replace(/^-+|-+$/gu, '');
  return value || 'layer';
}

async function sha256(target) {
  return createHash('sha256').update(await readFile(target)).digest('hex');
}

async function safeRawPng(target) {
  const resolved = path.resolve(requiredString(target, 'rawInputPath'));
  const entry = await lstat(resolved);
  if (entry.isSymbolicLink() || !entry.isFile() || path.extname(resolved).toLowerCase() !== '.png') {
    throw new Error('targeted fast raw input must be a regular PNG file');
  }
  return resolved;
}

async function preserveRaw(source, target) {
  if (path.resolve(source) === path.resolve(target)) return;
  const sourceDigest = await sha256(source);
  try {
    if (await sha256(target) === sourceDigest) return;
    throw new Error('existing targeted fast raw evidence differs from the submitted PNG');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  await copyFile(source, target, fsConstants.COPYFILE_EXCL);
}

async function configuredPython(environment = process.env) {
  if (environment.IMVIA_LAYER_PYTHON_COMMAND || environment.PYTHON) {
    let args = [];
    try {
      const parsed = JSON.parse(environment.IMVIA_LAYER_PYTHON_ARGS || '[]');
      if (Array.isArray(parsed) && parsed.every((entry) => typeof entry === 'string')) args = parsed;
    } catch {
      args = [];
    }
    return { command: environment.IMVIA_LAYER_PYTHON_COMMAND || environment.PYTHON, args };
  }
  const pluginRoot = path.resolve(SCRIPT_DIRECTORY, '..', '..');
  const localPython = process.platform === 'win32'
    ? path.join(pluginRoot, '.python-runtime', 'Scripts', 'python.exe')
    : path.join(pluginRoot, '.python-runtime', 'bin', 'python3');
  try {
    await access(localPython, fsConstants.X_OK);
    return { command: localPython, args: [] };
  } catch {
    return { command: process.platform === 'win32' ? 'python' : 'python3', args: [] };
  }
}

async function runJson(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { if (stdout.length < 256 * 1024) stdout += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk) => { if (stderr.length < 64 * 1024) stderr += chunk.toString('utf8'); });
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code !== 0) {
        reject(new Error(stderr.trim() || `targeted fast postprocess exited with code ${code}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout.trim()));
      } catch {
        reject(new Error('targeted fast postprocess did not return JSON'));
      }
    });
  });
}

async function defaultRunRmbgStep({ inputPath, outputPath, expectedWidth, expectedHeight }) {
  const python = await configuredPython();
  return runJson(python.command, [
    ...python.args, RMBG_SCRIPT,
    '--input', inputPath,
    '--output', outputPath,
    '--model', 'bria-rmbg',
    '--expected-width', String(expectedWidth),
    '--expected-height', String(expectedHeight),
  ]);
}

async function defaultRunPrepareStep({
  inputPath,
  alphaOutputPath,
  keyedOutputPath,
  sourceWidth,
  sourceHeight,
  fillColor,
  placementBounds,
  safetyMargin,
}) {
  const python = await configuredPython();
  const argumentsList = [
    ...python.args, PREPARE_SCRIPT,
    '--input', inputPath,
    '--alpha-output', alphaOutputPath,
    '--keyed-output', keyedOutputPath,
    '--source-width', String(sourceWidth),
    '--source-height', String(sourceHeight),
    '--fill-color', fillColor,
    '--safety-margin', String(safetyMargin),
  ];
  if (placementBounds) {
    argumentsList.push(
      '--placement-x', String(placementBounds.x),
      '--placement-y', String(placementBounds.y),
      '--placement-width', String(placementBounds.width),
      '--placement-height', String(placementBounds.height),
    );
  }
  return runJson(python.command, argumentsList);
}

async function atomicJson(target, value) {
  const temporary = path.join(path.dirname(target), `.${path.basename(target)}.${process.pid}.${Date.now()}.tmp`);
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
  try {
    await rename(temporary, target);
  } catch (error) {
    await import('node:fs/promises').then(({ rm }) => rm(temporary, { force: true })).catch(() => {});
    throw error;
  }
}

function activeAuthorization(record, layerIndex) {
  const state = record.manifest.layers?.find((entry) => entry?.layer_index === layerIndex);
  const matches = (record.manifest.authorizations || []).filter((entry) => (
    entry?.layer_index === layerIndex
    && entry?.plan_version === record.plan.plan_version
    && entry?.candidate_number === state?.generation_count
    && entry?.consumed === true
    && entry?.finalized !== true
  ));
  if (state?.status !== 'GENERATING' || state?.authorization_consumed !== true || matches.length !== 1) {
    throw new Error('targeted fast finalizer requires one consumed generation authorization');
  }
  return matches[0];
}

async function transitionFastExecution(outputRoot, jobId, layerIndex, dispatchId, transition) {
  const record = await readPosterJob(outputRoot, jobId);
  if (!record) throw new Error('poster job does not exist');
  return mutatePosterJob(outputRoot, jobId, record.manifest.revision, (current) => ({
    ...current,
    manifest: {
      ...current.manifest,
      layers: current.manifest.layers.map((entry) => {
        if (entry.layer_index !== layerIndex) return entry;
        const execution = entry.fast_execution;
        if (!execution || execution.dispatch_id !== dispatchId) {
          throw new Error('targeted fast execution binding is stale');
        }
        return { ...entry, fast_execution: transition(execution) };
      }),
    },
  }));
}

export async function finalizePosterFastRmbgCandidate({
  outputRoot,
  jobDirectory,
  jobId,
  layerIndex,
  rawInputPath,
  dispatchId,
  trustedInternal = false,
  runRmbgStep = defaultRunRmbgStep,
  runPrepareStep = defaultRunPrepareStep,
} = {}) {
  requiredString(jobId, 'jobId');
  requiredString(dispatchId, 'dispatchId');
  const resolvedOutputRoot = jobDirectory
    ? resolvePosterOutputRootFromJobDirectory(jobDirectory, jobId)
    : path.resolve(requiredString(outputRoot, 'outputRoot'));
  const targetIndex = positiveInteger(layerIndex, 'layerIndex');
  const record = await readPosterJob(resolvedOutputRoot, jobId);
  if (!record) throw new Error('poster job does not exist');
  const layer = record.plan.layers?.find((entry) => entry?.layer_index === targetIndex);
  if (!layer) throw new Error('targeted fast layer does not exist');
  const authorization = activeAuthorization(record, targetIndex);
  if (authorization.planning_mode !== 'targeted_fast' || layer.remove_background !== true) {
    throw new Error('fast RMBG passthrough requires targeted_fast remove_background');
  }

  const source = await safeRawPng(rawInputPath);
  const dimensions = await readPosterPngDimensions(source, 'targeted fast raw input');
  const number = authorization.candidate_number;
  const stem = `layer_${targetIndex}_${layerSlug(layer)}_candidate-${String(number).padStart(2, '0')}`;
  const rawEvidencePath = path.join(record.paths.evidence, `${stem}.imagegen-raw.png`);
  const rmbgPath = path.join(record.paths.evidence, `${stem}.rmbg.png`);
  const transparentPreviewPath = path.join(record.paths.evidence, `${stem}.transparent-preview.png`);
  const keyedCandidatePath = path.join(record.paths.evidence, `${stem}.keyed-full-canvas.png`);
  const reportPath = path.join(record.paths.evidence, `${stem}.fast-review.json`);
  await preserveRaw(source, rawEvidencePath);
  let activeStage = 'rmbg';
  await transitionFastExecution(resolvedOutputRoot, jobId, targetIndex, dispatchId,
    (execution) => ({
      ...advancePosterFastExecution(execution, 'rmbg'),
      raw_candidate_available: true,
      raw_candidate_path: rawEvidencePath,
    }));

  let rmbg;
  let prepared;
  try {
    rmbg = await runRmbgStep({
      inputPath: rawEvidencePath,
      outputPath: rmbgPath,
      expectedWidth: dimensions.width,
      expectedHeight: dimensions.height,
    });
    activeStage = 'canvas_mapping';
    await transitionFastExecution(resolvedOutputRoot, jobId, targetIndex, dispatchId,
      (execution) => advancePosterFastExecution(execution, 'canvas_mapping'));
    prepared = await runPrepareStep({
      inputPath: rmbgPath,
      alphaOutputPath: transparentPreviewPath,
      keyedOutputPath: keyedCandidatePath,
      sourceWidth: record.plan.source.width,
      sourceHeight: record.plan.source.height,
      fillColor: layer.fill_color,
      placementBounds: layer.bounds?.source_pixels,
      safetyMargin: 0.06,
    });
    await validateKeyedPosterCandidate(keyedCandidatePath, {
      width: record.plan.source.width,
      height: record.plan.source.height,
      fillColor: layer.fill_color,
    });
    activeStage = 'finalizing';
    await transitionFastExecution(resolvedOutputRoot, jobId, targetIndex, dispatchId,
      (execution) => advancePosterFastExecution(execution, 'finalizing'));
  } catch (error) {
    await transitionFastExecution(resolvedOutputRoot, jobId, targetIndex, dispatchId,
      (execution) => failPosterFastExecution(execution, activeStage)).catch(() => {});
    throw error;
  }

  const candidateId = `${record.plan.job_id}:layer-${targetIndex}:candidate-${String(number).padStart(2, '0')}`;
  const report = {
    job_id: record.plan.job_id,
    layer_index: targetIndex,
    candidate_id: candidateId,
    authorization_id: authorization.authorization_id,
    plan_version: record.plan.plan_version,
    candidate_number: number,
    review_mode: REVIEW_MODE,
    verdict: 'NEEDS_USER_REVIEW',
    failure_codes: [],
    checks: {
      source_comparison: true,
      locked_anchors: true,
      repair_envelope: true,
      canvas_dimensions: true,
      key_field: true,
    },
    visual_comparison: {
      performed: false,
      deferred_to: 'workbench_user',
    },
    generation: {
      imagegen_calls: 1,
      raw_input_path: rawEvidencePath,
      raw_dimensions: { width: dimensions.width, height: dimensions.height },
      raw_sha256: await sha256(rawEvidencePath),
    },
    rmbg,
    postprocess: prepared,
  };
  await atomicJson(reportPath, report);

  try {
    const finalized = await finalizePosterCandidate({
      outputRoot: resolvedOutputRoot,
      jobId,
      layerIndex: targetIndex,
      candidateInputPath: keyedCandidatePath,
      reviewReportPath: reportPath,
      transparentPreviewPath,
      ...(trustedInternal ? { trustedInternal: true } : { dispatchId }),
    });
    const completed = await transitionFastExecution(resolvedOutputRoot, jobId, targetIndex, dispatchId,
      (execution) => advancePosterFastExecution(execution, 'review_ready'));
    return { ...finalized, execution: completed.manifest.layers.find((entry) => entry.layer_index === targetIndex)?.fast_execution };
  } catch (error) {
    await transitionFastExecution(resolvedOutputRoot, jobId, targetIndex, dispatchId,
      (execution) => failPosterFastExecution(execution, 'finalizing')).catch(() => {});
    throw error;
  }
}

function flagValue(flag) {
  const index = process.argv.indexOf(flag);
  const value = index >= 0 ? process.argv[index + 1] : null;
  if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`);
  return value;
}

if (await isDirectExecution(import.meta.url)) {
  finalizePosterFastRmbgCandidate({
    ...(process.argv.includes('--job-directory')
      ? { jobDirectory: flagValue('--job-directory') }
      : { outputRoot: process.argv.includes('--output-root') ? flagValue('--output-root') : path.resolve('output') }),
    jobId: flagValue('--job-id'),
    layerIndex: Number(flagValue('--layer-index')),
    rawInputPath: flagValue('--raw-input'),
    dispatchId: flagValue('--dispatch-id'),
  }).then((result) => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)).catch((error) => {
    process.stderr.write(`Poster targeted fast RMBG finalization failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}
