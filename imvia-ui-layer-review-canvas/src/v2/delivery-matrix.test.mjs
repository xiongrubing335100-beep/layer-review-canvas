import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { deflateSync } from 'node:zlib';
import { readPosterPngBytes } from '../poster-png.js';
import { createWorkbenchV2Api } from './api.mjs';
import { createBatchStore } from './batch-store.js';
import { createBridgeRequestStore } from './bridge-request-store.js';
import { finalizeV2Candidate } from './candidate-store.js';
import { addLayer } from './document.js';
import { commitEditorDraft, createEditorDraft, reduceEditorDraft } from './editor-state.js';
import { prepareV2Item } from './execution-adapter.js';
import { createExportStore } from './export-store.js';
import { inspectPsd } from './psd-codec.mjs';

// These are explicit provider fixtures, not model output or a model-quality test.
// Only raw PNG/matte/review inputs are authored here. Candidate records, pixel
// audits, automatic delivery and PSD artifacts all come from production code.
const REGION = 30;
const CANVAS = { width: 120, height: 84 };
const MEMORY = 1024 ** 3;
const background = [12, 24, 36];
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const rgba = (width, height, pixel) => {
  const bytes = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) bytes.set(pixel(x, y), (y * width + x) * 4);
  return bytes;
};

function png(width, height, pixels) {
  const chunk = (type, data) => {
    const name = Buffer.from(type), length = Buffer.alloc(4), checksum = Buffer.alloc(4);
    length.writeUInt32BE(data.length); let crc = 0xffffffff;
    for (const byte of Buffer.concat([name, data])) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
    checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([length, name, data, checksum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6;
  const rows = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) pixels.copy(rows, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}

const ring = (x, y) => x >= 5 && x < 25 && y >= 5 && y < 25
  && !(x >= 11 && x < 19 && y >= 11 && y < 19);
const logo = (x, y) => (x >= 4 && x < 23 && y >= 6 && y < 25
  && !(x >= 10 && x < 17 && y >= 12 && y < 19)) || (x >= 25 && x < 28 && y >= 4 && y < 7);
const box = (x, y) => x >= 5 && x < 25 && y >= 5 && y < 25;
const cleanBackground = (x, y) => [40 + x * 3, 60 + y * 2, 100, 255];
const foreground = (x, y) => x >= 10 && x < 20 && y >= 9 && y < 22;

const fixtures = [
  { category: 'text', name: '文字 O · 内孔', provider: 'imagegen_matte',
    source: (x, y) => [...(ring(x, y) ? [224, 176, 80] : background), 255],
    mask: (x, y) => ring(x, y) ? 255 : 0,
    expected: (x, y) => [...(ring(x, y) ? [224, 176, 80] : background), ring(x, y) ? 255 : 0],
    hole: [14, 14], solid: [7, 7] },
  { category: 'subject', name: '主体 · 原始 alpha', provider: 'bria',
    source: (x, y) => [210, 80, 50, box(x, y) ? (x < 15 ? 128 : 255) : 0],
    mask: (x, y) => box(x, y) ? 255 : 0,
    expected: (x, y) => [210, 80, 50, box(x, y) ? (x < 15 ? 128 : 255) : 0] },
  { category: 'brand_ui', name: '品牌 Logo · 内孔与分离点', provider: 'imagegen_matte',
    source: (x, y) => [...(logo(x, y) ? [80, 210, 140] : background), 255],
    mask: (x, y) => logo(x, y) ? 255 : 0,
    expected: (x, y) => [...(logo(x, y) ? [80, 210, 140] : background), logo(x, y) ? 255 : 0],
    hole: [13, 15], solid: [26, 5] },
  { category: 'decoration_prop', name: '装饰 · 透明三角', provider: 'bria',
    source: () => [170, 70, 220, 255],
    mask: (x, y) => x >= 4 && y >= 4 && x + y < 30 ? 255 : 0,
    expected: (x, y) => [170, 70, 220, x >= 4 && y >= 4 && x + y < 30 ? 255 : 0] },
  { category: 'effect', name: '光效 · 半透明', provider: 'bria',
    source: () => [60, 180, 240, 255],
    mask: (x, y) => box(x, y) ? (x >= 10 && x < 20 && y >= 10 && y < 20 ? 128 : 64) : 0,
    expected: (x, y) => [60, 180, 240, box(x, y) ? (x >= 10 && x < 20 && y >= 10 && y < 20 ? 128 : 64) : 0] },
  { category: 'background', name: '背景 · 去前景重建', provider: 'generated_region',
    source: (x, y) => foreground(x, y) ? [240, 30, 20, 255] : cleanBackground(x, y),
    expected: cleanBackground },
].map((fixture, index) => ({ ...fixture, bounds: { x: 4 + index % 3 * 40, y: 6 + Math.floor(index / 3) * 40, width: REGION, height: REGION } }));

function canvasPng() {
  return png(CANVAS.width, CANVAS.height, rgba(CANVAS.width, CANVAS.height, (x, y) => {
    const fixture = fixtures.find(({ bounds: b }) => x >= b.x && y >= b.y && x < b.x + b.width && y < b.y + b.height);
    return fixture ? fixture.source(x - fixture.bounds.x, y - fixture.bounds.y) : [...background, 255];
  }));
}

function testApi(root) {
  const bridgeStore = createBridgeRequestStore({ root: path.join(root, 'bridge-requests') });
  let api;
  const batchStore = createBatchStore({ root, getDocument: id => api.getDocument(id),
    readConfirmation: id => bridgeStore.read(id), prepareItem: prepareV2Item });
  api = createWorkbenchV2Api({ root: path.join(root, 'documents'), bridgeStore, batchStore,
    exportStore: createExportStore({ root, availableMemory: MEMORY }) });
  return { api, bridgeStore };
}

async function authorizeFixtureBatch(api, bridgeStore, document, submissionKey) {
  const submission = await api.submitBatch({ documentId: document.documentId, expectedRevision: document.revision, submissionKey });
  const receipt = { workbenchSessionId: submission.confirmation.workbenchSessionId,
    envelopeSha256: submission.confirmation.envelopeSha256 };
  // This receipt is local test setup; no message is sent to a real conversation.
  await bridgeStore.transition({ requestId: submission.batch.batchId, expectedStatus: 'claimed', nextStatus: 'sent', receipt });
  return { batchId: submission.batch.batchId, receipt };
}

async function finalizeFixture(claim, fixture) {
  const { manifest, attempt } = claim;
  const directory = path.dirname(manifest.selectedCropPath);
  const rawPath = path.join(directory, 'fixture-provider-raw.png');
  const reportPath = path.join(directory, 'fixture-provider-review.json');
  let mattePath = null;
  if (manifest.rawCoordinateSpace === 'reference_canvas') {
    const mapping = JSON.parse(await readFile(manifest.mappingPath, 'utf8'));
    const r = mapping.contentRegion;
    // Each original pixel occupies an integer 30 × 30 footprint in the real
    // prepared reference; provider padding must never enter the region PNG.
    assert.equal(r.width, REGION * 30); assert.equal(r.height, REGION * 30);
    await writeFile(rawPath, png(mapping.canvas.width, mapping.canvas.height, rgba(mapping.canvas.width, mapping.canvas.height, (x, y) => {
      const sx = Math.floor((x - r.x) / 30), sy = Math.floor((y - r.y) / 30);
      const inside = sx >= 0 && sy >= 0 && sx < REGION && sy < REGION;
      if (manifest.maskProvider === 'imagegen_matte') {
        const value = inside ? fixture.mask(sx, sy) : 0;
        return [value, value, value, 255];
      }
      return inside ? fixture.expected(sx, sy) : [251, 2, 249, 255];
    })));
  } else {
    await writeFile(rawPath, png(REGION, REGION, rgba(REGION, REGION,
      manifest.route === 'reconstruct' ? fixture.expected : () => [251, 2, 249, 255])));
    if (manifest.removeBackground) {
      mattePath = path.join(directory, 'fixture-provider-alpha.png');
      await writeFile(mattePath, png(REGION, REGION, rgba(REGION, REGION, (x, y) => [17, 239, 83, fixture.mask(x, y)])));
    }
  }
  await writeFile(reportPath, JSON.stringify({
    ...Object.fromEntries(['attemptId', 'dispatchId', 'authorizationId', 'snapshotId', 'sourceFingerprint'].map(key => [key, attempt[key]])),
    evidence: 'deterministic known-truth provider fixture; no model invocation',
    checks: { fixtureIdentity: true, pngReadable: true },
    ...(manifest.semanticRequirements ? { rawSha256: digest(await readFile(rawPath)),
      visualReview: { status: 'passed', summary: 'Independent fixture truth: solid ring and preserved background counter.' },
      semanticTopology: { version: 1, coordinateSpace: 'selected_region_pixels', profile: 'flat_graphic',
        objects: fixture.category === 'text' ? [{ name: 'letter O', point: fixture.solid }]
          : [{ name: 'logo body', point: [6,10] }, { name: 'detached mark', point: fixture.solid }],
        holes: [{ id: 1, treatment: 'preserve', reason: 'Known true counter in the authored source fixture.' }] } } : {}),
  }));
  const candidate = await finalizeV2Candidate({ manifestPath: path.join(directory, 'manifest.json'), rawPath, mattePath, reportPath });
  assert.deepEqual(await readFile(candidate.rawPath), await readFile(rawPath), 'raw provider evidence must remain unchanged');
  return candidate;
}

async function deliverAndRead(api, batch, claim, candidate, fixture) {
  await api.applyAttemptEvent({ batchId: batch.batchId, event: {
    eventId: `fixture-ready-${claim.attempt.attemptId}`, attemptId: claim.attempt.attemptId,
    dispatchId: claim.attempt.dispatchId, type: 'suggested', payload: { versionId: candidate.versionId },
  } });
  const result = await api.listLayerVersions({ documentId: candidate.documentId, layerId: candidate.layerId });
  assert.equal(result.state.status, 'ready', `${fixture.category}: ${JSON.stringify(candidate.pixelAudit)}`);
  assert.equal(result.state.resultVersionId, candidate.versionId);
  assert.equal(result.versions.length, 1);
  assert.equal(result.versions[0].artifactValid, true);
  const bytes = await api.readCandidatePng({ documentId: candidate.documentId, layerId: candidate.layerId, versionId: candidate.versionId });
  assert.equal(digest(bytes), candidate.sha256);
  assert.deepEqual(bytes, await readFile(candidate.pngPath));
  const decoded = readPosterPngBytes(bytes);
  assert.equal(decoded.width, REGION); assert.equal(decoded.height, REGION); assert.equal(decoded.colorType, 6);
  const expected = rgba(REGION, REGION, fixture.expected);
  assert.deepEqual(Buffer.from(decoded.pixels), expected, `${fixture.category} must match independently specified provider truth`);
  assert.deepEqual(candidate.placement, { x: fixture.bounds.x, y: fixture.bounds.y });
  if (fixture.hole) {
    const alphaAt = ([x, y]) => decoded.pixels[(y * REGION + x) * 4 + 3];
    assert.equal(alphaAt(fixture.hole), 0, 'text/logo counter remains transparent');
    assert.equal(alphaAt(fixture.solid), 255, 'solid stroke or disconnected logo component survives');
    assert.equal(candidate.pixelAudit.sourceGeometryAlignment.contourIntegrity.lostCounterPixels, 0);
  }
  return { candidate, expected, fixture };
}

for (const mode of ['poster', 'h5']) {
  test(`${mode}: six known-truth providers pass Python finalization, automatic delivery and lossless PSD layers`, async t => {
    const root = await mkdtemp(path.join(os.tmpdir(), `imvia-v2-delivery-${mode}-`));
    t.after(() => rm(root, { recursive: true, force: true }));
    const { api, bridgeStore } = testApi(root);
    let document = await api.createDocument({ mode, bytes: canvasPng(), workbenchSessionId: `matrix-${mode}` });
    for (const fixture of fixtures) {
      document = await api.saveDocument(addLayer(document, { layerId: fixture.category, name: fixture.name,
        displayCategory: fixture.name, processingCategory: fixture.category, bounds: fixture.bounds,
        strategy: { operation: fixture.category === 'background' ? 'reconstruct' : 'extract',
          removeBackground: fixture.category !== 'background', repairPaths: [], fidelityPolicy: 'strict_source' } }), document.revision);
    }
    const before = structuredClone(document);
    const batch = await authorizeFixtureBatch(api, bridgeStore, document, `provider-matrix-${mode}`);
    const results = [];
    for (const layerId of document.layerOrder) {
      const fixture = fixtures.find(item => item.category === layerId);
      const claim = await api.claimNextBatchItem(batch);
      assert.equal(claim.preparationFailed, undefined, JSON.stringify(claim.error));
      assert.equal(claim.attempt.layerId, layerId);
      assert.equal(claim.manifest.maskProvider, fixture.provider);
      assert.equal(claim.manifest.route, layerId === 'background' ? 'reconstruct' : 'extract_mask');
      assert.equal(claim.manifest.rawCoordinateSpace,
        ['text', 'brand_ui', 'background'].includes(layerId) ? 'reference_canvas' : 'selected_region');
      const candidate = await finalizeFixture(claim, fixture);
      results.push(await deliverAndRead(api, batch, claim, candidate, fixture));
    }
    assert.equal((await api.getBatch(batch.batchId)).status, 'complete');
    const composition = await api.getComposition(document.documentId);
    assert.deepEqual(composition.layers.map(layer => layer.layerId), document.layerOrder);
    assert.ok(Object.values(composition.states).every(state => state.status === 'ready'));
    for (const [index, { candidate }] of results.entries()) {
      assert.equal(composition.layers[index].versionId, candidate.versionId);
      assert.equal(composition.layers[index].sha256, candidate.sha256);
      assert.deepEqual(composition.layers[index].placement, candidate.placement);
    }
    const exported = await api.exportDocumentPsd({ documentId: document.documentId, expectedRevision: document.revision });
    const downloaded = await api.readExportPsd({ documentId: document.documentId, exportId: exported.exportId });
    assert.equal(digest(downloaded.bytes), exported.sha256);
    const psd = inspectPsd(downloaded.bytes, { availableMemory: MEMORY });
    assert.equal(psd.width, CANVAS.width); assert.equal(psd.height, CANVAS.height);
    assert.equal(psd.layers.length, 6); assert.equal(exported.layerCount, 6);
    for (const [index, { expected, fixture }] of results.entries()) {
      const layer = psd.layers[index];
      assert.equal(layer.name, fixture.name);
      assert.deepEqual(layer.placement, { x: fixture.bounds.x, y: fixture.bounds.y });
      assert.equal(layer.image.width, REGION); assert.equal(layer.image.height, REGION);
      assert.deepEqual(Buffer.from(layer.image.data), expected, `${mode}/${fixture.category}: PSD RGBA channels must be lossless`);
    }
    assert.deepEqual(Array.from(psd.composite.data.subarray(0, 4)), [0, 0, 0, 0], 'uncovered canvas stays transparent');
    const effect = fixtures.find(item => item.category === 'effect');
    const effectOffset = ((effect.bounds.y + 15) * CANVAS.width + effect.bounds.x + 15) * 4;
    assert.equal(psd.composite.data[effectOffset + 3], 128, 'merged PSD preserves effect coverage');
    const backgroundFixture = fixtures.find(item => item.category === 'background');
    const backgroundOffset = ((backgroundFixture.bounds.y + 15) * CANVAS.width + backgroundFixture.bounds.x + 15) * 4;
    assert.deepEqual(Array.from(psd.composite.data.subarray(backgroundOffset, backgroundOffset + 4)), [85, 90, 100, 255], 'foreground object is absent from the reconstructed background');
    assert.deepEqual(await api.getDocument(document.documentId), before, 'automatic delivery and export must not adopt versions or mutate document definitions');
  });
}

for (const actionId of ['remove-text', 'repair-occlusion']) {
  test(`${actionId}: the editor quick action selects reconstruction and delivers changed pixels`, async t => {
    const root = await mkdtemp(path.join(os.tmpdir(), `imvia-v2-quick-delivery-`));
    t.after(() => rm(root, { recursive: true, force: true }));
    const { api, bridgeStore } = testApi(root);
    const fixture = fixtures.find(item => item.category === 'background');
    let document = await api.createDocument({ mode: 'poster', bytes: canvasPng(), workbenchSessionId: `quick-${actionId}` });
    document = await api.saveDocument(addLayer(document, { layerId: 'repair-target', name: actionId,
      displayCategory: 'UI 组件', processingCategory: 'brand_ui', bounds: fixture.bounds,
      strategy: { operation: 'extract', removeBackground: false, repairPaths: [] } }), document.revision);
    const draft = reduceEditorDraft(createEditorDraft(document, 'repair-target'), { type: 'apply-quick-prompt', id: actionId });
    document = await api.saveDocument(commitEditorDraft(document, draft), document.revision);
    const batch = await authorizeFixtureBatch(api, bridgeStore, document, actionId);
    const claim = await api.claimNextBatchItem(batch);
    assert.equal(claim.manifest.route, 'reconstruct');
    assert.equal(claim.manifest.maskProvider, 'generated_region');
    const candidate = await finalizeFixture(claim, fixture);
    await deliverAndRead(api, batch, claim, candidate, fixture);
    assert.notDeepEqual(readPosterPngBytes(await readFile(claim.manifest.selectedCropPath)).pixels,
      readPosterPngBytes(await api.readCandidatePng({ documentId: document.documentId, layerId: 'repair-target', versionId: candidate.versionId })).pixels);
  });
}
