import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readPosterPng, readPosterPngBytes } from '../poster-png.js';
import { runCommand } from '../../scripts/python-runtime.mjs';
import { assertProcessingPolicy } from './processing-policy.js';
import { prepareV2Item } from './execution-adapter.js';
import { freezeLayer } from './document.js';
import { semanticReviewAllowsDelivery } from './semantic-review.js';
import { digestCanonicalJson } from '../poster-plan.js';
import { validateScopedNativeRepair, scopedRepairRequestPath, withScopedAttemptLock } from './scoped-native-repair.js';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const pixelScript = path.join(repositoryRoot, 'scripts', 'v2-region-pixels.py');
const manifestIdentity = ['attemptId','dispatchId','authorizationId','snapshotId','sourceFingerprint'];
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const jsonClone = value => JSON.parse(JSON.stringify(value));

function contained(root, target, label) {
  const absoluteRoot = path.resolve(root); const absoluteTarget = path.resolve(target);
  if (!absoluteTarget.startsWith(`${absoluteRoot}${path.sep}`)) throw new Error(`${label}_PATH_ESCAPES_ROOT`);
  return absoluteTarget;
}
async function regularFile(root, target, label) {
  const resolved = contained(root, target, label); const info = await lstat(resolved);
  if (info.isSymbolicLink() || !info.isFile()) throw new Error(`${label}_MUST_BE_REGULAR_FILE`);
  const [realRoot, realTarget] = await Promise.all([realpath(root), realpath(resolved)]);
  if (!realTarget.startsWith(`${realRoot}${path.sep}`)) throw new Error(`${label}_SYMLINK_ESCAPE`);
  return resolved;
}
function attemptRoot(manifestPath) { return path.dirname(path.resolve(manifestPath)); }
async function readManifest(manifestPath) {
  const parsed = JSON.parse(await readFile(manifestPath, 'utf8'));
  if (parsed.schemaVersion !== 2 || !['extract_mask','reconstruct'].includes(parsed.route) || !parsed.envelope || !parsed.snapshot) throw new Error('INVALID_PROCESSING_MANIFEST');
  for (const field of manifestIdentity) if (!parsed.envelope[field]) throw new Error(`MANIFEST_BINDING_MISSING_${field.toUpperCase()}`);
  if (parsed.snapshot.snapshotId !== parsed.envelope.snapshotId || parsed.snapshot.source.fingerprint !== parsed.envelope.sourceFingerprint
    || parsed.snapshot.layerId !== parsed.envelope.layerId || parsed.snapshot.layerRevision !== parsed.envelope.layerRevision) throw new Error('MANIFEST_SNAPSHOT_BINDING_MISMATCH');
  const outputRoot = path.resolve(parsed.outputRoot || path.dirname(path.dirname(path.resolve(manifestPath))));
  for (const [field, optional] of [['selectedCropPath', false], ['outputPath', false], ['mappingPath', true], ['referencePath', true]]) {
    if (!parsed[field] && optional) continue;
    contained(outputRoot, parsed[field], field.toUpperCase());
  }
  return parsed;
}
async function readReview(reportPath, envelope) {
  if (!reportPath) throw new Error('REVIEW_REPORT_REQUIRED');
  const report = JSON.parse(await readFile(reportPath, 'utf8'));
  if (manifestIdentity.some(field => report[field] !== envelope[field])
    || !report.checks || !Object.keys(report.checks).length || !Object.values(report.checks).every(value => typeof value === 'boolean')) {
    throw new Error('REVIEW_REPORT_BINDING_MISMATCH');
  }
  if (!semanticReviewAllowsDelivery(report)) throw Object.assign(new Error('SEMANTIC_REVIEW_REJECTED'),
    { code: 'SEMANTIC_REVIEW_REJECTED', stage: 'semantic_review' });
  return report;
}
async function copyExclusive(source, target) { await copyFile(source, target, constants.COPYFILE_EXCL); }
function alphaExtrema(pixels) {
  let min = 255; let max = 0;
  for (let index = 3; index < pixels.length; index += 4) { min = Math.min(min, pixels[index]); max = Math.max(max, pixels[index]); }
  return { min, max };
}
async function configuredPython() {
  const configPath = path.join(os.homedir(), 'plugins', 'imvia-layer', 'imvia-layer-runtime.json');
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  if (!config.python?.command || !Array.isArray(config.python.args)) throw new Error('MANAGED_PYTHON_RUNTIME_MISSING');
  return config.python;
}
async function processRegion({ manifest, rawPath, mattePath, target, attemptDirectory, semanticTopology }) {
  const auditPath = path.join(attemptDirectory, `.pixel-audit-${process.pid}-${randomUUID()}.json`);
  const temporaryManifest = path.join(attemptDirectory, `.finalize-manifest-${process.pid}-${randomUUID()}.json`);
  const cliManifest = { ...manifest, outputPath: target, reportPath: auditPath, semanticTopology };
  await writeFile(temporaryManifest, `${JSON.stringify(cliManifest)}\n`, { flag: 'wx' });
  try {
    const python = await configuredPython();
    const result = await runCommand(python.command, [...python.args, pixelScript, '--manifest', temporaryManifest,
      '--raw', rawPath, ...(mattePath ? ['--matte', mattePath] : []), '--output', target], { cwd: repositoryRoot });
    return { audit: JSON.parse(result.stdout.trim()), auditPath };
  } catch (error) {
    try {
      const detail = JSON.parse(error.stderr?.trim());
      if (/^[A-Z][A-Z0-9_]+$/u.test(detail.code) && detail.stage === 'pixel_finalization') {
        error.code = detail.code; error.stage = detail.stage; error.message = detail.message;
      }
    } catch { /* Non-pixel subprocess failures keep their original diagnostics. */ }
    throw error;
  } finally {
    const { rm } = await import('node:fs/promises');
    await rm(temporaryManifest, { force: true });
  }
}

/** Finalize a processed region and archive a version immutably under its original attempt. */
export async function finalizeV2Candidate({ manifestPath, rawPath, mattePath = null, reportPath }) {
  return archiveProcessedCandidate({ manifestPath, rawPath, mattePath, reportPath });
}

async function archiveProcessedCandidate({ manifestPath, rawPath, mattePath = null, reportPath, revalidation = null }) {
  const manifest = await readManifest(manifestPath);
  const work = () => archiveProcessedCandidateUnlocked({manifestPath,rawPath,mattePath,reportPath,revalidation});
  return manifest.snapshot.strategy?.localRepairPolicy === 'scoped_once_v1'
    ? withScopedAttemptLock(manifest,work) : work();
}

async function archiveProcessedCandidateUnlocked({ manifestPath, rawPath, mattePath = null, reportPath, revalidation = null }) {
  const manifest = await readManifest(manifestPath);
  const processingPolicy = await assertProcessingPolicy(manifest);
  const root = path.resolve(manifest.outputRoot || path.dirname(path.dirname(path.resolve(manifestPath))));
  const attemptDirectory = attemptRoot(manifestPath);
  const raw = await regularFile(root, rawPath, 'RAW_CANDIDATE');
  const matte = mattePath ? await regularFile(root, mattePath, 'MATTE') : null;
  await regularFile(root, manifest.selectedCropPath, 'SELECTED_CROP');
  if (manifest.mappingPath) await regularFile(root, manifest.mappingPath, 'MAPPING');
  const report = await readReview(reportPath, manifest.envelope);
  const scopedNativeRepair = await validateScopedNativeRepair({ manifestPath, rawPath: raw, report });
  if (manifest.maskProvider === 'native_rgba') {
    const { nativeRgbaReviewPassed } = await import('./native-rgba-review.js');
    if (!nativeRgbaReviewPassed(report)) throw Object.assign(new Error('NATIVE_RGBA_REVIEW_REQUIRED'), { code: 'NATIVE_RGBA_REVIEW_REQUIRED' });
    if (matte) throw Object.assign(new Error('NATIVE_RGBA_SECOND_MATTE_FORBIDDEN'), { code: 'NATIVE_RGBA_SECOND_MATTE_FORBIDDEN' });
    if (report.rawSha256 !== hash(await readFile(raw))) throw Object.assign(new Error('NATIVE_RGBA_RAW_BINDING_MISMATCH'), { code: 'NATIVE_RGBA_RAW_BINDING_MISMATCH' });
  }
  if (manifest.semanticRequirements?.version === 1
    && (report.visualReview?.status !== 'passed' || !report.semanticTopology)) {
    throw Object.assign(new Error('SEMANTIC_REVIEW_REQUIRED'), { code: 'SEMANTIC_REVIEW_REQUIRED', stage: 'semantic_review' });
  }
  if (report.semanticTopology && (report.rawSha256 !== hash(await readFile(raw)) || (matte && matte !== raw))) {
    throw Object.assign(new Error('SEMANTIC_RAW_BINDING_MISMATCH'), { code: 'SEMANTIC_RAW_BINDING_MISMATCH', stage: 'semantic_review' });
  }
  const staged = path.join(attemptDirectory, `.region-${process.pid}-${randomUUID()}.png`);
  const { audit, auditPath } = await processRegion({ manifest: { ...manifest, scopedNativeRepair }, rawPath: raw, mattePath: matte, target: staged, attemptDirectory,
    semanticTopology: report.semanticTopology });
  try {
    const decoded = await readPosterPng(staged, 'V2 selected-region candidate');
    if (manifest.maskProvider === 'native_rgba' && audit.nativeAlignment?.status !== 'passed') {
      throw Object.assign(new Error('NATIVE_ALIGNMENT_REQUIRED'), { code: 'NATIVE_ALIGNMENT_REQUIRED' });
    }
    if (scopedNativeRepair) {
      await validateScopedNativeRepair({ manifestPath, rawPath: raw, report });
      if (!audit.scopedRepair?.outsideScopeRgbaIdentical || audit.scopedRepair.nativeAlignment?.status !== 'passed') throw new Error('REPAIR_PROTECTED_PIXELS_OR_ALIGNMENT_FAILED');
    }
    const { width, height } = manifest.snapshot.bounds;
    if (decoded.width !== width || decoded.height !== height || decoded.colorType !== 6) throw new Error('CANDIDATE_REGION_DIMENSIONS_MISMATCH');
    if (report.finalPreview && report.finalPreview.rgbaSha256 !== hash(decoded.pixels)) {
      throw Object.assign(new Error('FINAL_PREVIEW_MISMATCH'), { code: 'FINAL_PREVIEW_MISMATCH', stage: 'pixel_finalization' });
    }
    if (audit.width !== width || audit.height !== height || audit.placement.x !== manifest.snapshot.bounds.x || audit.placement.y !== manifest.snapshot.bounds.y) throw new Error('CANDIDATE_PLACEMENT_MISMATCH');
    const { min: alphaMin, max: alphaMax } = alphaExtrema(decoded.pixels);
    if (alphaMax === 0) throw new Error('ALL_TRANSPARENT');
    const versionId = randomUUID().replaceAll('-', '');
    const rootPath = path.resolve(manifest.outputRoot || root);
    const outputDirectory = path.join(rootPath, 'candidates', manifest.envelope.attemptId);
    const evidenceDirectory = path.join(rootPath, 'evidence', manifest.envelope.attemptId);
    await mkdir(outputDirectory, { recursive: true }); await mkdir(evidenceDirectory, { recursive: true });
    const pngPath = path.join(outputDirectory, `${versionId}.png`);
    const archivedRawPath = path.join(evidenceDirectory, `${versionId}.raw.png`);
    const archivedReviewPath = path.join(evidenceDirectory, `${versionId}.review.json`);
    const archivedAuditPath = path.join(evidenceDirectory, `${versionId}.pixel-audit.json`);
    await copyExclusive(staged, pngPath);
    await copyExclusive(raw, archivedRawPath);
    if (scopedNativeRepair) {
      await copyExclusive(scopedNativeRepair.rawPath, path.join(evidenceDirectory, `${versionId}.repair.raw.png`));
      await copyExclusive(scopedRepairRequestPath(manifest), path.join(evidenceDirectory, `${versionId}.repair.request.json`));
    }
    await writeFile(archivedReviewPath, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
    await writeFile(archivedAuditPath, `${JSON.stringify(audit, null, 2)}\n`, { flag: 'wx' });
    const pngBytes = await readFile(pngPath);
    const candidate = { versionId, attemptId: manifest.envelope.attemptId, batchId: manifest.envelope.batchId,
      documentId: manifest.envelope.documentId, layerId: manifest.envelope.layerId, dispatchId: manifest.envelope.dispatchId,
      authorizationId: manifest.envelope.authorizationId, snapshotId: manifest.envelope.snapshotId,
      sourceFingerprint: manifest.envelope.sourceFingerprint, layerRevision: manifest.envelope.layerRevision,
      pngPath, rawPath: archivedRawPath, reviewReportPath: archivedReviewPath, pixelAuditPath: archivedAuditPath,
      sha256: hash(pngBytes), width, height, alpha: { min: alphaMin, max: alphaMax, status: audit.status },
      placement: { x: manifest.snapshot.bounds.x, y: manifest.snapshot.bounds.y },
      mapping: manifest.mappingPath ? JSON.parse(await readFile(manifest.mappingPath, 'utf8')) : null,
      review: report, pixelAudit: audit, processingPolicy,
      ...(manifest.semanticRequirements ? { semanticRequirements: manifest.semanticRequirements } : {}),
      ...(revalidation ? { revalidation } : {}), createdAt: new Date().toISOString() };
    await writeFile(path.join(outputDirectory, `${versionId}.json`), `${JSON.stringify(candidate, null, 2)}\n`, { flag: 'wx' });
    return candidate;
  } finally {
    const { rm } = await import('node:fs/promises');
    await rm(staged, { force: true }); await rm(auditPath, { force: true });
  }
}

/** Local recovery of a completed archive, separate from generation/attempt finalization.
 * Rebuild trusted source inputs without rewriting the original manifest or attempt. */
export async function reprocessArchivedV2Candidate({ root, document, attempt, version, key }) {
  const original = await readManifest(await regularFile(root, path.join(root, 'attempts', attempt.attemptId, 'manifest.json'), 'ORIGINAL_MANIFEST'));
  const snapshot = freezeLayer(document, version.layerId);
  if (original.route !== 'extract_mask' || original.maskProvider !== 'imagegen_matte'
    || digestCanonicalJson(original.snapshot) !== digestCanonicalJson(snapshot)
    || [...manifestIdentity, 'documentId', 'layerId', 'layerRevision', 'batchId'].some(field => original.envelope[field] !== version[field])) {
    throw new Error('REVALIDATION_BINDING_MISMATCH');
  }
  const rawPath = await regularFile(root, version.rawPath, 'ARCHIVED_MATTE');
  const reportPath = await regularFile(root, version.reviewReportPath, 'ARCHIVED_REVIEW');
  const report = await readReview(reportPath, original.envelope);
  if (digestCanonicalJson(report) !== digestCanonicalJson(version.review)) throw new Error('REVALIDATION_REVIEW_CHANGED');
  const jobs = path.join(root, 'revalidations', 'work'); await mkdir(jobs, { recursive: true });
  const work = await mkdtemp(path.join(jobs, 'local-'));
  try {
    const manifest = await prepareV2Item({ document, snapshot, attempt, outputRoot: work });
    // Historical revalidation is not a new semantic inspection. Do not invent
    // a source-reviewed report or change an old generation contract in place.
    if (original.semanticRequirements) manifest.semanticRequirements = original.semanticRequirements;
    else delete manifest.semanticRequirements;
    const mapping = JSON.parse(await readFile(manifest.mappingPath));
    const oldMapping = JSON.parse(await readFile(await regularFile(root, original.mappingPath, 'ORIGINAL_MAPPING')));
    if (digestCanonicalJson(mapping) !== digestCanonicalJson(oldMapping)
      || digestCanonicalJson(mapping) !== digestCanonicalJson(version.mapping)) throw new Error('REVALIDATION_MAPPING_CHANGED');
    // Archive the new version in the same registry, but keep all prepared inputs isolated.
    manifest.outputRoot = path.resolve(root);
    const manifestPath = path.join(work, 'local-manifest.json');
    await writeFile(manifestPath, JSON.stringify(manifest), { flag: 'wx' });
    return await archiveProcessedCandidate({ manifestPath, rawPath, reportPath,
      revalidation: { key, originalVersionId: version.versionId, rawSha256: hash(await readFile(rawPath)), modelCalls: 0 } });
  } finally { await rm(work, { recursive: true, force: true }); }
}

/** End one original attempt on failure; never schedules an implicit retry. */
export async function finalizeV2Failure({ manifestPath, error, reportPath = null, rawPath = null }) {
  const manifest = await readManifest(manifestPath);
  const root = path.resolve(manifest.outputRoot || path.dirname(path.dirname(path.resolve(manifestPath))));
  let report = null; let reportBindingValid = false;
  if (reportPath) {
    try { report = JSON.parse(await readFile(await regularFile(root, reportPath, 'REVIEW_REPORT'), 'utf8')); reportBindingValid = manifestIdentity.every(field => report[field] === manifest.envelope[field]); }
    catch { report = null; }
  }
  const targetDirectory = path.join(root, 'failures', manifest.envelope.attemptId);
  await mkdir(targetDirectory, { recursive: true });
  let archivedRawPath = null;
  if (rawPath) {
    try {
      archivedRawPath = path.join(targetDirectory, 'raw-candidate.png');
      await copyExclusive(await regularFile(root, rawPath, 'RAW_CANDIDATE'), archivedRawPath);
    } catch { archivedRawPath = null; }
  }
  const failure = { attemptId: manifest.envelope.attemptId, batchId: manifest.envelope.batchId,
    documentId: manifest.envelope.documentId, layerId: manifest.envelope.layerId, layerRevision: manifest.envelope.layerRevision,
    dispatchId: manifest.envelope.dispatchId, authorizationId: manifest.envelope.authorizationId,
    snapshotId: manifest.envelope.snapshotId, sourceFingerprint: manifest.envelope.sourceFingerprint,
    delivery: 'sent', execution: 'failed', error: { code: String(error?.code || 'GENERATION_FAILED'), message: String(error?.message || error || 'failed'),
      ...(error?.stage ? { stage: String(error.stage) } : {}) },
    rawPath: archivedRawPath, review: report, reportBindingValid, failedAt: new Date().toISOString() };
  const failurePath = path.join(targetDirectory, 'failure.json');
  await writeFile(failurePath, `${JSON.stringify(failure, null, 2)}\n`, { flag: 'wx' });
  let reviewReportPath = null;
  if (report && reportPath) { reviewReportPath = path.join(targetDirectory, 'review.json'); await copyExclusive(await regularFile(root, reportPath, 'REVIEW_REPORT'), reviewReportPath); }
  return { ...failure, failurePath, reviewReportPath };
}

/** Read immutable candidate records only for attempts already bound to this document. */
export async function listV2CandidateVersions({ root, attempts, documentId, layerId = null }) {
  const versions = [];
  for (const attempt of attempts.filter(value => value.documentId === documentId && (!layerId || value.layerId === layerId))) {
    const directory = contained(root, path.join(root, 'candidates', attempt.attemptId), 'CANDIDATE_DIRECTORY');
    let files;
    try { files = await readdir(directory); }
    catch (cause) { if (cause.code === 'ENOENT') continue; throw cause; }
    for (const name of files.filter(value => /^[A-Za-z0-9_-]+\.json$/u.test(value))) {
      let version;
      try { version = JSON.parse(await readFile(await regularFile(root, path.join(directory, name), 'CANDIDATE_RECORD'), 'utf8')); }
      catch { continue; }
      if (version.versionId !== name.slice(0, -5) || version.attemptId !== attempt.attemptId
        || version.documentId !== documentId || version.layerId !== attempt.layerId
        || version.layerRevision !== attempt.layerRevision || version.dispatchId !== attempt.dispatchId
        || version.authorizationId !== attempt.authorizationId || version.snapshotId !== attempt.snapshotId
        || version.sourceFingerprint !== attempt.sourceFingerprint) continue;
      let artifactValid = false;
      try {
        const pngPath = await regularFile(root, version.pngPath, 'CANDIDATE_PNG');
        const bytes = await readFile(pngPath);
        const image = readPosterPngBytes(bytes, 'V2 candidate archive');
        artifactValid = image.width === version.width && image.height === version.height
          && image.colorType === 6 && hash(bytes) === version.sha256;
      } catch { artifactValid = false; }
      versions.push({ ...version, execution: attempt.execution, artifactValid });
    }
  }
  return versions.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

/** Resolve one version through its owning immutable attempt; arbitrary paths are never accepted. */
export async function readV2CandidatePng({ root, attempts, documentId, layerId, versionId }) {
  if (typeof versionId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/u.test(versionId)) throw new Error('INVALID_VERSION_ID');
  const versions = await listV2CandidateVersions({ root, attempts, documentId, layerId });
  const version = versions.find(value => value.versionId === versionId);
  if (!version) throw new Error('CANDIDATE_NOT_FOUND');
  if (!version.artifactValid) throw new Error('CANDIDATE_ARTIFACT_INVALID');
  return { version, bytes: await readFile(await regularFile(root, version.pngPath, 'CANDIDATE_PNG')) };
}
