// Explicit isolated acceptance only: record failures, verify blocking, then
// export passing layers in a separate copy, never in the production document.
import assert from 'node:assert/strict';
import { readFile, writeFile, readdir, cp, access } from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { applyAttemptEvent } from '../src/v2/batch.js';
import { removeLayer } from '../src/v2/document.js';
import { createWorkbenchV2Api, workbenchV2Middleware } from '../src/v2/api.mjs';
import { readPosterPngBytes } from '../src/poster-png.js';
import { inspectPsd } from '../src/v2/psd-codec.mjs';

const root = path.resolve(process.argv[2]);
const json = async p => JSON.parse(await readFile(p, 'utf8'));
const save = (p, v) => writeFile(p, JSON.stringify(v, null, 2), { flag: 'wx' });
const hash = b => createHash('sha256').update(b).digest('hex');
const { document, batch, origin } = await json(path.join(root, 'acceptance.json'));
assert.equal(origin, 'explicit_user_requested_real_acceptance');
const outcomes = [];
for (const { attempt } of batch.items) {
  let failure;
  try { failure = await json(path.join(root, 'failures', attempt.attemptId, 'failure.json')); }
  catch (e) { if (e.code !== 'ENOENT') throw e; }
  let candidate;
  if (!failure) {
    const dir = path.join(root, 'candidates', attempt.attemptId);
    const files = (await readdir(dir)).filter(f => f.endsWith('.json'));
    assert.equal(files.length, 1);
    candidate = await json(path.join(dir, files[0]));
  }
  const state = applyAttemptEvent(attempt, { eventId: randomUUID(), attemptId: attempt.attemptId,
    dispatchId: attempt.dispatchId, type: failure ? 'failed' : 'suggested',
    payload: failure ? { error: failure.error } : { versionId: candidate.versionId } });
  const statePath = path.join(root, 'attempts', attempt.attemptId + '.json');
  try {
    const existing = await json(statePath);
    for (const key of ['attemptId','dispatchId','documentId','layerId','snapshotId','authorizationId'])
      assert.equal(existing[key], attempt[key]);
    if (existing.execution === 'running') {
      const updated = applyAttemptEvent(existing, {eventId:randomUUID(),attemptId:attempt.attemptId,
        dispatchId:attempt.dispatchId,type:failure?'failed':'suggested',
        payload:failure?{error:failure.error}:{versionId:candidate.versionId}});
      await writeFile(statePath,JSON.stringify(updated,null,2));
    } else assert.equal(existing.execution, state.execution);
  }
  catch (e) { if (e.code !== 'ENOENT') throw e; await save(statePath, state); }
  outcomes.push({ layerId: attempt.layerId, name: document.layers[attempt.layerId].name,
    error: failure?.error, candidate });
}
const api = createWorkbenchV2Api({ root: path.join(root, 'documents') });
const composition = await api.getComposition(document.documentId);
const passing = outcomes.filter(o => o.candidate);
assert.equal(composition.layers.length, passing.length);
let blocked = false;
if (passing.length !== outcomes.length) {
  await assert.rejects(api.exportDocumentPsd({ documentId: document.documentId, expectedRevision: document.revision }), /EXPORT_LAYER_NOT_READY/);
  blocked = true;
}
const report = { outcomes: outcomes.map(({ candidate, ...v }) => ({ ...v, passed: !!candidate })),
  fullDocumentExportBlocked: blocked, bridgeDeliveryTest: false, subsetExport: null };
if (passing.length) {
  const subset = root + '-passing-only';
  await assert.rejects(access(subset), { code: 'ENOENT' });
  await cp(root, subset, { recursive: true, errorOnExist: true, force: false });
  // Relocate archive file pointers in the isolated copy only. Pixel hashes and
  // frozen identity are unchanged; copying paths is not a new finalization.
  for (const { candidate } of passing) {
    const relocated = { ...candidate };
    for (const key of ['pngPath', 'rawPath', 'reviewReportPath', 'pixelAuditPath']) {
      assert.ok(candidate[key].startsWith(root + path.sep));
      relocated[key] = subset + candidate[key].slice(root.length);
    }
    await writeFile(path.join(subset, 'candidates', candidate.attemptId, candidate.versionId + '.json'), JSON.stringify(relocated, null, 2));
  }
  const subsetApi = createWorkbenchV2Api({ root: path.join(subset, 'documents') });
  let selected = document;
  for (const item of outcomes.filter(o => !o.candidate)) selected = removeLayer(selected, item.layerId);
  await subsetApi.saveDocument(selected, document.revision);
  const exported = await subsetApi.exportDocumentPsd({ documentId: selected.documentId, expectedRevision: selected.revision });
  const middleware = workbenchV2Middleware({ root: path.join(subset, 'documents') });
  const server = createServer((req, res) => middleware(req, res, () => { res.writeHead(404); res.end(); }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const base = `http://127.0.0.1:${server.address().port}/api/workbench-v2/documents/${selected.documentId}`;
    const response = await fetch(`${base}/exports/${exported.exportId}/download`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-disposition'), /^attachment;/);
    const bytes = Buffer.from(await response.arrayBuffer());
    const psd = inspectPsd(bytes, { availableMemory: 8 * 1024 ** 3 });
    assert.equal(psd.layers.length, passing.length);
    assert.deepEqual([psd.width, psd.height], [document.source.width, document.source.height]);
    await writeFile(path.join(subset, 'passing-only.psd'), bytes, { flag: 'wx' });
    for (const { candidate, name } of passing) {
      const response = await fetch(`${base}/layers/${candidate.layerId}/versions/${candidate.versionId}/png?download=1`);
      assert.equal(response.status, 200);
      assert.match(response.headers.get('content-disposition'), /^attachment;/);
      const png = Buffer.from(await response.arrayBuffer());
      assert.equal(hash(png), candidate.sha256);
      const decoded = readPosterPngBytes(png), layer = psd.layers.find(l => l.name === name);
      assert.deepEqual(layer.placement, candidate.placement);
      assert.ok(Buffer.from(layer.image.data).equals(Buffer.from(decoded.pixels)));
      await writeFile(path.join(subset, candidate.layerId + '.png'), png, { flag: 'wx' });
    }
    report.subsetExport = { root: subset, layers: passing.map(o => o.name), bytes: bytes.length,
      pngHttpDownload: true, psdHttpDownload: true, rgbaIdentity: true, placementIdentity: true };
  } finally { await new Promise(resolve => server.close(resolve)); }
}
await save(path.join(root, 'mixed-verification.json'), report);
console.log(JSON.stringify(report, null, 2));
