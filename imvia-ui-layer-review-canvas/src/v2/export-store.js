import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import lockfile from 'proper-lockfile';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { getCompositionLayers } from './candidate-review.js';
import { checkPsdBudget, inspectPsd } from './psd-codec.mjs';
import { runCommand } from '../../scripts/python-runtime.mjs';
import { readPosterPngBytes } from '../poster-png.js';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const exportScript = path.join(repositoryRoot, 'scripts', 'export-v2-psd.mjs');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

export function validateExportPngBytes(bytes, layer) {
  if (digest(bytes) !== layer.sha256) throw new Error('EXPORT_CANDIDATE_HASH_MISMATCH');
  const decoded = readPosterPngBytes(bytes, 'V2 PSD candidate');
  if (decoded.colorType !== 6 || decoded.width !== layer.width || decoded.height !== layer.height) throw new Error('EXPORT_CANDIDATE_DIMENSIONS_MISMATCH');
  return decoded;
}

const clone = value => structuredClone(value);
function deepFreeze(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(deepFreeze); Object.freeze(value); }
  return value;
}

/** Freeze an export at a single document revision; only explicitly adopted current PNGs qualify. */
export function freezeExport({ document, versions, availableMemory = undefined }) {
  if (!document || !Array.isArray(document.layerOrder) || !document.layerOrder.length) throw new Error('EXPORT_NO_ACTIVE_LAYERS');
  const byId = new Map(versions.map(version => [version.versionId, version]));
  for (const layerId of document.layerOrder) {
    const definition = document.layers[layerId];
    const candidate = definition?.acceptedVersionId ? byId.get(definition.acceptedVersionId) : null;
    if (!candidate) throw new Error(`EXPORT_LAYER_NOT_ADOPTED:${definition?.name || layerId}`);
    if (candidate.width !== definition.bounds.width || candidate.height !== definition.bounds.height
      || candidate.placement?.x !== definition.bounds.x || candidate.placement?.y !== definition.bounds.y) {
      throw new Error('EXPORT_CANDIDATE_DIMENSIONS_MISMATCH');
    }
    if (!/^[a-f0-9]{64}$/iu.test(candidate.sha256 || '')) throw new Error('EXPORT_CANDIDATE_HASH_INVALID');
    if (candidate.blendMode && candidate.blendMode !== 'normal') throw new Error('UNSUPPORTED_BLEND_MODE');
  }
  const layers = getCompositionLayers(document, versions);
  if (layers.length !== document.layerOrder.length) throw new Error('EXPORT_LAYER_NOT_ADOPTED');
  const frozen = layers.map(layer => {
    const candidate = byId.get(layer.versionId);
    if (candidate.blendMode && candidate.blendMode !== 'normal') throw new Error('UNSUPPORTED_BLEND_MODE');
    if (!/^[a-f0-9]{64}$/iu.test(candidate.sha256 || '')) throw new Error('EXPORT_CANDIDATE_HASH_INVALID');
    const definition = document.layers[layer.layerId];
    if (candidate.width !== definition.bounds.width || candidate.height !== definition.bounds.height
      || candidate.placement?.x !== definition.bounds.x || candidate.placement?.y !== definition.bounds.y) {
      throw new Error('EXPORT_CANDIDATE_DIMENSIONS_MISMATCH');
    }
    if (candidate.sourceFingerprint !== document.source.fingerprint || candidate.layerRevision !== definition.layerRevision
      || candidate.execution !== 'suggested' || candidate.artifactValid !== true || Number(candidate.alpha?.max) <= 0) {
      throw new Error(`EXPORT_CANDIDATE_STALE:${definition.name}`);
    }
    return { layerId: layer.layerId, versionId: layer.versionId, name: layer.name, order: layer.order,
      pngPath: candidate.pngPath, sha256: candidate.sha256, width: candidate.width, height: candidate.height,
      placement: { ...candidate.placement }, blendMode: 'normal' };
  });
  checkPsdBudget({ width: document.source.width, height: document.source.height,
    layers: frozen.map(layer => ({ image: { width: layer.width, height: layer.height } })), availableMemory });
  const snapshot = { schemaVersion: 1, exportId: randomUUID().replaceAll('-', ''), documentId: document.documentId,
    documentRevision: document.revision, sourceFingerprint: document.source.fingerprint,
    width: document.source.width, height: document.source.height, background: 'transparent',
    layers: frozen, createdAt: new Date().toISOString() };
  return deepFreeze(clone(snapshot));
}

export function createExportStore({ root, runExport = null, availableMemory = undefined }) {
  const base = path.resolve(root);
  const directory = documentId => path.join(base, 'exports', documentId);
  const run = runExport || ((snapshotPath, outputPath) => runCommand(process.execPath,
    [exportScript, '--snapshot', snapshotPath, '--output', outputPath], { cwd: repositoryRoot }));
  return {
    async exportDocumentPsd({ document, versions, expectedRevision }) {
      if (document.revision !== expectedRevision) throw Object.assign(new Error('REVISION_CONFLICT'), { code: 'REVISION_CONFLICT' });
      const exportSnapshot = freezeExport({ document, versions, availableMemory });
      const targetDirectory = directory(document.documentId);
      await mkdir(targetDirectory, { recursive: true });
      const release = await lockfile.lock(targetDirectory, { realpath: false, retries: { retries: 20, minTimeout: 5, maxTimeout: 50 } });
      const staging = path.join(targetDirectory, `.staging-${exportSnapshot.exportId}`);
      const finalPsd = path.join(targetDirectory, `${exportSnapshot.exportId}.psd`);
      const finalRecord = path.join(targetDirectory, `${exportSnapshot.exportId}.json`);
      try {
        await mkdir(staging, { recursive: false });
        const snapshotPath = path.join(staging, 'snapshot.json');
        const tempPsd = path.join(staging, 'export.psd');
        await writeFile(snapshotPath, `${JSON.stringify({ ...exportSnapshot, outputRoot: base })}\n`, { flag: 'wx' });
        const result = await run(snapshotPath, tempPsd);
        const report = JSON.parse(result.stdout.trim());
        const bytes = await readFile(tempPsd);
        const parsed = inspectPsd(bytes, availableMemory === undefined ? undefined : { availableMemory });
        if (report.exportId !== exportSnapshot.exportId || report.documentRevision !== exportSnapshot.documentRevision
          || report.sha256 !== digest(bytes) || parsed.width !== exportSnapshot.width || parsed.height !== exportSnapshot.height
          || parsed.layers.length !== exportSnapshot.layers.length) throw new Error('PSD_EXPORT_READBACK_MISMATCH');
        const record = { ...report, status: 'complete', fileName: `${exportSnapshot.exportId}.psd`,
          createdAt: exportSnapshot.createdAt, sourceFingerprint: exportSnapshot.sourceFingerprint };
        await rename(tempPsd, finalPsd);
        try {
          const tempRecord = path.join(staging, 'export.json');
          await writeFile(tempRecord, `${JSON.stringify(record, null, 2)}\n`, { flag: 'wx' });
          await rename(tempRecord, finalRecord);
        } catch (cause) { await rm(finalPsd, { force: true }); throw cause; }
        return record;
      } finally {
        await rm(staging, { recursive: true, force: true });
        await release();
      }
    },
    async list(documentId, currentRevision = null) {
      let names;
      try { names = await readdir(directory(documentId)); } catch (cause) { if (cause.code === 'ENOENT') return []; throw cause; }
      const records = [];
      for (const name of names.filter(value => /^[a-f0-9]{32}\.json$/iu.test(value))) {
        try {
          const record = JSON.parse(await readFile(path.join(directory(documentId), name), 'utf8'));
          if (record.documentId === documentId && record.status === 'complete' && record.exportId === name.slice(0, -5)) {
            const { fileName, ...safe } = record;
            records.push({ ...safe, downloadUrl: `/api/workbench-v2/documents/${encodeURIComponent(documentId)}/exports/${encodeURIComponent(record.exportId)}/download`,
              stale: currentRevision !== null && record.documentRevision !== currentRevision });
          }
        } catch { /* ignore incomplete or invalid records */ }
      }
      return records.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    },
    async readPsd(documentId, exportId) {
      if (!/^[a-f0-9]{32}$/iu.test(exportId || '')) throw Object.assign(new Error('EXPORT_NOT_FOUND'), { code: 'EXPORT_NOT_FOUND' });
      const targetDirectory = directory(documentId);
      const record = JSON.parse(await readFile(path.join(targetDirectory, `${exportId}.json`), 'utf8'));
      if (record.exportId !== exportId || record.documentId !== documentId || record.status !== 'complete') throw Object.assign(new Error('EXPORT_NOT_FOUND'), { code: 'EXPORT_NOT_FOUND' });
      const bytes = await readFile(path.join(targetDirectory, `${exportId}.psd`));
      if (digest(bytes) !== record.sha256 || bytes.subarray(0, 4).toString() !== '8BPS') throw Object.assign(new Error('EXPORT_ARTIFACT_INVALID'), { code: 'EXPORT_ARTIFACT_INVALID' });
      return { record, bytes };
    },
  };
}
