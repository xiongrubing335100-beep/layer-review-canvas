import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { copyFile, lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readPosterPng } from '../poster-png.js';
import { runCommand } from '../../scripts/python-runtime.mjs';

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
async function processRegion({ manifest, rawPath, mattePath, target, attemptDirectory }) {
  const auditPath = path.join(attemptDirectory, `.pixel-audit-${process.pid}-${randomUUID()}.json`);
  const temporaryManifest = path.join(attemptDirectory, `.finalize-manifest-${process.pid}-${randomUUID()}.json`);
  const cliManifest = { ...manifest, outputPath: target, reportPath: auditPath };
  await writeFile(temporaryManifest, `${JSON.stringify(cliManifest)}\n`, { flag: 'wx' });
  try {
    const python = await configuredPython();
    const result = await runCommand(python.command, [...python.args, pixelScript, '--manifest', temporaryManifest,
      '--raw', rawPath, ...(mattePath ? ['--matte', mattePath] : []), '--output', target], { cwd: repositoryRoot });
    return { audit: JSON.parse(result.stdout.trim()), auditPath };
  } catch (error) {
    throw error;
  } finally {
    const { rm } = await import('node:fs/promises');
    await rm(temporaryManifest, { force: true });
  }
}

/** Finalize a processed region and archive a version immutably under its original attempt. */
export async function finalizeV2Candidate({ manifestPath, rawPath, mattePath = null, reportPath }) {
  const manifest = await readManifest(manifestPath);
  const root = path.resolve(manifest.outputRoot || path.dirname(path.dirname(path.resolve(manifestPath))));
  const attemptDirectory = attemptRoot(manifestPath);
  const raw = await regularFile(root, rawPath, 'RAW_CANDIDATE');
  const matte = mattePath ? await regularFile(root, mattePath, 'MATTE') : null;
  await regularFile(root, manifest.selectedCropPath, 'SELECTED_CROP');
  if (manifest.mappingPath) await regularFile(root, manifest.mappingPath, 'MAPPING');
  const report = await readReview(reportPath, manifest.envelope);
  const staged = path.join(attemptDirectory, `.region-${process.pid}-${randomUUID()}.png`);
  const { audit, auditPath } = await processRegion({ manifest, rawPath: raw, mattePath: matte, target: staged, attemptDirectory });
  try {
    const decoded = await readPosterPng(staged, 'V2 selected-region candidate');
    const { width, height } = manifest.snapshot.bounds;
    if (decoded.width !== width || decoded.height !== height || decoded.colorType !== 6) throw new Error('CANDIDATE_REGION_DIMENSIONS_MISMATCH');
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
      review: report, pixelAudit: audit, createdAt: new Date().toISOString() };
    await writeFile(path.join(outputDirectory, `${versionId}.json`), `${JSON.stringify(candidate, null, 2)}\n`, { flag: 'wx' });
    return candidate;
  } finally {
    const { rm } = await import('node:fs/promises');
    await rm(staged, { force: true }); await rm(auditPath, { force: true });
  }
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
    delivery: 'sent', execution: 'failed', error: { code: String(error?.code || 'GENERATION_FAILED'), message: String(error?.message || error || 'failed') },
    rawPath: archivedRawPath, review: report, reportBindingValid, failedAt: new Date().toISOString() };
  const failurePath = path.join(targetDirectory, 'failure.json');
  await writeFile(failurePath, `${JSON.stringify(failure, null, 2)}\n`, { flag: 'wx' });
  let reviewReportPath = null;
  if (report && reportPath) { reviewReportPath = path.join(targetDirectory, 'review.json'); await copyExclusive(await regularFile(root, reportPath, 'REVIEW_REPORT'), reviewReportPath); }
  return { ...failure, failurePath, reviewReportPath };
}
