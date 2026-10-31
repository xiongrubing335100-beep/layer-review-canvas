import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createDocument, addLayer, applyLayerEdit } from './document.js';
import { createDocumentStore } from './document-store.js';
import { documentInput, layerInput } from './test-fixtures.mjs';

test('concurrent saves have one winner and retain the previous immutable revision', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'imvia-v2-doc-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = createDocumentStore({ root });
  const original = addLayer(createDocument(documentInput()), layerInput());
  await store.create(original);
  const results = await Promise.allSettled(['one', 'two'].map(name => store.update({
    documentId: original.documentId, expectedRevision: original.revision,
    document: applyLayerEdit(original, 'a', { name }),
  })));
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(results.find(r => r.status === 'rejected').reason.code, 'REVISION_CONFLICT');
  const saved = await store.read(original.documentId);
  assert.equal(saved.revision, original.revision + 1);
  assert.ok(['one', 'two'].includes(saved.layers.a.name));
  await assert.rejects(store.create(original), { code: 'DOCUMENT_EXISTS' });
  await assert.rejects(store.read('../outside'));
  await assert.rejects(store.update({ documentId: original.documentId, expectedRevision: saved.revision,
    document: { ...saved, revision: saved.revision + 1, source: { ...saved.source, fingerprint: 'different' } } }), { code: 'SOURCE_IMMUTABLE' });
  const entries = await readdir(path.join(root, original.documentId));
  assert.ok(entries.includes(`revision-${original.revision}.json`));
  assert.ok(entries.every(name => !name.endsWith('.tmp')));
});
