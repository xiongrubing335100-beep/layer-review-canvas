// Isolated release acceptance; deliberately does not simulate host delivery.
import { readFile, mkdir, copyFile, writeFile } from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import path from 'node:path';
import { createDocument, addLayer, defaultLayerStrategy } from '../src/v2/document.js';
import { createDocumentStore } from '../src/v2/document-store.js';
import { createBatch, applyAttemptEvent } from '../src/v2/batch.js';
import { prepareV2Item } from '../src/v2/execution-adapter.js';

const root = path.resolve(process.argv[2]);
const prior = JSON.parse(await readFile('output/acceptance-fresh-car-20261018/acceptance.json', 'utf8'));
await mkdir(root); // Never overwrite an earlier acceptance.
const id = () => randomUUID().replaceAll('-', '');
const documentId = id();
const directory = path.join(root, 'documents', documentId);
await mkdir(directory, { recursive: true });
const sourcePath = path.join(directory, 'source.png');
await copyFile(prior.document.source.path, sourcePath);
const sourceBytes = await readFile(sourcePath);
const fingerprint = createHash('sha256').update(sourceBytes).digest('hex');
if (fingerprint !== prior.document.source.fingerprint) throw new Error('SOURCE_CHANGED');
let document = createDocument({ documentId, workbenchSessionId: id(), mode: 'poster',
  source: { ...prior.document.source, path: sourcePath } });
for (const layer of Object.values(prior.document.layers)) {
  document = addLayer(document, { ...layer, layerId: id(), layerRevision: 1,
    strategy: defaultLayerStrategy(layer.processingCategory), acceptedVersionId: null });
}
await createDocumentStore({ root: path.join(root, 'documents') }).create(document);
const batch = createBatch({ document, submissionKey: id() });
await mkdir(path.join(root, 'attempts'));
const manifests = [];
for (const item of batch.items) {
  const running = applyAttemptEvent(item.attempt, { eventId: id(), type: 'running',
    attemptId: item.attempt.attemptId, dispatchId: item.attempt.dispatchId });
  await writeFile(path.join(root, 'attempts', running.attemptId + '.json'),
    JSON.stringify(running, null, 2), { flag: 'wx' });
  manifests.push(await prepareV2Item({ document, snapshot: item.snapshot,
    attempt: running, outputRoot: root }));
}
await writeFile(path.join(root, 'acceptance.json'), JSON.stringify({
  origin: 'explicit_user_requested_real_acceptance', bridgeDeliveryTest: false,
  purpose: 'Current-contract text and Logo release acceptance; no host receipt simulated.',
  document, batch, manifests,
}, null, 2), { flag: 'wx' });
console.log(JSON.stringify(manifests, null, 2));
