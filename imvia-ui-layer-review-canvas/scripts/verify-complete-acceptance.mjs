// Isolated, complete-batch HTTP export acceptance. No failed-layer removal.
import assert from 'node:assert/strict';
import { readFile, writeFile, readdir, mkdir } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { createServer } from 'node:http';
import { applyAttemptEvent } from '../src/v2/batch.js';
import { createWorkbenchV2Api, workbenchV2Middleware } from '../src/v2/api.mjs';
import { readPosterPngBytes } from '../src/poster-png.js';
import { inspectPsd } from '../src/v2/psd-codec.mjs';

const root = path.resolve(process.argv[2]);
const json = async p => JSON.parse(await readFile(p, 'utf8'));
const hash = b => createHash('sha256').update(b).digest('hex');
const { document, batch, origin } = await json(path.join(root, 'acceptance.json'));
assert.equal(origin, 'explicit_user_requested_real_acceptance');
const candidates = [];
// Require all outcomes before making any state transition or export.
for (const { attempt } of batch.items) {
  const dir = path.join(root, 'candidates', attempt.attemptId);
  const files = (await readdir(dir)).filter(f => f.endsWith('.json'));
  assert.equal(files.length, 1, 'Every frozen item must have one finalized candidate');
  const candidate = await json(path.join(dir, files[0]));
  assert.equal(candidate.documentId, document.documentId);
  assert.equal(candidate.layerId, attempt.layerId);
  assert.equal(candidate.attemptId, attempt.attemptId);
  candidates.push(candidate);
}
assert.equal(candidates.length, Object.keys(document.layers).length);
for (const candidate of candidates) {
  const statePath = path.join(root, 'attempts', `${candidate.attemptId}.json`);
  const state = await json(statePath);
  if (state.execution === 'running') {
    const next = applyAttemptEvent(state, {
      eventId: randomUUID(), type: 'suggested', attemptId: state.attemptId,
      dispatchId: state.dispatchId, payload: { versionId: candidate.versionId },
    });
    await writeFile(statePath, JSON.stringify(next, null, 2));
  } else {
    assert.equal(state.execution, 'suggested');
    assert.equal(state.candidateVersionId, candidate.versionId);
  }
}
const api = createWorkbenchV2Api({ root: path.join(root, 'documents') });
const composition = await api.getComposition(document.documentId);
assert.equal(composition.layers.length, candidates.length);
const exported = await api.exportDocumentPsd({
  documentId: document.documentId, expectedRevision: document.revision,
});
const out = path.join(root, 'complete-download-verification');
await mkdir(out);
const middleware = workbenchV2Middleware({ root: path.join(root, 'documents') });
const server = createServer((req, res) => middleware(req, res, () => {
  res.writeHead(404); res.end();
}));
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
try {
  const base = `http://127.0.0.1:${server.address().port}/api/workbench-v2/documents/${document.documentId}`;
  const response = await fetch(`${base}/exports/${exported.exportId}/download`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-disposition'), /^attachment;/);
  const bytes = Buffer.from(await response.arrayBuffer());
  const psd = inspectPsd(bytes, { availableMemory: 8 * 1024 ** 3 });
  assert.deepEqual([psd.width, psd.height], [document.source.width, document.source.height]);
  assert.equal(psd.layers.length, candidates.length);
  const layers = [];
  for (const candidate of candidates) {
    const pngResponse = await fetch(`${base}/layers/${candidate.layerId}/versions/${candidate.versionId}/png?download=1`);
    assert.equal(pngResponse.status, 200);
    assert.match(pngResponse.headers.get('content-disposition'), /^attachment;/);
    const png = Buffer.from(await pngResponse.arrayBuffer());
    assert.equal(hash(png), candidate.sha256);
    const decoded = readPosterPngBytes(png);
    const name = document.layers[candidate.layerId].name;
    const matches = psd.layers.filter(l => l.name === name);
    assert.equal(matches.length, 1);
    assert.deepEqual(matches[0].placement, candidate.placement);
    assert.ok(Buffer.from(matches[0].image.data).equals(Buffer.from(decoded.pixels)));
    await writeFile(path.join(out, `${candidate.layerId}.png`), png, { flag: 'wx' });
    layers.push({ name, layerId: candidate.layerId, versionId: candidate.versionId,
      pngSha256: hash(png), placement: candidate.placement, rgbaIdentity: true });
  }
  await writeFile(path.join(out, 'complete.psd'), bytes, { flag: 'wx' });
  const report = { documentId: document.documentId, completeBatch: true,
    removedLayers: 0, bridgeDeliveryTest: false, pngHttpDownload: true,
    psdHttpDownload: true, psdSha256: hash(bytes), psdBytes: bytes.length, layers };
  await writeFile(path.join(out, 'verification.json'), JSON.stringify(report, null, 2), { flag: 'wx' });
  console.log(JSON.stringify(report, null, 2));
} finally {
  await new Promise(resolve => server.close(resolve));
}
