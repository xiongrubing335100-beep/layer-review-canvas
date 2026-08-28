import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { copyFile, link, lstat, mkdir, open, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { zipSync } from 'fflate';
import { withDirectoryLock } from './file-lock.js';
import { candidateFileName } from './poster-candidate-state.js';
import { resumePosterFastPostprocess } from './poster-fast-execution.js';
import { posterCandidateEligibility } from './poster-candidate-eligibility.js';
import { canonicalJson, digestCanonicalJson } from './poster-plan.js';
import {
  canExportPosterPackage,
  canRunPosterAudit,
  recordRecompositionAudit,
} from './poster-recomposition.js';

const JOB_ID_PATTERN = /^[a-zA-Z0-9._-]+$/;
const REQUIRED_FILES = ['source.png', 'poster-layer-plan.json', 'layer_manifest.json', 'poster-execution-report.json'];
const REQUIRED_DIRECTORIES = ['evidence', 'candidates', 'layers'];
const DEFAULT_MANIFEST_TEMPLATE_URL = new URL('./assets/poster-layer-manifest-v3.1.json', import.meta.url);
const NORMALIZER_PATH = fileURLToPath(new URL('../scripts/normalize-poster-layer.py', import.meta.url));
const RECOMPOSITION_AUDITOR_PATH = fileURLToPath(new URL('../scripts/audit-poster-recomposition.py', import.meta.url));
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const RELEASE_CHECK_KEYS = Object.freeze([
  'source_comparison', 'locked_anchors', 'repair_envelope', 'canvas_dimensions', 'key_field',
]);
const TARGETED_PROCESSING_CATEGORIES = new Set([
  'subject', 'text', 'brand_ui', 'decoration_prop', 'effect', 'background',
]);

export class PosterJobConflictError extends Error {
  constructor(message = '海报任务版本已变化') {
    super(message);
    this.name = 'PosterJobConflictError';
  }
}

export class PosterJobPathError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PosterJobPathError';
  }
}

export class PosterJobStoreError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = 'PosterJobStoreError';
  }
}

export function resolvePosterManifestTemplatePath(manifestTemplatePath) {
  if (manifestTemplatePath === undefined || manifestTemplatePath === null) {
    return fileURLToPath(DEFAULT_MANIFEST_TEMPLATE_URL);
  }
  return path.resolve(requiredString(manifestTemplatePath, 'manifestTemplatePath'));
}

function clone(value) {
  return structuredClone(value);
}

function requiredString(value, label) {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(`${label} is required`);
  return value;
}

function jobsDirectory(outputRoot) {
  return path.resolve(requiredString(outputRoot, 'outputRoot'), 'poster-jobs');
}

function assertJobId(jobId) {
  if (!JOB_ID_PATTERN.test(String(jobId || ''))) {
    throw new PosterJobPathError('jobId 格式无效');
  }
  return String(jobId);
}

function containedPath(root, target, label) {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(target);
  if (resolvedTarget !== resolvedRoot && !resolvedTarget.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new PosterJobPathError(`${label} 超出允许目录`);
  }
  return resolvedTarget;
}

function pathsAt(root) {
  return {
    root,
    source: path.join(root, 'source.png'),
    plan: path.join(root, 'poster-layer-plan.json'),
    manifest: path.join(root, 'layer_manifest.json'),
    report: path.join(root, 'poster-execution-report.json'),
    evidence: path.join(root, 'evidence'),
    candidates: path.join(root, 'candidates'),
    layers: path.join(root, 'layers'),
  };
}

function pathsFor(outputRoot, jobId) {
  const safeJobId = assertJobId(jobId);
  const jobsRoot = jobsDirectory(outputRoot);
  const root = containedPath(jobsRoot, path.resolve(jobsRoot, safeJobId), '任务目录');
  return pathsAt(root);
}

function lockPath(outputRoot, jobId) {
  const safeJobId = assertJobId(jobId);
  const outputDirectory = path.resolve(requiredString(outputRoot, 'outputRoot'));
  return containedPath(outputDirectory, path.join(outputDirectory, `.${safeJobId}.lock`), '任务锁');
}

async function exists(target) {
  return lstat(target).then(() => true).catch((error) => {
    if (error.code === 'ENOENT') return false;
    throw error;
  });
}

async function lstatOrNull(target) {
  try {
    return await lstat(target);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new PosterJobPathError(`无法安全检查目录：${target}`);
  }
}

async function assertSafeOutputRoot(outputRoot) {
  const root = path.resolve(requiredString(outputRoot, 'outputRoot'));
  const entry = await lstatOrNull(root);
  if (!entry || entry.isSymbolicLink() || !entry.isDirectory()) {
    throw new PosterJobPathError('outputRoot 必须是存在的非符号链接目录');
  }
  try {
    return { lexical: root, physical: await realpath(root) };
  } catch (error) {
    throw new PosterJobPathError('outputRoot 无法解析为安全目录');
  }
}

async function ensureSafePosterJobsDirectory(outputRoot, { create } = { create: false }) {
  const output = await assertSafeOutputRoot(outputRoot);
  const jobsRoot = path.join(output.lexical, 'poster-jobs');
  let entry = await lstatOrNull(jobsRoot);
  if (!entry && !create) return null;
  if (!entry) {
    try {
      await mkdir(jobsRoot);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
    entry = await lstatOrNull(jobsRoot);
  }
  if (!entry || entry.isSymbolicLink() || !entry.isDirectory()) {
    throw new PosterJobPathError('poster-jobs 目录必须是安全的非符号链接目录');
  }
  try {
    const physical = await realpath(jobsRoot);
    if (physical !== path.join(output.physical, 'poster-jobs')) {
      throw new PosterJobPathError('poster-jobs 目录不在 outputRoot 内');
    }
  } catch (error) {
    if (error instanceof PosterJobPathError) throw error;
    throw new PosterJobPathError('poster-jobs 目录无法解析为安全目录');
  }
  return jobsRoot;
}

async function removeOwnedTemporary(target, identity) {
  if (!identity) return;
  const current = await lstatOrNull(target);
  if (!current || current.isSymbolicLink() || !current.isFile()
    || current.dev !== identity.dev || current.ino !== identity.ino) return;
  await rm(target, { force: true });
}

async function atomicWriteFile(target, contents, hooks = {}) {
  const directory = path.dirname(target);
  const temporary = path.join(directory, `.${path.basename(target)}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`);
  let handle;
  let temporaryIdentity = null;
  let targetPublished = false;
  try {
    handle = await open(temporary,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
    const opened = await handle.stat();
    if (!opened.isFile()) throw new PosterJobPathError('JSON 临时文件必须是安全的普通文件');
    temporaryIdentity = { dev: opened.dev, ino: opened.ino };
    await handle.writeFile(contents);
    await handle.sync();
    await handle.close();
    handle = null;
    await hooks.afterTemporarySynced?.({ targetPath: target, temporaryPath: temporary });
    const currentTemporary = await lstat(temporary);
    if (currentTemporary.isSymbolicLink() || !currentTemporary.isFile()
      || currentTemporary.dev !== temporaryIdentity.dev || currentTemporary.ino !== temporaryIdentity.ino) {
      throw new PosterJobPathError('JSON 临时文件在发布前发生变化');
    }
    await rename(temporary, target);
    targetPublished = true;
    await hooks.afterRenamed?.({ targetPath: target, temporaryPath: temporary });
    await (hooks.syncDirectory || fsyncDirectory)(directory);
    await hooks.afterParentSynced?.({ targetPath: target, temporaryPath: temporary });
  } catch (error) {
    if (targetPublished) {
      const publishedError = new PosterJobStoreError(
        error instanceof Error ? error.message : 'JSON 已发布但父目录持久化失败',
        { cause: error },
      );
      publishedError.code = error?.code;
      publishedError.posterJsonTargetPublished = target;
      throw publishedError;
    }
    throw error;
  } finally {
    await handle?.close().catch(() => {});
    if (!targetPublished) await removeOwnedTemporary(temporary, temporaryIdentity);
  }
}

async function atomicWriteJson(target, value, hooks) {
  await atomicWriteFile(target, `${JSON.stringify(value, null, 2)}\n`, hooks);
}

async function atomicCopy(source, target) {
  const directory = path.dirname(target);
  const temporary = path.join(directory, `.${path.basename(target)}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`);
  await copyFile(source, temporary);
  await rename(temporary, target);
}

async function readJson(target) {
  return JSON.parse(await readFile(target, 'utf8'));
}

async function readManifestTemplate(manifestTemplatePath) {
  const templatePath = resolvePosterManifestTemplatePath(manifestTemplatePath);
  try {
    const template = await readJson(templatePath);
    if (template === null || typeof template !== 'object' || Array.isArray(template)
      || template.execution?.candidate_visibility !== 'hidden') {
      throw new PosterJobStoreError('海报任务模板损坏');
    }
    return template;
  } catch (error) {
    if (error instanceof PosterJobStoreError) throw error;
    throw new PosterJobStoreError('海报任务模板损坏', { cause: error });
  }
}

function normalizedPlan(plan, paths, jobId) {
  if (plan === null || typeof plan !== 'object' || Array.isArray(plan)) {
    throw new TypeError('plan must be an object');
  }
  const next = clone(plan);
  next.job_id = jobId;
  next.source = { ...(next.source || {}), path: 'source.png' };
  next.output_directory = paths.root;
  // Package paths are canonicalized at creation. Rebuild Task 1 snapshots at
  // the same time so their self-verifying source binding remains truthful.
  if (next.planning_mode === 'targeted_fast' && Array.isArray(next.layers)) {
    next.layers = next.layers.map((layer) => {
      const snapshot = layer?.confirmed_snapshot;
      if (!snapshot) return layer;
      const updated = { ...snapshot, job_id: jobId, source: clone(next.source) };
      const snapshotId = digestCanonicalJson({
        job_id: updated.job_id, plan_version: updated.plan_version, layer_index: updated.layer_index,
        layer: updated.layer, source: updated.source,
      });
      updated.snapshot_id = snapshotId;
      return { ...layer, snapshot_id: snapshotId, confirmed_snapshot: updated };
    });
  }
  return next;
}

function initializedManifest(template, plan) {
  const layerTemplate = template.layers?.[0] || {};
  return {
    ...template,
    source: {
      ...(template.source || {}),
      path: 'source.png',
      width: plan.source?.width ?? null,
      height: plan.source?.height ?? null,
      aspect_ratio: plan.source?.aspect_ratio ?? null,
    },
    layers: Array.isArray(plan.layers)
      ? plan.layers.map((layer) => ({ ...clone(layerTemplate), ...clone(layer) }))
      : [],
    revision: 1,
    candidates: [],
  };
}

export function synchronizeFastPosterManifest(manifest, plan) {
  if (plan?.planning_mode !== 'targeted_fast' || !Array.isArray(plan.layers)) return clone(manifest);
  const current = clone(manifest || {});
  const existingByIndex = new Map((current.layers || []).map((layer) => [layer.layer_index, layer]));
  const template = clone((current.layers || []).find((layer) => layer?.status === 'PENDING') || current.layers?.[0] || {});
  const layers = plan.layers.map((planLayer) => {
    const existing = existingByIndex.get(planLayer.layer_index);
    if (existing) {
      const status = existing.status || 'PENDING';
      const generationCount = Number.isInteger(existing.generation_count) ? existing.generation_count : 0;
      return { ...existing, ...clone(planLayer), status, generation_count: generationCount };
    }
    const {
      authorization_id, authorization_plan_version, authorization_consumed,
      authorizationId, authorizationPlanVersion, authorizationConsumed,
      ...cleanTemplate
    } = template;
    void authorization_id; void authorization_plan_version; void authorization_consumed;
    void authorizationId; void authorizationPlanVersion; void authorizationConsumed;
    return {
      ...cleanTemplate,
      ...clone(planLayer),
      status: 'PENDING',
      generation_count: 0,
      candidate_output: null,
      candidate_prompt: null,
      visual_inspection: { performed: false, verdict: null, failure_codes: [] },
      review_note: null,
      source_output: null,
      final_dimensions: null,
      hd_status: 'HD_PENDING',
      hd_output: null,
      authorization_consumed: false,
    };
  });
  const liveIndexes = new Set(layers.map((layer) => layer.layer_index));
  return {
    ...current,
    layers,
    candidates: (current.candidates || []).filter((candidate) => liveIndexes.has(candidate?.layer_index)),
    authorizations: (current.authorizations || []).filter((authorization) => liveIndexes.has(authorization?.layer_index)),
  };
}

function recordFrom(paths, plan, manifest, report) {
  return {
    paths: { ...paths },
    plan,
    manifest,
    report,
  };
}

async function requirePackageEntry(target, type, label) {
  let entry;
  try {
    entry = await lstat(target);
  } catch (error) {
    if (error.code === 'ENOENT') throw new PosterJobStoreError(`海报任务包不完整：缺少${label}`);
    throw new PosterJobStoreError(`海报任务包损坏：无法读取${label}`, { cause: error });
  }
  if (entry.isSymbolicLink() || (type === 'file' ? !entry.isFile() : !entry.isDirectory())) {
    throw new PosterJobStoreError(`海报任务包损坏：${label}类型无效`);
  }
}

function requireMetadataObject(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new PosterJobStoreError(`海报任务包损坏：${label}元数据无效`);
  }
  return value;
}

async function readPosterJobAt(paths) {
  let root;
  try {
    root = await lstat(paths.root);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new PosterJobStoreError('海报任务包损坏：无法读取任务目录', { cause: error });
  }
  if (root.isSymbolicLink() || !root.isDirectory()) {
    throw new PosterJobStoreError('海报任务包损坏：任务目录类型无效');
  }
  await Promise.all([
    ...REQUIRED_FILES.map((filename) => requirePackageEntry(path.join(paths.root, filename), 'file', filename)),
    ...REQUIRED_DIRECTORIES.map((directory) => requirePackageEntry(path.join(paths.root, directory), 'directory', directory)),
  ]);
  try {
    const [plan, manifest, report] = await Promise.all([
      readJson(paths.plan), readJson(paths.manifest), readJson(paths.report),
    ]);
    requireMetadataObject(plan, '计划');
    requireMetadataObject(manifest, '清单');
    requireMetadataObject(report, '报告');
    if (!Number.isInteger(manifest.revision) || manifest.revision < 1) {
      throw new PosterJobStoreError('海报任务包损坏：清单版本无效');
    }
    return recordFrom(paths, plan, manifest, report);
  } catch (error) {
    if (error instanceof PosterJobStoreError) throw error;
    throw new PosterJobStoreError('海报任务包损坏：元数据 JSON 无效', { cause: error });
  }
}

function ensureMutationRecord(next) {
  if (next === null || typeof next !== 'object' || Array.isArray(next)
    || next.plan === null || typeof next.plan !== 'object' || Array.isArray(next.plan)
    || next.manifest === null || typeof next.manifest !== 'object' || Array.isArray(next.manifest)) {
    throw new TypeError('mutation must return a poster job record');
  }
}

async function persistMutation(current, expectedVersion, mutation, { manifestPublicationHooks } = {}) {
  if (current.manifest.revision !== expectedVersion) throw new PosterJobConflictError();
  const next = await mutation(clone(current));
  ensureMutationRecord(next);
  const plan = clone(next.plan);
  const manifest = clone(next.manifest);
  manifest.revision = expectedVersion + 1;
  if (JSON.stringify(plan) !== JSON.stringify(current.plan)) {
    await atomicWriteJson(current.paths.plan, plan);
  }
  await atomicWriteJson(current.paths.manifest, manifest, {
    afterTemporarySynced: manifestPublicationHooks?.afterManifestTemporarySynced,
    afterRenamed: manifestPublicationHooks?.afterManifestRenamed,
    syncDirectory: manifestPublicationHooks?.syncManifestDirectory,
    afterParentSynced: manifestPublicationHooks?.afterManifestParentSynced,
  });
}

function normalizedCandidate(candidate, paths) {
  if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) {
    throw new TypeError('candidate must be an object');
  }
  const next = clone(candidate);
  requiredString(next.candidate_id, 'candidate.candidate_id');
  if (!Number.isInteger(next.layer_index) || next.layer_index < 1) {
    throw new TypeError('candidate.layer_index must be a positive integer');
  }
  const candidatePath = next.path ?? next.candidate_path;
  requiredString(candidatePath, 'candidate.path');
  const resolved = containedPath(paths.candidates,
    path.isAbsolute(candidatePath) ? candidatePath : path.join(paths.candidates, candidatePath), '候选文件');
  if (path.extname(resolved).toLowerCase() !== '.png') {
    throw new PosterJobPathError('候选文件必须是 PNG');
  }
  next.path = resolved;
  return next;
}

function temporaryPackagePath(outputRoot, jobId) {
  const jobsRoot = jobsDirectory(outputRoot);
  return containedPath(jobsRoot,
    path.join(jobsRoot, `.${assertJobId(jobId)}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`),
    '临时任务目录');
}

async function removeInterruptedPackages(outputRoot, jobId) {
  const jobsRoot = jobsDirectory(outputRoot);
  const prefix = `.${assertJobId(jobId)}.tmp-`;
  for (const entry of await readdir(jobsRoot, { withFileTypes: true })) {
    if (!entry.name.startsWith(prefix)) continue;
    const target = containedPath(jobsRoot, path.join(jobsRoot, entry.name), '中断临时任务目录');
    await rm(target, { recursive: true, force: true });
  }
}

export async function initializePosterJob({ outputRoot, jobId, sourcePath, plan, manifestTemplatePath }) {
  const paths = pathsFor(outputRoot, jobId);
  const safeJobId = assertJobId(jobId);
  const source = path.resolve(requiredString(sourcePath, 'sourcePath'));
  if (path.extname(source).toLowerCase() !== '.png') {
    throw new PosterJobPathError('sourcePath 必须是 PNG');
  }
  const sourceStat = await stat(source);
  if (!sourceStat.isFile()) throw new PosterJobPathError('sourcePath 必须是文件');
  const storedPlan = normalizedPlan(plan, paths, safeJobId);
  const template = await readManifestTemplate(manifestTemplatePath);
  const manifest = initializedManifest(template, storedPlan);
  const report = { revision: 1, status: 'INITIALIZED' };
  await assertSafeOutputRoot(outputRoot);

  return withDirectoryLock(lockPath(outputRoot, safeJobId), async () => {
    await ensureSafePosterJobsDirectory(outputRoot, { create: true });
    await removeInterruptedPackages(outputRoot, safeJobId);
    if (await exists(paths.root)) {
      try {
        const existing = await readPosterJobAt(paths);
        if (existing) throw new PosterJobPathError('海报任务已存在');
      } catch (error) {
        if (error instanceof PosterJobPathError) throw error;
        if (!(error instanceof PosterJobStoreError)) throw error;
      }
      await rm(paths.root, { recursive: true, force: true });
    }
    const temporaryPaths = pathsAt(temporaryPackagePath(outputRoot, safeJobId));
    try {
      await mkdir(temporaryPaths.root, { recursive: false });
      await Promise.all([mkdir(temporaryPaths.evidence), mkdir(temporaryPaths.candidates), mkdir(temporaryPaths.layers)]);
      await atomicCopy(source, temporaryPaths.source);
      await Promise.all([
        atomicWriteJson(temporaryPaths.plan, storedPlan),
        atomicWriteJson(temporaryPaths.manifest, manifest),
        atomicWriteJson(temporaryPaths.report, report),
      ]);
      await readPosterJobAt(temporaryPaths);
      await rename(temporaryPaths.root, paths.root);
      return readPosterJobAt(paths);
    } catch (error) {
      await rm(temporaryPaths.root, { recursive: true, force: true });
      throw error;
    }
  });
}

/** Initialize a local targeted-fast package without scheduling analysis. */
export async function initializePosterFastJob({ outputRoot, jobId, sourcePath, plan, manifestTemplatePath }) {
  if (plan?.planning_mode !== 'targeted_fast' || plan?.status !== 'PLAN_REVIEW') {
    throw new PosterJobStoreError('快速海报任务必须是待审核的 targeted_fast 计划');
  }
  return initializePosterJob({ outputRoot, jobId, sourcePath, plan, manifestTemplatePath });
}

/** Validate the persisted, self-verifying Task 1 snapshot for a fast
 * authorization.  Callers receive no authority from request/dispatch fields. */
export function assertPosterFastAuthorizationBinding(record, authorization) {
  if (authorization?.planning_mode !== 'targeted_fast') return false;
  const layerIndex = authorization.layer_index;
  const layer = record?.plan?.layers?.find((entry) => entry?.layer_index === layerIndex);
  const snapshot = layer?.confirmed_snapshot;
  const payload = snapshot && {
    job_id: snapshot.job_id, plan_version: snapshot.plan_version, layer_index: snapshot.layer_index,
    layer: snapshot.layer, source: snapshot.source,
  };
  if (!layer || !snapshot || snapshot.snapshot_id !== authorization.snapshot_id
    || snapshot.snapshot_id !== layer.snapshot_id || snapshot.user_confirmed !== true
    || snapshot.layer_index !== layerIndex || snapshot.plan_version !== record.plan.plan_version
    || snapshot.job_id !== record.plan.job_id || canonicalJson(snapshot.source) !== canonicalJson(record.plan.source)
    || digestCanonicalJson(payload) !== snapshot.snapshot_id
    || authorization.source_fingerprint !== digestCanonicalJson(record.plan.source)
    || !TARGETED_PROCESSING_CATEGORIES.has(snapshot.layer?.processing_category)
    || authorization.processing_category !== snapshot.layer.processing_category
    || authorization.snapshot_sha256 !== createHash('sha256').update(canonicalJson(snapshot)).digest('hex')) {
    throw new Error('targeted fast authorization snapshot or source binding is stale');
  }
  return true;
}

/** Poster-local journal binding. The generic foreground queue deliberately
 * permits extra fields; only this artifact authority interprets them. */
export async function assertPosterTargetedDispatchBinding(record, authorization, dispatchId) {
  if (authorization?.planning_mode !== 'targeted_fast') return false;
  if (typeof dispatchId !== 'string' || authorization.dispatch_id !== dispatchId
    || !Number.isInteger(authorization.reservation_manifest_revision)) {
    throw new Error('targeted fast dispatch revision or authorization is stale');
  }
  let dispatch;
  try {
    dispatch = JSON.parse(await readFile(path.join(record.paths.root, 'foreground-dispatches', `${dispatchId}.json`), 'utf8'));
  } catch {
    throw new Error('targeted fast dispatch journal is unavailable');
  }
  const expected = {
    dispatchId, taskKind: 'poster_candidate', layerIndex: authorization.layer_index,
    candidateNumber: authorization.candidate_number, authorizationId: authorization.authorization_id,
    planVersion: authorization.plan_version, planningMode: 'targeted_fast', snapshotId: authorization.snapshot_id,
    sourceFingerprint: authorization.source_fingerprint, manifestRevision: authorization.reservation_manifest_revision,
  };
  for (const [key, value] of Object.entries(expected)) {
    if (dispatch[key] !== value) throw new Error(`targeted fast dispatch ${key} is stale`);
  }
  assertPosterFastAuthorizationBinding(record, authorization);
  return true;
}

export async function readPosterJob(outputRoot, jobId) {
  if (!(await ensureSafePosterJobsDirectory(outputRoot))) return null;
  return readPosterJobAt(pathsFor(outputRoot, jobId));
}

export async function mutatePosterJob(outputRoot, jobId, expectedVersion, mutation) {
  if (!Number.isInteger(expectedVersion) || expectedVersion < 1) {
    throw new TypeError('expectedVersion must be a positive integer');
  }
  if (typeof mutation !== 'function') throw new TypeError('mutation must be a function');
  await assertSafeOutputRoot(outputRoot);
  return withDirectoryLock(lockPath(outputRoot, jobId), async () => {
    await ensureSafePosterJobsDirectory(outputRoot);
    const current = await readPosterJob(outputRoot, jobId);
    if (!current) throw new PosterJobPathError('海报任务不存在或不完整');
    await persistMutation(current, expectedVersion, mutation);
    return readPosterJob(outputRoot, jobId);
  });
}

export async function recordPosterCandidate(outputRoot, jobId, candidate) {
  await assertSafeOutputRoot(outputRoot);
  return withDirectoryLock(lockPath(outputRoot, jobId), async () => {
    await ensureSafePosterJobsDirectory(outputRoot);
    const current = await readPosterJob(outputRoot, jobId);
    if (!current) throw new PosterJobPathError('海报任务不存在或不完整');
    const savedCandidate = normalizedCandidate(candidate, current.paths);
    const expectedVersion = current.manifest.revision;
    await persistMutation(current, expectedVersion, (record) => ({
      ...record,
      manifest: {
        ...record.manifest,
        candidates: [...(Array.isArray(record.manifest.candidates) ? record.manifest.candidates : []), savedCandidate],
      },
    }));
    return readPosterJob(outputRoot, jobId);
  });
}

export async function recordPosterGenerationFailure({
  outputRoot,
  jobId,
  layerIndex,
  authorizationId,
  candidateNumber,
  planVersion,
  dispatchId,
  idempotent = false,
  error,
  failureCodes = ['GENERATION_FAILED'],
  candidateEvidence,
} = {}) {
  const targetIndex = positiveInteger(layerIndex, 'layerIndex');
  positiveInteger(candidateNumber, 'candidateNumber');
  positiveInteger(planVersion, 'planVersion');
  requiredString(authorizationId, 'authorizationId');
  const message = String(error?.message || error || 'poster candidate generation failed');
  const codes = Array.isArray(failureCodes) && failureCodes.length > 0
    ? [...new Set(failureCodes.map((code) => String(code)))] : ['GENERATION_FAILED'];
  if (candidateEvidence !== undefined && (candidateEvidence === null || typeof candidateEvidence !== 'object'
    || Array.isArray(candidateEvidence))) {
    throw new TypeError('candidateEvidence must be an object');
  }
  const record = await readPosterJob(outputRoot, jobId);
  if (!record) throw new PosterJobPathError('海报任务不存在或不完整');
  const initialAuthorization = (record.manifest.authorizations || []).find((entry) => entry?.authorization_id === authorizationId);
  if (dispatchId !== undefined && initialAuthorization?.dispatch_id !== dispatchId) {
    if (idempotent) return record;
    throw new Error('candidate generation failure dispatch is no longer current');
  }
  return mutatePosterJob(outputRoot, jobId, record.manifest.revision, async (current) => {
    if ((current.plan.status !== 'PLAN_CONFIRMED' && current.plan.status !== 'PLAN_REVIEW')
      || current.plan.plan_version !== planVersion) {
      throw new Error('candidate generation failure is stale');
    }
    const authorization = (current.manifest.authorizations || []).find((entry) => entry?.authorization_id === authorizationId);
    if (dispatchId !== undefined && authorization?.dispatch_id !== dispatchId) {
      if (idempotent) return current;
      throw new Error('candidate generation failure dispatch is no longer current');
    }
    const state = (current.manifest.layers || []).find((entry) => entry?.layer_index === targetIndex);
    if (authorization?.planning_mode === 'targeted_fast') assertPosterFastAuthorizationBinding(current, authorization);
    if (dispatchId !== undefined && authorization?.planning_mode === 'targeted_fast') {
      await assertPosterTargetedDispatchBinding(current, authorization, dispatchId);
    }
    if (current.plan.status === 'PLAN_REVIEW' && authorization?.planning_mode !== 'targeted_fast') {
      throw new Error('candidate generation failure requires PLAN_CONFIRMED');
    }
    const candidateId = `${current.plan.job_id}:layer-${targetIndex}:candidate-${String(candidateNumber).padStart(2, '0')}`;
    const failure = { event: 'GENERATION_FAILED', failure_codes: codes, message, at: new Date().toISOString() };
    const existingCandidate = (current.manifest.candidates || []).find((entry) => entry?.candidate_id === candidateId
      && entry?.layer_index === targetIndex && entry?.candidate_number === candidateNumber
      && entry?.plan_version === planVersion);
    const activeGeneration = authorization?.consumed === true && authorization?.finalized !== true
      && authorization.layer_index === targetIndex && authorization.candidate_number === candidateNumber
      && authorization.plan_version === planVersion && state?.status === 'GENERATING'
      && state.authorization_consumed === true && state.generation_count === candidateNumber;
    const recoverableReplay = Boolean(existingCandidate && authorization?.finalized === true
      && authorization.layer_index === targetIndex && authorization.candidate_number === candidateNumber
      && authorization.plan_version === planVersion && state?.generation_count === candidateNumber);
    if (!activeGeneration && !recoverableReplay) throw new Error('candidate generation failure is no longer current');
    if (codes.includes('IMAGEGEN_NO_PNG') && (candidateEvidence || existingCandidate?.path)) {
      throw new Error('IMAGEGEN_NO_PNG cannot relabel an existing candidate PNG');
    }
    let retainedCandidate = existingCandidate;
    if (candidateEvidence) {
      const sourcePath = path.resolve(requiredString(candidateEvidence.input_path, 'candidateEvidence.input_path'));
      const sourceEntry = await lstat(sourcePath);
      if (sourceEntry.isSymbolicLink() || !sourceEntry.isFile() || path.extname(sourcePath).toLowerCase() !== '.png') {
        throw new PosterJobPathError('失败候选必须是安全的 PNG 文件');
      }
      const expectedDigest = requiredSha256(candidateEvidence.candidate_sha256, '失败候选内容');
      if (await fileSha256(sourcePath) !== expectedDigest) throw new PosterJobConflictError('失败候选内容已变化');
      const planLayer = current.plan.layers.find((entry) => entry?.layer_index === targetIndex);
      if (!planLayer) throw new Error('candidate generation failure layer is missing');
      const targetPath = containedPath(current.paths.candidates, path.join(current.paths.candidates,
        candidateFileName({ layerIndex: targetIndex, slug: planLayer.layer_name, generationCount: candidateNumber })), '候选文件');
      const existingTarget = await lstatOrNull(targetPath);
      if (existingTarget) {
        if (existingTarget.isSymbolicLink() || !existingTarget.isFile() || await fileSha256(targetPath) !== expectedDigest) {
          throw new PosterJobConflictError('失败候选目标与已审核内容不一致');
        }
      } else {
        await atomicCopy(sourcePath, targetPath);
      }
      if (await fileSha256(targetPath) !== expectedDigest) throw new PosterJobConflictError('失败候选发布后内容已变化');
      retainedCandidate = {
        ...(existingCandidate || {}),
        candidate_id: candidateId, layer_index: targetIndex, candidate_number: candidateNumber,
        plan_version: planVersion, path: targetPath, candidate_sha256: expectedDigest,
        dimensions: clone(candidateEvidence.dimensions ?? null), review_report: candidateEvidence.review_report ?? null,
        release_gate: clone(candidateEvidence.release_gate ?? null), accepted: false,
      };
      failure.candidate_path = targetPath;
      failure.candidate_sha256 = expectedDigest;
      failure.key_findings = clone(candidateEvidence.key_findings ?? candidateEvidence.release_gate?.checks ?? null);
    }
    const inspectionPerformed = Boolean(retainedCandidate?.review_report && retainedCandidate?.release_gate);
    return {
      ...current,
      manifest: {
        ...current.manifest,
        candidates: existingCandidate
          ? current.manifest.candidates.map((entry) => entry === existingCandidate ? {
            ...retainedCandidate, status: 'HARD_REJECTED', failure_codes: codes, generation_error: message, accepted: false,
          } : entry)
          : [...(current.manifest.candidates || []), {
            ...(retainedCandidate || { candidate_id: candidateId, layer_index: targetIndex, candidate_number: candidateNumber,
              plan_version: planVersion }), status: 'HARD_REJECTED', failure_codes: codes,
            generation_error: message, accepted: false,
          }],
        authorizations: current.manifest.authorizations.map((entry) => entry.authorization_id === authorizationId ? {
          ...entry, finalized: true, finalized_at: failure.at, generation_failure: failure,
        } : entry),
        layers: current.manifest.layers.map((entry) => entry.layer_index === targetIndex ? {
          ...entry,
          status: 'HARD_REJECTED',
          candidate_output: retainedCandidate?.path ?? null,
          source_output: null,
          failure_codes: codes,
          generation_error: message,
          generation_failure: failure,
          visual_inspection: retainedCandidate ? {
            performed: inspectionPerformed, verdict: 'HARD_REJECTED', failure_codes: codes,
            checks: inspectionPerformed ? retainedCandidate.release_gate.checks ?? null : null, candidate_id: candidateId,
            plan_version: planVersion, candidate_sha256: retainedCandidate.candidate_sha256,
          } : { performed: false, verdict: 'HARD_REJECTED', failure_codes: codes },
        } : entry),
      },
    };
  });
}

function positiveInteger(value, label) {
  if (!Number.isInteger(value) || value < 1) throw new TypeError(`${label} must be a positive integer`);
  return value;
}

function pythonRuntime(environment = process.env) {
  const command = environment.IMVIA_LAYER_PYTHON_COMMAND || environment.PYTHON
    || (process.platform === 'win32' ? 'python' : 'python3');
  let args = [];
  try {
    const parsed = JSON.parse(environment.IMVIA_LAYER_PYTHON_ARGS || '[]');
    if (Array.isArray(parsed) && parsed.every((entry) => typeof entry === 'string')) args = parsed;
  } catch {
    args = [];
  }
  return { command, args };
}

function runPosterNormalizer({ input, output, width, height, fillColor, compositingMode }) {
  const python = pythonRuntime();
  const args = [
    ...python.args, NORMALIZER_PATH,
    '--input', input, '--output', output,
    '--source-width', String(width), '--source-height', String(height),
    '--fill-color', fillColor, '--compositing-mode', compositingMode,
  ];
  return new Promise((resolve, reject) => {
    const child = spawn(python.command, args, { shell: false, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      if (stderr.length < 16 * 1024) stderr += chunk.toString('utf8');
    });
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(stderr.trim() || `poster layer normalization exited with code ${code}`));
    });
  });
}

function runPosterAuditor(jobDirectory) {
  const python = pythonRuntime();
  const args = [...python.args, RECOMPOSITION_AUDITOR_PATH, '--job-directory', jobDirectory];
  return new Promise((resolve, reject) => {
    const child = spawn(python.command, args, { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      if (stdout.length < 1024 * 1024) stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk) => {
      if (stderr.length < 16 * 1024) stderr += chunk.toString('utf8');
    });
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code !== 0) {
        reject(new PosterJobStoreError(stderr.trim() || `poster recomposition audit exited with code ${code}`));
        return;
      }
      try {
        const report = JSON.parse(stdout);
        if (report === null || typeof report !== 'object' || Array.isArray(report)) {
          throw new Error('audit output must be an object');
        }
        resolve(report);
      } catch (error) {
        reject(new PosterJobStoreError('海报重组审计返回了无效报告', { cause: error }));
      }
    });
  });
}

function failureCodes(value) {
  return Array.isArray(value) ? value : [];
}

async function fileSha256(target) {
  return createHash('sha256').update(await readFile(target)).digest('hex');
}

function requiredSha256(value, label) {
  if (typeof value !== 'string' || !SHA256_PATTERN.test(value)) {
    throw new Error(`${label} SHA-256 绑定无效`);
  }
  return value;
}

function layerSlug(layer) {
  const candidateName = candidateFileName({ layerIndex: layer.layer_index, slug: layer.layer_name, generationCount: 1 });
  return candidateName.replace(/_candidate-01\.png$/u, '_source.png');
}

async function readPinnedContainedCandidate(root, target, { expectedDigest, afterDirectoryValidated } = {}) {
  const candidatePath = containedPath(root, target, '候选文件');
  const resolvedRoot = path.resolve(root);
  if (path.dirname(candidatePath) !== resolvedRoot) {
    throw new PosterJobPathError('候选文件必须直接位于 candidates 目录');
  }
  if (path.extname(candidatePath).toLowerCase() !== '.png') {
    throw new PosterJobPathError('候选文件必须是安全的 PNG 文件');
  }
  const rootIdentity = await lstat(resolvedRoot);
  if (rootIdentity.isSymbolicLink() || !rootIdentity.isDirectory()) {
    throw new PosterJobPathError('候选目录必须是安全的非符号链接目录');
  }
  const physicalRoot = await realpath(resolvedRoot);
  await afterDirectoryValidated?.({ candidatesRoot: resolvedRoot, candidatePath });
  let handle;
  try {
    handle = await open(candidatePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const openedIdentity = await handle.stat();
    if (!openedIdentity.isFile()) throw new PosterJobPathError('候选文件必须是安全的 PNG 文件');
    const [currentRoot, currentCandidate, physicalCandidate] = await Promise.all([
      lstat(resolvedRoot), lstat(candidatePath), realpath(candidatePath),
    ]);
    if (currentRoot.isSymbolicLink() || !currentRoot.isDirectory()
      || currentRoot.dev !== rootIdentity.dev || currentRoot.ino !== rootIdentity.ino
      || currentCandidate.isSymbolicLink() || !currentCandidate.isFile()
      || currentCandidate.dev !== openedIdentity.dev || currentCandidate.ino !== openedIdentity.ino
      || path.dirname(physicalCandidate) !== physicalRoot) {
      throw new PosterJobPathError('候选目录或文件在安全打开期间发生变化');
    }
    const bytes = await handle.readFile();
    const digest = createHash('sha256').update(bytes).digest('hex');
    if (expectedDigest !== undefined && digest !== expectedDigest) {
      throw new PosterJobStoreError('候选文件内容与审核时的 SHA-256 不匹配');
    }
    return { bytes, digest, identity: { dev: openedIdentity.dev, ino: openedIdentity.ino } };
  } catch (error) {
    if (error?.code === 'ELOOP') throw new PosterJobPathError('候选文件必须是安全的 PNG 文件');
    throw error;
  } finally {
    await handle?.close().catch(() => {});
  }
}

function assertPassingReleaseGate(candidate, state, expectedDigest) {
  const gate = candidate.release_gate;
  const checks = gate?.checks;
  if (gate?.verdict !== 'NEEDS_USER_REVIEW' || !Array.isArray(gate.failureCodes)
    || gate.failureCodes.length !== 0 || checks === null || typeof checks !== 'object'
    || Array.isArray(checks) || Object.keys(checks).length !== RELEASE_CHECK_KEYS.length
    || RELEASE_CHECK_KEYS.some((key) => checks[key] !== true)
    || gate.candidateId !== candidate.candidate_id || gate.planVersion !== candidate.plan_version
    || gate.candidateSha256 !== expectedDigest
    || state.visual_inspection?.candidate_sha256 !== expectedDigest) {
    throw new Error('候选 release gate 发布检查缺少精确绑定');
  }
}

function acceptanceBinding(record, layerIndex, requestedCandidateId) {
  if (record.plan.status !== 'PLAN_CONFIRMED' || !Number.isInteger(record.plan.plan_version)) {
    throw new Error('接受候选需要已确认的海报计划');
  }
  const planLayer = (record.plan.layers || []).find((entry) => entry?.layer_index === layerIndex);
  const state = (record.manifest.layers || []).find((entry) => entry?.layer_index === layerIndex);
  const candidate = (record.manifest.candidates || []).find((entry) => entry?.candidate_id === requestedCandidateId);
  if (!planLayer || !state) throw new Error('接受候选的图层不存在');
  const hardFailure = state.status === 'HARD_REJECTED' || candidate?.status === 'HARD_REJECTED'
    || state.visual_inspection?.verdict === 'HARD_REJECTED'
    || failureCodes(state.visual_inspection?.failure_codes).length > 0
    || failureCodes(candidate?.failure_codes).length > 0;
  if (hardFailure) throw new Error('硬失败候选不能接受');
  if (!candidate || candidate.layer_index !== layerIndex || state.candidate_output !== candidate.path) {
    throw new Error('接受的候选与当前图层不匹配');
  }
  if (state.status !== 'NEEDS_USER_REVIEW' || candidate.status !== 'NEEDS_USER_REVIEW'
    || state.visual_inspection?.performed !== true || state.visual_inspection?.verdict !== 'NEEDS_USER_REVIEW') {
    throw new Error('只有待用户审核的候选可以接受');
  }
  if (candidate.plan_version !== record.plan.plan_version) throw new Error('候选计划版本已过期');
  const expectedDigest = requiredSha256(candidate.candidate_sha256, '候选内容');
  if (!posterCandidateEligibility({ plan: record.plan, layer: state, candidate }).eligible) {
    throw new Error('候选 release gate 发布检查缺少精确绑定');
  }
  return { planLayer, state, candidate, expectedDigest };
}

function normalizedAcceptanceHooks(hooks) {
  if (hooks === undefined) return {};
  if (hooks === null || typeof hooks !== 'object' || Array.isArray(hooks)) {
    throw new TypeError('hooks must be an object');
  }
  for (const name of [
    'afterCandidateDirectoryValidated',
    'afterNormalized',
    'afterTargetPublished',
    'beforeCanonicalFileSynced',
    'afterCanonicalFileSynced',
    'afterCanonicalDirectorySynced',
    'afterCanonicalRollbackDirectorySynced',
    'afterManifestTemporarySynced',
    'afterManifestRenamed',
    'afterManifestParentSynced',
    'afterMetadataCommitted',
    'syncLayersDirectory',
    'syncManifestDirectory',
  ]) {
    if (hooks[name] !== undefined && typeof hooks[name] !== 'function') {
      throw new TypeError(`hooks.${name} must be a function`);
    }
  }
  return hooks;
}

async function assertCanonicalFile(layersRoot, targetPath, expectedDigest) {
  const safeTarget = containedPath(layersRoot, targetPath, '正式图层');
  let info;
  try {
    info = await lstat(safeTarget);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new PosterJobPathError('正式图层必须是安全的 PNG 文件');
  }
  const [physicalRoot, physicalTarget] = await Promise.all([realpath(layersRoot), realpath(safeTarget)]);
  if (!physicalTarget.startsWith(`${physicalRoot}${path.sep}`)) {
    throw new PosterJobPathError('正式图层超出允许目录');
  }
  if (await fileSha256(safeTarget) !== expectedDigest) {
    throw new PosterJobStoreError('正式图层内容与预期 SHA-256 不匹配');
  }
  return info;
}

function normalizedExportHooks(hooks) {
  if (hooks === undefined) return {};
  if (hooks === null || typeof hooks !== 'object' || Array.isArray(hooks)) {
    throw new TypeError('hooks must be an object');
  }
  for (const name of ['afterCandidateDirectoryValidated', 'afterCanonicalOpened']) {
    if (hooks[name] !== undefined && typeof hooks[name] !== 'function') {
      throw new TypeError(`hooks.${name} must be a function`);
    }
  }
  return hooks;
}

async function readPinnedRegularFile(targetPath, { label = '文件', expectedDigest, afterOpened } = {}) {
  let handle;
  try {
    handle = await open(targetPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch (error) {
    if (error.code === 'ELOOP') throw new PosterJobPathError(`${label}不能是符号链接`);
    throw error;
  }
  try {
    const details = await handle.stat();
    if (!details.isFile()) throw new PosterJobPathError(`${label}必须是安全的普通文件`);
    await afterOpened?.({ targetPath, identity: { dev: details.dev, ino: details.ino } });
    const bytes = await handle.readFile();
    const digest = createHash('sha256').update(bytes).digest('hex');
    if (expectedDigest !== undefined && digest !== expectedDigest) {
      throw new PosterJobStoreError(`${label}内容与预期 SHA-256 不匹配`);
    }
    return { bytes, digest, identity: { dev: details.dev, ino: details.ino } };
  } finally {
    await handle.close();
  }
}

async function ensureSafeHistoryDirectory(record) {
  const evidence = record.paths.evidence;
  const evidenceEntry = await lstatOrNull(evidence);
  if (!evidenceEntry || evidenceEntry.isSymbolicLink() || !evidenceEntry.isDirectory()) {
    throw new PosterJobPathError('evidence 目录必须是安全的非符号链接目录');
  }
  const physicalEvidence = await realpath(evidence);
  const physicalRoot = await realpath(record.paths.root);
  if (physicalEvidence !== path.join(physicalRoot, 'evidence')) {
    throw new PosterJobPathError('evidence 目录不在任务目录内');
  }
  const history = path.join(evidence, 'history');
  let created = false;
  try {
    await mkdir(history, { mode: 0o700 });
    created = true;
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  const historyEntry = await lstatOrNull(history);
  if (!historyEntry || historyEntry.isSymbolicLink() || !historyEntry.isDirectory()
    || await realpath(history) !== path.join(physicalEvidence, 'history')) {
    throw new PosterJobPathError('history 目录必须位于任务 evidence 内且不能是符号链接');
  }
  if (created) await fsyncDirectory(evidence);
  return history;
}

async function writeExclusiveNoFollow(targetPath, bytes) {
  let handle;
  try {
    handle = await open(targetPath,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle?.close();
  }
}

async function fsyncDirectory(directoryPath) {
  const handle = await open(directoryPath, fsConstants.O_RDONLY | (fsConstants.O_DIRECTORY || 0));
  try {
    const details = await handle.stat();
    if (!details.isDirectory()) throw new PosterJobPathError('持久化目标必须是目录');
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function acceptedReplay(record, layerIndex, candidateId) {
  const layer = (record.manifest.layers || []).find((entry) => entry?.layer_index === layerIndex);
  if (layer?.status !== 'ACCEPTED' || layer.accepted_candidate_id !== candidateId) return null;
  const candidate = (record.manifest.candidates || []).find((entry) => entry?.candidate_id === candidateId);
  const planLayer = (record.plan.layers || []).find((entry) => entry?.layer_index === layerIndex);
  if (!candidate || !planLayer || candidate.accepted !== true
    || layer.accepted_plan_version !== record.plan.plan_version
    || candidate.plan_version !== record.plan.plan_version) {
    throw new PosterJobStoreError('已接受图层的元数据绑定无效');
  }
  const candidateDigest = requiredSha256(candidate.candidate_sha256, '已接受候选内容');
  assertPassingReleaseGate(candidate, layer, candidateDigest);
  const expectedTarget = containedPath(record.paths.layers,
    path.join(record.paths.layers, layerSlug(planLayer)), '正式图层');
  const digest = requiredSha256(layer.source_sha256, '已接受正式图层');
  if (candidate.accepted_source_output !== expectedTarget || layer.source_output !== expectedTarget
    || candidate.accepted_source_sha256 !== digest) {
    throw new PosterJobStoreError('已接受图层的输出绑定无效');
  }
  await assertCanonicalFile(record.paths.layers, expectedTarget, digest);
  return record;
}

async function syncPinnedCanonicalFile(targetPath, expectedDigest, lifecycle) {
  let handle;
  try {
    handle = await open(targetPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const opened = await handle.stat();
    if (!opened.isFile()) throw new PosterJobPathError('正式图层必须是安全的普通文件');
    const current = await lstat(targetPath);
    if (current.isSymbolicLink() || !current.isFile()
      || current.dev !== opened.dev || current.ino !== opened.ino) {
      throw new PosterJobPathError('正式图层在持久化前发生变化');
    }
    const bytes = await handle.readFile();
    const digest = createHash('sha256').update(bytes).digest('hex');
    if (digest !== expectedDigest) {
      throw new PosterJobStoreError('正式图层内容与预期 SHA-256 不匹配');
    }
    const context = { targetPath, normalizedDigest: digest, identity: { dev: opened.dev, ino: opened.ino } };
    await lifecycle.beforeCanonicalFileSynced?.(context);
    await handle.sync();
    await lifecycle.afterCanonicalFileSynced?.(context);
    return context;
  } catch (error) {
    if (error?.code === 'ELOOP') throw new PosterJobPathError('正式图层不能是符号链接');
    throw error;
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function removeCreatedTarget(targetPath, identity, afterDirectorySynced) {
  if (!identity) return;
  try {
    const current = await lstat(targetPath);
    if (current.dev === identity.dev && current.ino === identity.ino) {
      await rm(targetPath, { force: true });
      await fsyncDirectory(path.dirname(targetPath));
      await afterDirectorySynced?.({ targetPath, identity: { dev: identity.dev, ino: identity.ino } });
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

export async function acceptPosterCandidate({
  outputRoot, jobId, layerIndex, candidateId, expectedRevision, hooks,
} = {}) {
  const targetIndex = positiveInteger(layerIndex, 'layerIndex');
  requiredString(candidateId, 'candidateId');
  positiveInteger(expectedRevision, 'expectedRevision');
  const lifecycle = normalizedAcceptanceHooks(hooks);
  await assertSafeOutputRoot(outputRoot);
  return withDirectoryLock(lockPath(outputRoot, jobId), async () => {
    await ensureSafePosterJobsDirectory(outputRoot);
    const current = await readPosterJob(outputRoot, jobId);
    if (!current) throw new PosterJobPathError('海报任务不存在或不完整');
    const replay = await acceptedReplay(current, targetIndex, candidateId);
    if (replay) return replay;
    if (current.manifest.revision !== expectedRevision) throw new PosterJobConflictError();

    const { planLayer, candidate, expectedDigest } = acceptanceBinding(current, targetIndex, candidateId);
    const targetPath = containedPath(current.paths.layers,
      path.join(current.paths.layers, layerSlug(planLayer)), '正式图层');
    const nonce = `${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}`;
    const snapshotPath = path.join(current.paths.layers, `.${path.basename(targetPath)}.${nonce}.candidate.png`);
    const normalizedPath = path.join(current.paths.layers, `.${path.basename(targetPath)}.${nonce}.normalized.png`);
    let createdTargetIdentity = null;
    let metadataCommitted = false;
    try {
      const pinnedCandidate = await readPinnedContainedCandidate(current.paths.candidates, candidate.path, {
        expectedDigest,
        afterDirectoryValidated: lifecycle.afterCandidateDirectoryValidated,
      });
      await writeFile(snapshotPath, pinnedCandidate.bytes, { flag: 'wx' });
      await runPosterNormalizer({
        input: snapshotPath, output: normalizedPath,
        width: current.plan.source.width, height: current.plan.source.height,
        fillColor: planLayer.fill_color, compositingMode: planLayer.compositing_mode,
      });
      const normalizedDigest = await fileSha256(normalizedPath);
      await lifecycle.afterNormalized?.({ candidatePath: snapshotPath, normalizedPath, normalizedDigest });

      const existing = await assertCanonicalFile(current.paths.layers, targetPath, normalizedDigest);
      if (!existing) {
        try {
          await link(normalizedPath, targetPath);
          createdTargetIdentity = await lstat(targetPath);
        } catch (error) {
          if (error.code !== 'EEXIST') throw error;
          await assertCanonicalFile(current.paths.layers, targetPath, normalizedDigest);
        }
      }
      await lifecycle.afterTargetPublished?.({ targetPath, normalizedDigest });
      await assertCanonicalFile(current.paths.layers, targetPath, normalizedDigest);
      await syncPinnedCanonicalFile(targetPath, normalizedDigest, lifecycle);
      await (lifecycle.syncLayersDirectory || fsyncDirectory)(current.paths.layers);
      await lifecycle.afterCanonicalDirectorySynced?.({ targetPath, normalizedDigest });

      const acceptedAt = new Date().toISOString();
      await persistMutation(current, expectedRevision, (record) => ({
        ...record,
        manifest: {
          ...record.manifest,
          candidates: record.manifest.candidates.map((entry) => entry.candidate_id === candidateId ? {
            ...entry, accepted: true, accepted_at: acceptedAt, accepted_source_output: targetPath,
            accepted_source_sha256: normalizedDigest,
          } : entry),
          layers: record.manifest.layers.map((entry) => entry.layer_index === targetIndex ? {
            ...entry,
            status: 'ACCEPTED', accepted_candidate_id: candidateId,
            accepted_plan_version: record.plan.plan_version, accepted_at: acceptedAt,
            source_output: targetPath, source_sha256: normalizedDigest,
            final_dimensions: { width: record.plan.source.width, height: record.plan.source.height },
          } : entry),
        },
      }), { manifestPublicationHooks: lifecycle });
      metadataCommitted = true;
      await lifecycle.afterMetadataCommitted?.({ targetPath, normalizedDigest });
      return readPosterJobAt(current.paths);
    } catch (error) {
      if (error?.posterJsonTargetPublished === current.paths.manifest) metadataCommitted = true;
      const simulatedProcessDeath = error?.code === 'SIMULATED_PROCESS_DEATH';
      if (!metadataCommitted && !simulatedProcessDeath) {
        await removeCreatedTarget(
          targetPath, createdTargetIdentity, lifecycle.afterCanonicalRollbackDirectorySynced,
        );
      }
      throw error;
    } finally {
      await Promise.all([
        rm(snapshotPath, { force: true }).catch(() => {}),
        rm(normalizedPath, { force: true }).catch(() => {}),
      ]);
    }
  });
}

export async function authorizePosterRetry({ outputRoot, jobId, layerIndex, expectedRevision } = {}) {
  const targetIndex = positiveInteger(layerIndex, 'layerIndex');
  positiveInteger(expectedRevision, 'expectedRevision');
  return mutatePosterJob(outputRoot, jobId, expectedRevision, (record) => {
    const targetedFast = record.plan.planning_mode === 'targeted_fast' && record.plan.status === 'PLAN_REVIEW';
    if ((!targetedFast && record.plan.status !== 'PLAN_CONFIRMED') || !Number.isInteger(record.plan.plan_version)) {
      throw new Error('重试需要已确认的海报计划');
    }
    const state = (record.manifest.layers || []).find((entry) => entry?.layer_index === targetIndex);
    if (!state) throw new Error('重试图层不存在');
    if (!['NEEDS_USER_REVIEW', 'HARD_REJECTED'].includes(state.status)) {
      throw new Error('只有审核中或硬失败图层可以授权重试');
    }
    return {
      ...record,
      manifest: {
        ...record.manifest,
        execution: {
          ...record.manifest.execution,
          user_authorized_retries: (record.manifest.execution?.user_authorized_retries || 0) + 1,
        },
        layers: record.manifest.layers.map((entry) => entry.layer_index === targetIndex ? (() => {
          const next = {
            ...entry,
            status: 'RETRY_AUTHORIZED', authorization_plan_version: record.plan.plan_version,
            authorization_consumed: false, candidate_output: null,
            visual_inspection: { performed: false, verdict: null, failure_codes: [] },
            review_note: null, source_output: null, final_dimensions: null,
          };
          delete next.failure_codes;
          delete next.generation_error;
          delete next.generation_failure;
          return next;
        })() : entry),
      },
    };
  });
}

export async function authorizePosterFastPostprocessRetry({ outputRoot, jobId, layerIndex, expectedRevision } = {}) {
  const targetIndex = positiveInteger(layerIndex, 'layerIndex');
  positiveInteger(expectedRevision, 'expectedRevision');
  return mutatePosterJob(outputRoot, jobId, expectedRevision, async (record) => {
    if (record.plan.planning_mode !== 'targeted_fast' || record.plan.status !== 'PLAN_REVIEW') {
      throw new Error('原 PNG 后处理仅支持快速定向海报任务');
    }
    const state = (record.manifest.layers || []).find((entry) => entry?.layer_index === targetIndex);
    const execution = state?.fast_execution;
    if (state?.status !== 'HARD_REJECTED' || execution?.recoverability !== 'postprocess_only') {
      throw new Error('当前项目不能仅重做后处理');
    }
    const rawPath = path.resolve(requiredString(execution.raw_candidate_path, 'raw_candidate_path'));
    const evidenceRoot = path.resolve(record.paths.evidence);
    const relative = path.relative(evidenceRoot, rawPath);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new PosterJobPathError('原始 PNG 不在任务 evidence 目录');
    const rawEntry = await lstat(rawPath);
    if (rawEntry.isSymbolicLink() || !rawEntry.isFile() || path.extname(rawPath).toLowerCase() !== '.png') {
      throw new PosterJobPathError('原始 PNG 不是安全的 PNG 文件');
    }
    const authorization = (record.manifest.authorizations || []).find((entry) => (
      entry?.authorization_id === execution.authorization_id
      && entry?.layer_index === targetIndex
      && entry?.candidate_number === state.generation_count
      && entry?.plan_version === record.plan.plan_version
      && entry?.consumed === true
      && entry?.finalized === true
    ));
    if (!authorization) throw new Error('原 PNG 后处理授权已失效');
    const duplicate = (record.manifest.candidates || []).find((entry) => (
      entry?.layer_index === targetIndex && entry?.candidate_number === state.generation_count
    ));
    if (duplicate?.path) throw new Error('已有候选 PNG，不能覆盖后重新处理');
    return {
      ...record,
      manifest: {
        ...record.manifest,
        execution: {
          ...record.manifest.execution,
          postprocess_retries: (record.manifest.execution?.postprocess_retries || 0) + 1,
        },
        candidates: (record.manifest.candidates || []).filter((entry) => entry !== duplicate),
        authorizations: record.manifest.authorizations.map((entry) => entry === authorization ? (() => {
          const next = { ...entry, finalized: false };
          delete next.finalized_at;
          delete next.generation_failure;
          return next;
        })() : entry),
        layers: record.manifest.layers.map((entry) => entry.layer_index === targetIndex ? (() => {
          const next = {
            ...entry,
            status: 'GENERATING',
            authorization_consumed: true,
            candidate_output: null,
            visual_inspection: { performed: false, verdict: null, failure_codes: [] },
            fast_execution: resumePosterFastPostprocess(execution),
          };
          delete next.failure_codes;
          delete next.generation_error;
          delete next.generation_failure;
          return next;
        })() : entry),
      },
    };
  });
}

function normalizedRemediationHooks(hooks) {
  if (hooks === undefined) return {};
  if (hooks === null || typeof hooks !== 'object' || Array.isArray(hooks)) {
    throw new TypeError('hooks must be an object');
  }
  for (const name of [
    'afterHistoryPublished',
    'afterHistoryMetadataFileSynced',
    'afterHistoryParentSynced',
    'afterCanonicalRenamed',
    'afterDestinationDirectorySynced',
    'afterSourceDirectorySynced',
    'afterCanonicalRelocated',
    'afterManifestTemporarySynced',
    'afterManifestRenamed',
    'afterManifestParentSynced',
    'afterMetadataCommitted',
    'syncDirectory',
    'syncManifestDirectory',
  ]) {
    if (hooks[name] !== undefined && typeof hooks[name] !== 'function') {
      throw new TypeError(`hooks.${name} must be a function`);
    }
  }
  return hooks;
}

async function committedAuditRemediationReplay(current, targetIndex, expectedRevision) {
  if (current.manifest.revision !== expectedRevision + 1) return null;
  const state = (current.manifest.layers || []).find((entry) => entry?.layer_index === targetIndex);
  const retryAuthorizationId = `audit-remediation:${current.plan.plan_version}:${expectedRevision}:${targetIndex}`;
  const histories = Array.isArray(state?.superseded_acceptances)
    ? state.superseded_acceptances.filter((entry) => entry?.superseded_manifest_revision === expectedRevision)
    : [];
  if (state?.status !== 'RETRY_AUTHORIZED' || state.retry_authorization_id !== retryAuthorizationId
    || state.authorization_plan_version !== current.plan.plan_version
    || state.authorization_consumed !== false || state.source_output !== null
    || state.source_sha256 !== null || histories.length !== 1) {
    throw new PosterJobConflictError('已提交的 remediation 重放绑定无效');
  }
  const history = histories[0];
  const digest = requiredSha256(history.source_sha256, '历史正式图层');
  const historyRoot = await ensureSafeHistoryDirectory(current);
  const expectedStem = `layer_${targetIndex}_revision_${expectedRevision}_${digest}`;
  const canonicalHistoryPath = containedPath(historyRoot, history.canonical_history_path, '历史正式图层');
  const metadataHistoryPath = containedPath(historyRoot, history.metadata_history_path, '历史元数据');
  if (canonicalHistoryPath !== path.join(historyRoot, `${expectedStem}.png`)
    || metadataHistoryPath !== path.join(historyRoot, `${expectedStem}.json`)
    || path.dirname(canonicalHistoryPath) !== historyRoot || path.dirname(metadataHistoryPath) !== historyRoot) {
    throw new PosterJobConflictError('已提交的 remediation 历史路径无效');
  }
  const canonicalPath = containedPath(current.paths.layers, history.source_output, '正式图层');
  if (path.dirname(canonicalPath) !== path.resolve(current.paths.layers)
    || await lstatOrNull(canonicalPath) !== null) {
    throw new PosterJobConflictError('已提交 remediation 后正式图层路径必须为空');
  }
  const [canonicalHistory, metadataHistory] = await Promise.all([
    readPinnedRegularFile(canonicalHistoryPath, { label: '历史正式图层', expectedDigest: digest }),
    readPinnedRegularFile(metadataHistoryPath, {
      label: '历史元数据', expectedDigest: requiredSha256(history.metadata_history_sha256, '历史元数据'),
    }),
  ]);
  let metadata;
  try {
    metadata = JSON.parse(metadataHistory.bytes.toString('utf8'));
  } catch (error) {
    throw new PosterJobConflictError('已提交的 remediation 历史元数据损坏');
  }
  const candidate = (current.manifest.candidates || []).find(
    (entry) => entry?.candidate_id === history.candidate_id,
  );
  if (canonicalHistory.digest !== digest || metadata?.schema_version !== 1
    || metadata.reason !== 'failed_recomposition_audit'
    || metadata.archived_at !== history.superseded_at
    || metadata.manifest_revision !== expectedRevision
    || metadata.plan_version !== current.plan.plan_version
    || metadata.layer?.layer_index !== targetIndex
    || metadata.layer?.accepted_candidate_id !== history.candidate_id
    || metadata.layer?.accepted_plan_version !== history.accepted_plan_version
    || metadata.layer?.source_output !== history.source_output
    || metadata.layer?.source_sha256 !== digest
    || metadata.candidate?.candidate_id !== history.candidate_id
    || metadata.candidate?.candidate_sha256 !== history.candidate_sha256
    || metadata.canonical?.path !== canonicalPath || metadata.canonical?.sha256 !== digest
    || !candidate || candidate.superseded !== true
    || candidate.candidate_sha256 !== history.candidate_sha256
    || candidate.superseded_at !== history.superseded_at
    || candidate.superseded_reason !== 'failed_recomposition_audit'
    || candidate.canonical_history_path !== canonicalHistoryPath
    || candidate.metadata_history_path !== metadataHistoryPath) {
    throw new PosterJobConflictError('已提交的 remediation 历史摘要不一致');
  }
  return current;
}

export async function reauthorizePosterAuditLayer({
  outputRoot, jobId, layerIndex, expectedRevision, hooks,
} = {}) {
  const targetIndex = positiveInteger(layerIndex, 'layerIndex');
  positiveInteger(expectedRevision, 'expectedRevision');
  const lifecycle = normalizedRemediationHooks(hooks);
  await assertSafeOutputRoot(outputRoot);
  return withDirectoryLock(lockPath(outputRoot, jobId), async () => {
    await ensureSafePosterJobsDirectory(outputRoot);
    const current = await readPosterJob(outputRoot, jobId);
    if (!current) throw new PosterJobPathError('海报任务不存在或不完整');
    const committedReplay = await committedAuditRemediationReplay(current, targetIndex, expectedRevision);
    if (committedReplay) return committedReplay;
    if (current.manifest.revision !== expectedRevision) throw new PosterJobConflictError();
    const audit = current.report?.recomposition_audit;
    if (audit?.status !== 'failed' || audit.binding?.manifest_revision !== expectedRevision
      || audit.binding?.plan_version !== current.plan.plan_version
      || !Array.isArray(audit.conflict_layers) || !audit.conflict_layers.includes(targetIndex)) {
      throw new PosterJobConflictError('只有当前失败审计中的冲突图层可以 remediation');
    }
    if (!canRunPosterAudit(current)) {
      throw new PosterJobConflictError('失败审计的接受候选绑定已过期');
    }
    const state = (current.manifest.layers || []).find((entry) => entry?.layer_index === targetIndex);
    const candidateId = state?.accepted_candidate_id;
    if (state?.status !== 'ACCEPTED' || typeof candidateId !== 'string') {
      throw new PosterJobConflictError('审计 remediation 仅适用于已接受图层');
    }
    const candidate = current.manifest.candidates.find((entry) => entry?.candidate_id === candidateId);
    const boundLayer = audit.binding.accepted_layers?.find((entry) => entry?.layer_index === targetIndex);
    if (!candidate || boundLayer?.candidate_id !== candidateId
      || boundLayer.candidate_sha256 !== candidate.candidate_sha256
      || boundLayer.candidate_output !== state.candidate_output
      || boundLayer.source_output !== state.source_output
      || boundLayer.source_sha256 !== state.source_sha256) {
      throw new PosterJobConflictError('失败审计的接受候选绑定已过期');
    }
    const canonicalPath = archiveLayerPath(current, state);
    const expectedCanonicalDigest = requiredSha256(state.source_sha256, '已接受正式图层');
    const historyRoot = await ensureSafeHistoryDirectory(current);
    const stem = `layer_${targetIndex}_revision_${expectedRevision}_${expectedCanonicalDigest}`;
    const canonicalHistoryPath = containedPath(historyRoot, path.join(historyRoot, `${stem}.png`), '历史正式图层');
    const metadataHistoryPath = containedPath(historyRoot, path.join(historyRoot, `${stem}.json`), '历史元数据');
    const [canonicalEntry, historyEntry, metadataEntry] = await Promise.all([
      lstatOrNull(canonicalPath), lstatOrNull(canonicalHistoryPath), lstatOrNull(metadataHistoryPath),
    ]);
    const recovering = canonicalEntry === null && historyEntry?.isFile() === true
      && !historyEntry.isSymbolicLink() && metadataEntry?.isFile() === true
      && !metadataEntry.isSymbolicLink();
    const dualVisible = canonicalEntry?.isFile() === true && !canonicalEntry.isSymbolicLink()
      && historyEntry?.isFile() === true && !historyEntry.isSymbolicLink()
      && metadataEntry?.isFile() === true && !metadataEntry.isSymbolicLink();
    const prepared = canonicalEntry?.isFile() === true && !canonicalEntry.isSymbolicLink()
      && historyEntry === null && metadataEntry?.isFile() === true && !metadataEntry.isSymbolicLink();
    const fresh = canonicalEntry?.isFile() === true && !canonicalEntry.isSymbolicLink()
      && historyEntry === null && metadataEntry === null;
    if (!fresh && !prepared && !dualVisible && !recovering) {
      throw new PosterJobConflictError('正式图层与 remediation 历史状态不一致');
    }
    const accepted = recovering
      ? await readPinnedRegularFile(canonicalHistoryPath, {
        label: '历史正式图层', expectedDigest: expectedCanonicalDigest,
      })
      : await readPinnedRegularFile(canonicalPath, {
        label: '正式图层', expectedDigest: expectedCanonicalDigest,
      });
    if (dualVisible) {
      await readPinnedRegularFile(canonicalHistoryPath, {
        label: '历史正式图层', expectedDigest: expectedCanonicalDigest,
      });
    }
    let archivedAt;
    let metadataBytes;
    if (recovering || prepared || dualVisible) {
      const pinnedMetadata = await readPinnedRegularFile(metadataHistoryPath, { label: '历史元数据' });
      let metadata;
      try {
        metadata = JSON.parse(pinnedMetadata.bytes.toString('utf8'));
      } catch (error) {
        throw new PosterJobConflictError('remediation 历史元数据损坏', { cause: error });
      }
      if (metadata?.schema_version !== 1 || metadata.reason !== 'failed_recomposition_audit'
        || metadata.manifest_revision !== expectedRevision || metadata.plan_version !== current.plan.plan_version
        || metadata.layer?.accepted_candidate_id !== candidateId
        || metadata.layer?.source_output !== canonicalPath
        || metadata.layer?.source_sha256 !== expectedCanonicalDigest
        || metadata.candidate?.candidate_id !== candidateId
        || metadata.candidate?.candidate_sha256 !== candidate.candidate_sha256
        || metadata.audit?.status !== 'failed'
        || JSON.stringify(metadata.audit?.binding) !== JSON.stringify(audit.binding)
        || metadata.canonical?.path !== canonicalPath
        || metadata.canonical?.sha256 !== expectedCanonicalDigest
        || typeof metadata.archived_at !== 'string') {
        throw new PosterJobConflictError('remediation 历史与接受绑定不一致');
      }
      archivedAt = metadata.archived_at;
      metadataBytes = pinnedMetadata.bytes;
    } else {
      archivedAt = new Date().toISOString();
      const metadata = {
        schema_version: 1,
        reason: 'failed_recomposition_audit',
        archived_at: archivedAt,
        manifest_revision: expectedRevision,
        plan_version: current.plan.plan_version,
        layer: clone(state),
        candidate: clone(candidate),
        audit: clone(audit),
        canonical: { path: canonicalPath, sha256: accepted.digest },
      };
      metadataBytes = Buffer.from(`${JSON.stringify(metadata, null, 2)}\n`);
    }
    const metadataDigest = createHash('sha256').update(metadataBytes).digest('hex');
    const historyRecord = {
      candidate_id: candidateId,
      candidate_sha256: candidate.candidate_sha256,
      source_output: canonicalPath,
      source_sha256: accepted.digest,
      accepted_plan_version: state.accepted_plan_version,
      accepted_at: state.accepted_at ?? null,
      superseded_at: archivedAt,
      superseded_manifest_revision: expectedRevision,
      canonical_history_path: canonicalHistoryPath,
      metadata_history_path: metadataHistoryPath,
      metadata_history_sha256: metadataDigest,
    };
    let metadataHistoryCreated = false;
    let historyPublished = recovering || dualVisible;
    let sourceRemoved = recovering;
    let metadataCommitted = false;
    try {
      const hookContext = {
        canonicalPath, canonicalHistoryPath, metadataHistoryPath, historyRecord,
      };
      const durableSync = lifecycle.syncDirectory || fsyncDirectory;
      if (fresh) {
        await writeExclusiveNoFollow(metadataHistoryPath, metadataBytes);
        metadataHistoryCreated = true;
        await lifecycle.afterHistoryMetadataFileSynced?.(hookContext);
        await lifecycle.afterHistoryPublished?.(hookContext);
      }
      if (fresh || prepared) {
        await durableSync(historyRoot);
        await lifecycle.afterHistoryParentSynced?.(hookContext);
        const currentCanonical = await lstat(canonicalPath);
        if (currentCanonical.isSymbolicLink() || !currentCanonical.isFile()
          || currentCanonical.dev !== accepted.identity.dev || currentCanonical.ino !== accepted.identity.ino) {
          throw new PosterJobConflictError('正式图层在 remediation 提交前发生变化');
        }
        await rename(canonicalPath, canonicalHistoryPath);
        historyPublished = true;
        sourceRemoved = true;
        await lifecycle.afterCanonicalRenamed?.(hookContext);
      }
      await durableSync(historyRoot);
      await lifecycle.afterDestinationDirectorySynced?.(hookContext);
      if (dualVisible) {
        const currentCanonical = await readPinnedRegularFile(canonicalPath, {
          label: '正式图层', expectedDigest: expectedCanonicalDigest,
        });
        if (currentCanonical.identity.dev !== accepted.identity.dev
          || currentCanonical.identity.ino !== accepted.identity.ino) {
          throw new PosterJobConflictError('正式图层在 remediation 恢复前发生变化');
        }
        await rm(canonicalPath);
        sourceRemoved = true;
      }
      await durableSync(current.paths.layers);
      await lifecycle.afterSourceDirectorySynced?.(hookContext);
      await lifecycle.afterCanonicalRelocated?.(hookContext);
      const retryAuthorizationId = `audit-remediation:${current.plan.plan_version}:${expectedRevision}:${targetIndex}`;
      await persistMutation(current, expectedRevision, (record) => ({
        ...record,
        manifest: {
          ...record.manifest,
          execution: {
            ...record.manifest.execution,
            user_authorized_retries: (record.manifest.execution?.user_authorized_retries || 0) + 1,
          },
          candidates: record.manifest.candidates.map((entry) => entry.candidate_id === candidateId ? {
            ...entry,
            superseded: true,
            superseded_at: archivedAt,
            superseded_reason: 'failed_recomposition_audit',
            canonical_history_path: canonicalHistoryPath,
            metadata_history_path: metadataHistoryPath,
          } : entry),
          layers: record.manifest.layers.map((entry) => entry.layer_index === targetIndex ? {
            ...entry,
            status: 'RETRY_AUTHORIZED',
            retry_authorization_id: retryAuthorizationId,
            authorization_plan_version: record.plan.plan_version,
            authorization_consumed: false,
            accepted_candidate_id: null,
            accepted_plan_version: null,
            accepted_at: null,
            candidate_output: null,
            source_output: null,
            source_sha256: null,
            final_dimensions: null,
            visual_inspection: { performed: false, verdict: null, failure_codes: [] },
            review_note: null,
            superseded_acceptances: [...(Array.isArray(entry.superseded_acceptances)
              ? entry.superseded_acceptances : []), historyRecord],
          } : entry),
        },
      }), { manifestPublicationHooks: lifecycle });
      metadataCommitted = true;
      await lifecycle.afterMetadataCommitted?.(hookContext);
      return readPosterJobAt(current.paths);
    } catch (error) {
      if (error?.posterJsonTargetPublished === current.paths.manifest) metadataCommitted = true;
      const simulatedProcessDeath = error?.code === 'SIMULATED_PROCESS_DEATH';
      if (!metadataCommitted && !simulatedProcessDeath) {
        if (sourceRemoved) {
          const [currentCanonical, currentHistory] = await Promise.all([
            lstatOrNull(canonicalPath), lstatOrNull(canonicalHistoryPath),
          ]);
          if (currentCanonical !== null || !currentHistory?.isFile() || currentHistory.isSymbolicLink()) {
            throw new PosterJobConflictError('remediation 回滚时正式图层状态不一致');
          }
          await rename(canonicalHistoryPath, canonicalPath);
          await fsyncDirectory(current.paths.layers);
          await fsyncDirectory(historyRoot);
          historyPublished = false;
          sourceRemoved = false;
        } else if (historyPublished) {
          const [currentCanonical, currentHistory] = await Promise.all([
            readPinnedRegularFile(canonicalPath, {
              label: '正式图层', expectedDigest: expectedCanonicalDigest,
            }),
            readPinnedRegularFile(canonicalHistoryPath, {
              label: '历史正式图层', expectedDigest: expectedCanonicalDigest,
            }),
          ]);
          if (currentCanonical.digest !== currentHistory.digest) {
            throw new PosterJobConflictError('remediation 回滚时双路径摘要不一致');
          }
          await rm(canonicalHistoryPath);
          await fsyncDirectory(historyRoot);
          historyPublished = false;
        }
        if (metadataHistoryCreated || recovering || prepared || dualVisible) {
          await rm(metadataHistoryPath, { force: true });
          await fsyncDirectory(historyRoot);
        }
      }
      throw error;
    }
  });
}

export async function runPosterRecompositionAudit({ outputRoot, jobId, expectedRevision } = {}) {
  positiveInteger(expectedRevision, 'expectedRevision');
  await assertSafeOutputRoot(outputRoot);
  return withDirectoryLock(lockPath(outputRoot, jobId), async () => {
    await ensureSafePosterJobsDirectory(outputRoot);
    const current = await readPosterJob(outputRoot, jobId);
    if (!current) throw new PosterJobPathError('海报任务不存在或不完整');
    if (current.manifest.revision !== expectedRevision) throw new PosterJobConflictError();
    if (!canRunPosterAudit(current)) throw new PosterJobConflictError('所有计划图层接受后才能运行重组审计');
    const rawReport = await runPosterAuditor(current.paths.root);
    const next = recordRecompositionAudit(current, rawReport);
    next.report = {
      ...next.report,
      revision: Number.isInteger(current.report?.revision) ? current.report.revision + 1 : 1,
      status: next.report.recomposition_audit.status === 'passed' ? 'AUDIT_PASSED' : 'AUDIT_FAILED',
    };
    await atomicWriteJson(current.paths.report, next.report);
    return readPosterJobAt(current.paths);
  });
}

function archiveLayerPath(record, layer) {
  if (typeof layer?.source_output !== 'string' || layer.source_output.length === 0) {
    throw new PosterJobConflictError('海报正式图层未通过审计，无法导出');
  }
  const target = path.isAbsolute(layer.source_output)
    ? layer.source_output
    : path.join(record.paths.root, layer.source_output);
  const safeTarget = containedPath(record.paths.layers, target, '正式图层');
  if (path.dirname(safeTarget) !== path.resolve(record.paths.layers)
    || path.extname(safeTarget).toLowerCase() !== '.png') {
    throw new PosterJobPathError('正式图层必须是 layers 根目录中的 PNG 文件');
  }
  return safeTarget;
}

export async function createPosterExportArchive({ outputRoot, jobId, hooks } = {}) {
  const lifecycle = normalizedExportHooks(hooks);
  await assertSafeOutputRoot(outputRoot);
  return withDirectoryLock(lockPath(outputRoot, jobId), async () => {
    await ensureSafePosterJobsDirectory(outputRoot);
    const record = await readPosterJob(outputRoot, jobId);
    if (!record) throw new PosterJobPathError('海报任务不存在或不完整');
    if (!canExportPosterPackage(record)) {
      throw new PosterJobConflictError('当前海报重组审计未通过或已过期，无法导出');
    }
    const entries = [];
    for (const [filename, targetPath, expectedDigest] of [
      ['source.png', record.paths.source, record.report.recomposition_audit.measurements?.source_sha256],
      ['poster-layer-plan.json', record.paths.plan, undefined],
      ['layer_manifest.json', record.paths.manifest, undefined],
      ['poster-execution-report.json', record.paths.report, undefined],
    ]) {
      entries.push([filename, (await readPinnedRegularFile(targetPath, { label: filename, expectedDigest })).bytes]);
    }
    const seenNames = new Set();
    for (const layer of record.manifest.layers) {
      const acceptedCandidate = record.manifest.candidates.find(
        (candidate) => candidate?.candidate_id === layer.accepted_candidate_id,
      );
      if (!acceptedCandidate) throw new PosterJobConflictError('已接受候选血缘缺失，无法导出');
      await readPinnedContainedCandidate(record.paths.candidates, acceptedCandidate.path, {
        expectedDigest: requiredSha256(acceptedCandidate.candidate_sha256, '已接受候选'),
        afterDirectoryValidated: lifecycle.afterCandidateDirectoryValidated,
      });
      const target = archiveLayerPath(record, layer);
      const filename = path.basename(target);
      if (seenNames.has(filename)) throw new PosterJobStoreError('正式图层归档文件名重复');
      seenNames.add(filename);
      const pinned = await readPinnedRegularFile(target, {
        label: '正式图层',
        expectedDigest: requiredSha256(layer.source_sha256, '已接受正式图层'),
        afterOpened: lifecycle.afterCanonicalOpened,
      });
      entries.push([`layers/${filename}`, pinned.bytes]);
    }
    return {
      bytes: Buffer.from(zipSync(Object.fromEntries(entries), { level: 0 })),
      fileName: `${assertJobId(jobId)}-poster-layers.zip`,
    };
  });
}
