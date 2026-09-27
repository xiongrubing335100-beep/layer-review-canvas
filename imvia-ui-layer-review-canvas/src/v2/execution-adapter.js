import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { deflateSync } from 'node:zlib';
import { digestCanonicalJson } from '../poster-plan.js';
import { readPosterPngBytes } from '../poster-png.js';
import { processingCategories } from './document.js';

const REFERENCE = { width: 1536, height: 1024 };
const channelsByColorType = { 2: 3, 6: 4 };
const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  return crc >>> 0;
});
const crc32 = data => { let crc = 0xffffffff; for (const byte of data) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8); return (crc ^ 0xffffffff) >>> 0; };
function pngChunk(type, data) {
  const name = Buffer.from(type); const payload = Buffer.concat([name, data]); const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4); checksum.writeUInt32BE(crc32(payload)); return Buffer.concat([length, payload, checksum]);
}
function encodePng(width, height, channels, pixels) {
  if (![3, 4].includes(channels) || pixels.length !== width * height * channels) throw new Error('INVALID_RGBA_IMAGE');
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = channels === 4 ? 6 : 2;
  const rows = Buffer.alloc((width * channels + 1) * height);
  for (let y = 0; y < height; y++) Buffer.from(pixels.buffer, pixels.byteOffset + y * width * channels, width * channels).copy(rows, y * (width * channels + 1) + 1);
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), pngChunk('IHDR', ihdr), pngChunk('IDAT', deflateSync(rows)), pngChunk('IEND', Buffer.alloc(0))]);
}
function safeChild(root, ...parts) {
  const base = path.resolve(root); const target = path.resolve(base, ...parts);
  if (!target.startsWith(`${base}${path.sep}`)) throw new Error('OUTPUT_PATH_ESCAPES_ROOT');
  return target;
}
function assertId(value, label) { if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(value)) throw new Error(`INVALID_${label.toUpperCase()}`); }
function snapshotDigest(snapshot) {
  const { source, layerId, layerRevision, bounds, paths, requirements, processingCategory, strategy } = snapshot;
  return digestCanonicalJson({ source, layerId, layerRevision, bounds, paths, requirements, processingCategory, strategy });
}
function assertBindings(document, snapshot, attempt) {
  if (!document || !['poster', 'h5'].includes(document.mode) || typeof document.documentId !== 'string') throw new Error('INVALID_DOCUMENT_BINDING');
  if (!snapshot || snapshot.snapshotId !== snapshotDigest(snapshot)) throw new Error('SNAPSHOT_DIGEST_MISMATCH');
  if (!processingCategories.includes(snapshot.processingCategory)) throw new Error('INVALID_PROCESSING_CATEGORY');
  if (!attempt || !['attemptId','batchId','documentId','layerId','layerRevision','dispatchId','authorizationId','snapshotId','sourceFingerprint'].every(key => attempt[key] !== undefined)) throw new Error('INVALID_ATTEMPT_BINDING');
  for (const field of ['attemptId','batchId','documentId','layerId','layerRevision','snapshotId','sourceFingerprint']) assertId(String(attempt[field]), field);
  if (attempt.documentId !== document.documentId || attempt.layerId !== snapshot.layerId || attempt.layerRevision !== snapshot.layerRevision
    || attempt.snapshotId !== snapshot.snapshotId || attempt.sourceFingerprint !== snapshot.source.fingerprint
    || !attempt.dispatchId || !attempt.authorizationId
    || (attempt.legacyEnvelope?.dispatchId && attempt.legacyEnvelope.dispatchId !== attempt.dispatchId)
    || (attempt.legacyEnvelope?.authorizationId && attempt.legacyEnvelope.authorizationId !== attempt.authorizationId)) throw new Error('ATTEMPT_SNAPSHOT_MISMATCH');
  if (snapshot.source.fingerprint !== document.source.fingerprint || snapshot.source.width !== document.source.width
    || snapshot.source.height !== document.source.height || path.resolve(snapshot.source.path) !== path.resolve(document.source.path)) {
    throw new Error('SOURCE_FINGERPRINT_MISMATCH');
  }
  const { x, y, width, height } = snapshot.bounds;
  if (![x,y,width,height].every(Number.isSafeInteger) || x < 0 || y < 0 || width < 1 || height < 1
    || x + width > snapshot.source.width || y + height > snapshot.source.height) throw new Error('INVALID_SNAPSHOT_BOUNDS');
}
function routeFor(snapshot) {
  const { operation, removeBackground } = snapshot.strategy;
  if (operation === 'reconstruct') return { route: 'reconstruct', maskProvider: removeBackground ? 'bria' : 'generated_region', maximumImagegenCalls: 1, needsReference: true };
  if (operation !== 'extract') throw new Error('INVALID_OPERATION');
  if (!removeBackground) return { route: 'extract_mask', maskProvider: 'selection', maximumImagegenCalls: 0, needsReference: false };
  if (['text', 'brand_ui'].includes(snapshot.processingCategory)) return { route: 'extract_mask', maskProvider: 'imagegen_matte', maximumImagegenCalls: 1, needsReference: true };
  return { route: 'extract_mask', maskProvider: 'bria', maximumImagegenCalls: 0, needsReference: false };
}
function cropRgba(image, bounds) {
  const channels = channelsByColorType[image.colorType]; const rgba = Buffer.alloc(bounds.width * bounds.height * 4);
  for (let y = 0; y < bounds.height; y++) for (let x = 0; x < bounds.width; x++) {
    const sourceOffset = ((bounds.y + y) * image.width + bounds.x + x) * channels; const targetOffset = (y * bounds.width + x) * 4;
    rgba[targetOffset] = image.pixels[sourceOffset]; rgba[targetOffset + 1] = image.pixels[sourceOffset + 1]; rgba[targetOffset + 2] = image.pixels[sourceOffset + 2];
    rgba[targetOffset + 3] = channels === 4 ? image.pixels[sourceOffset + 3] : 255;
  }
  return rgba;
}
function referenceFor(crop, bounds) {
  const padding = Math.ceil(Math.min(REFERENCE.width, REFERENCE.height) * 0.06);
  const scale = Math.min((REFERENCE.width - padding * 2) / bounds.width, (REFERENCE.height - padding * 2) / bounds.height);
  const width = Math.max(1, Math.min(REFERENCE.width - padding * 2, Math.round(bounds.width * scale)));
  const height = Math.max(1, Math.min(REFERENCE.height - padding * 2, Math.round(bounds.height * scale)));
  const x = Math.floor((REFERENCE.width - width) / 2); const y = Math.floor((REFERENCE.height - height) / 2);
  const canvas = Buffer.alloc(REFERENCE.width * REFERENCE.height * 4); canvas.fill(20);
  for (let i = 3; i < canvas.length; i += 4) canvas[i] = 255;
  for (let dy = 0; dy < height; dy++) for (let dx = 0; dx < width; dx++) {
    const sx = Math.min(bounds.width - 1, Math.floor((dx + 0.5) * bounds.width / width));
    const sy = Math.min(bounds.height - 1, Math.floor((dy + 0.5) * bounds.height / height));
    const from = (sy * bounds.width + sx) * 4; const to = ((y + dy) * REFERENCE.width + x + dx) * 4;
    crop.copy(canvas, to, from, from + 4);
  }
  const mapping = { version: 1, coordinateSpace: 'selected_region_pixels', sampling: 'nearest_pixel_center', canvas: REFERENCE,
    contentRegion: { x, y, width, height }, sourceRegion: { width: bounds.width, height: bounds.height }, sourcePlacement: { x: bounds.x, y: bounds.y } };
  return { image: encodePng(REFERENCE.width, REFERENCE.height, 4, canvas), mapping };
}

/** Bind one frozen V2 snapshot to a deterministic, region-sized processing input. */
export async function prepareV2Item({ document, snapshot, attempt, outputRoot }) {
  assertBindings(document, snapshot, attempt);
  if (typeof outputRoot !== 'string' || !path.isAbsolute(outputRoot)) throw new Error('OUTPUT_ROOT_MUST_BE_ABSOLUTE');
  const sourceBytes = await readFile(snapshot.source.path);
  if (createHash('sha256').update(sourceBytes).digest('hex') !== snapshot.source.fingerprint) throw new Error('SOURCE_FINGERPRINT_MISMATCH');
  const sourcePng = readPosterPngBytes(sourceBytes, 'V2 source');
  if (sourcePng.width !== snapshot.source.width || sourcePng.height !== snapshot.source.height) throw new Error('SOURCE_DIMENSIONS_MISMATCH');
  const { route, maskProvider, maximumImagegenCalls, needsReference } = routeFor(snapshot);
  const root = path.resolve(outputRoot); const attemptRoot = safeChild(root, 'attempts', attempt.attemptId);
  const cropPath = path.join(attemptRoot, 'selected-crop.png'); const manifestPath = path.join(attemptRoot, 'manifest.json');
  const referencePath = needsReference ? path.join(attemptRoot, 'standard-reference.png') : null;
  const mappingPath = needsReference ? path.join(attemptRoot, 'mapping.json') : null;
  const outputPath = path.join(attemptRoot, 'region-candidate.png');
  const envelope = { attemptId: attempt.attemptId, batchId: attempt.batchId, documentId: attempt.documentId,
    workbenchSessionId: document.workbenchSessionId, mode: document.mode, layerId: attempt.layerId,
    layerRevision: attempt.layerRevision, dispatchId: attempt.dispatchId, authorizationId: attempt.authorizationId,
    snapshotId: attempt.snapshotId, sourceFingerprint: attempt.sourceFingerprint,
    ...(attempt.candidateNumber !== undefined ? { candidateNumber: attempt.candidateNumber } : {}),
    ...(attempt.planVersion !== undefined ? { planVersion: attempt.planVersion } : {}),
    legacyEnvelope: structuredClone(attempt.legacyEnvelope ?? null) };
  const crop = cropRgba(sourcePng, snapshot.bounds);
  const manifest = { schemaVersion: 2, mode: document.mode, envelope, snapshot: structuredClone(snapshot), selectedCropPath: cropPath,
    route, maskProvider, maximumImagegenCalls, removeBackground: snapshot.strategy.removeBackground, referencePath, mappingPath, outputPath,
    outputRoot: root, createdAt: new Date().toISOString() };
  await mkdir(attemptRoot, { recursive: true });
  await writeFile(cropPath, encodePng(snapshot.bounds.width, snapshot.bounds.height, 4, crop), { flag: 'wx' });
  if (needsReference) {
    const { image, mapping } = referenceFor(crop, snapshot.bounds);
    await writeFile(referencePath, image, { flag: 'wx' });
    await writeFile(mappingPath, `${JSON.stringify(mapping, null, 2)}\n`, { flag: 'wx' });
  }
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });
  return manifest;
}
