import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { deflateSync } from 'node:zlib';
import { digestCanonicalJson } from '../poster-plan.js';
import { readPosterPngBytes } from '../poster-png.js';
import { processingCategories } from './document.js';
import { combinedLayerRequirements, executionRegionRequirements, hasLocalRepairRequirements } from './layer-requirements.js';
import { currentProcessingPolicy } from './processing-policy.js';
import { sampleReferenceRgba } from './reference-sampling.js';

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
  if (!['extract', 'reconstruct'].includes(operation)) throw new Error('INVALID_OPERATION');
  if (operation === 'extract' && !removeBackground && !hasLocalRepairRequirements(snapshot)) return { route: 'extract_mask', maskProvider: 'selection', maximumImagegenCalls: 0, needsReference: false };
  if (snapshot.strategy.fidelityPolicy === 'source_faithful_repair' && snapshot.processingCategory !== 'background') return { route: 'reconstruct', maskProvider: 'native_rgba', maximumImagegenCalls: snapshot.strategy.localRepairPolicy === 'scoped_once_v1' ? 2 : 1, needsReference: true };
  if (operation === 'reconstruct' || hasLocalRepairRequirements(snapshot)) return { route: 'reconstruct', maskProvider: removeBackground ? 'bria' : 'generated_region', maximumImagegenCalls: 1, needsReference: true };
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
function referenceFor(crop, bounds, preserveCoverage = false) {
  const padding = Math.ceil(Math.min(REFERENCE.width, REFERENCE.height) * 0.06);
  const scale = Math.min((REFERENCE.width - padding * 2) / bounds.width, (REFERENCE.height - padding * 2) / bounds.height);
  const width = Math.max(1, Math.min(REFERENCE.width - padding * 2, Math.round(bounds.width * scale)));
  const height = Math.max(1, Math.min(REFERENCE.height - padding * 2, Math.round(bounds.height * scale)));
  const x = Math.floor((REFERENCE.width - width) / 2); const y = Math.floor((REFERENCE.height - height) / 2);
  const canvas = Buffer.alloc(REFERENCE.width * REFERENCE.height * 4); canvas.fill(20);
  for (let i = 3; i < canvas.length; i += 4) canvas[i] = 255;
  const sampled = preserveCoverage ? sampleReferenceRgba(crop, bounds.width, bounds.height, width, height) : null;
  for (let dy = 0; dy < height; dy++) for (let dx = 0; dx < width; dx++) {
    const sx = Math.min(bounds.width - 1, Math.floor((dx + 0.5) * bounds.width / width));
    const sy = Math.min(bounds.height - 1, Math.floor((dy + 0.5) * bounds.height / height));
    const from = (sy * bounds.width + sx) * 4; const to = ((y + dy) * REFERENCE.width + x + dx) * 4;
    if (sampled) sampled.copy(canvas, to, (dy * width + dx) * 4, (dy * width + dx) * 4 + 4);
    else crop.copy(canvas, to, from, from + 4);
  }
  const mapping = { version: 1, coordinateSpace: 'selected_region_pixels', sampling: preserveCoverage ? 'area_reduce_linear_enlarge_premultiplied' : 'nearest_pixel_center', canvas: REFERENCE,
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
  const reference = needsReference ? referenceFor(crop, snapshot.bounds, ['imagegen_matte', 'native_rgba'].includes(maskProvider)) : null;
  const manifest = { schemaVersion: 2, mode: document.mode, envelope, snapshot: structuredClone(snapshot), selectedCropPath: cropPath,
    processingPolicy: await currentProcessingPolicy(),
    processingRequirements: combinedLayerRequirements(snapshot),
    ...(maskProvider === 'native_rgba' ? { nativeRgbaRequirements: { version: 3,
      compositing: 'Keep frozen source RGB. Explicit repairPaths are the only permitted patches when present. Otherwise the renderer may use generated RGB only at observed source/model disagreement within a bounded 2–8 source-pixel silhouette band, fading into unchanged interior. It never changes alpha for RGB repair, never replaces whole-layer RGB, and does not repaint the interior. Inspect the source-composited preview for wrong silhouettes, background contamination, thin structures, holes and patch seams; the raw model appearance alone is not acceptance. Report exact unchanged foreground RGB counts from pixelAudit.localRepair, not a whole-canvas percentage.',
      instruction: 'Edit the prepared source reference, never recreate the design from a description. Preserve text, logo identity, composition, perspective, colors and material. Repair missing or damaged boundaries from source evidence. Keep every requested bevel, thin line, disconnected decoration and real hole. Return native RGBA with genuine transparency when removeBackground is true, at the exact reference canvas dimensions and coordinates; no recentering or tight crop. Do not generate or apply a second matte, BRIA, erosion or source-matte refinement. Inspect the entire final mapped RGBA against the source before delivery. Bind the review to rawSha256 and finalPreview.rgbaSha256; record nativeRgbaChecks for contentFidelity, fullSilhouette, thinStructures, holesAndSolidMaterial, placement and protectedRegions. All checks must pass. One model call only; no automatic retry.' } } : {}),
    ...(maskProvider === 'imagegen_matte' ? { semanticRequirements: { version: 1,
      coordinateSpace: 'selected_region_pixels',
      instruction: 'Inspect source content before generation: inventory every requested object and distinguish flat graphics, solid material assemblies and organic subjects. Inspect the raw matte with scripts/inspect-v2-matte.py. Classify every enclosed hole against the source, not its edge contrast; preserve true counters and restore only source-confirmed solid material. For material_composite also inspect the complete bounds of materialNotchProposals: source-confirmed opaque open pockets may be declared as materialNotches under the bound item contract; do not fill true or ambiguous background gaps. Run --stage final with the report and preview path: inspect the complete rendered RGBA and pixelAudit before recording a passed visualReview. Bind semanticTopology to rawSha256 and finalPreview to the returned rgbaSha256. A displaced proposal may be corrected by source-driven assembly segmentation; judge the final preview, not only the raw. No extra model calls or user confirmation.' } } : {}),
    regionInstructions: executionRegionRequirements(snapshot, reference?.mapping),
    instructionPolicy: 'Apply the overall requirements and every region instruction together. Each local instruction applies only inside its bound path. Use referenceAnchors on the prepared reference image. Excluded repair regions must remain unchanged.',
    ...(maskProvider === 'imagegen_matte' ? { matteInstructions: 'Treat the reference as a fixed coordinate plane. Inventory all requested objects from the crop and requirements before generating: the category does not limit a title assembly to flat letter faces. Keep attached subjects, solid extrusions, bevels, dark grilles, grooves, reflections and any requested backing objects fully opaque white. Use black only for actual background visible through or outside the assembly; dark material is not a hole. Trace the exact source silhouette, including thin rings and disconnected pieces; do not redraw, recenter, enlarge, thicken a rim, smooth away corners or add decoration. Use flat white for solid interiors and flat black for background, with gray only at genuine antialiased boundaries. The raw matte is a semantic proposal: inspect it against the source using semanticRequirements before finalization. Local enclosed-hole correction cannot repair missing parts or a distorted outer contour. A needs_review result is diagnostic, not a clean cutout; inspect reviewReasons. Read processingPolicy.itemContractPath for the bound contract. Do not bypass the finalizer or claim semantic completeness from a boundary score.' } : {}),
    route, maskProvider, maximumImagegenCalls, removeBackground: snapshot.strategy.removeBackground, referencePath, mappingPath, outputPath,
    rawCoordinateSpace: ['generated_region', 'imagegen_matte', 'native_rgba'].includes(maskProvider) ? 'reference_canvas' : 'selected_region',
    outputRoot: root, createdAt: new Date().toISOString() };
  await mkdir(attemptRoot, { recursive: true });
  if (maskProvider === 'native_rgba' && maximumImagegenCalls === 2) {
    manifest.nativeRgbaRequirements.instruction = manifest.nativeRgbaRequirements.instruction.replace(
      'One model call only; no automatic retry.',
      'Initial generation once. If source inspection identifies precise local defects, reserve one bounded second call using scripts/prepare-v2-local-repair.mjs and the bound item contract. No whole-task retry or third call. Preserve the first raw; use both prepared source reference and initial raw for localized editing.');
    manifest.scopedRepairRequirements = { version: 1, maximumRepairCalls: 1, maximumScopeFraction: 0.25,
      coordinateSpace: 'selected_region_pixels', inputPolicy: 'prepared_source_reference_and_initial_raw',
      inspection: 'Record source-evidenced defects before reserving repair. Merge only their rectangles intersected with frozen permitted paths. Inspect merged result, not repair raw alone.' };
  }
  await writeFile(cropPath, encodePng(snapshot.bounds.width, snapshot.bounds.height, 4, crop), { flag: 'wx' });
  if (needsReference) {
    const { image, mapping } = reference;
    await writeFile(referencePath, image, { flag: 'wx' });
    await writeFile(mappingPath, `${JSON.stringify(mapping, null, 2)}\n`, { flag: 'wx' });
  }
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });
  return manifest;
}
