import test from 'node:test';
import assert from 'node:assert/strict';
import { createDocument, addLayer, removeLayer, reorderLayers, applyLayerEdit, freezeLayer } from './document.js';
import { documentInput, layerInput } from './test-fixtures.mjs';

const fixture = () => addLayer(createDocument(documentInput()), layerInput());
test('rename and reordering do not invalidate pixel revision; changing bounds does', () => {
  const original = fixture();
  const renamed = applyLayerEdit(original, 'a', { name: '新名字' });
  assert.equal(renamed.layers.a.layerRevision, 1);
  assert.equal(renamed.revision, original.revision + 1);
  const two = addLayer(renamed, layerInput({ layerId: 'b' }));
  const reordered = reorderLayers(two, ['b', 'a']);
  assert.deepEqual(reordered.layerOrder, ['b', 'a']);
  assert.equal(reordered.layers.a.layerRevision, 1);
  const moved = applyLayerEdit(original, 'a', { bounds: { x: 130, y: 1522, width: 1280, height: 1451 } });
  assert.equal(moved.layers.a.layerRevision, 2);
  assert.equal(original.layers.a.bounds.x, 129);
  assert.throws(() => reorderLayers(two, ['a', 'a']));
});
test('frozen snapshots are detached, immutable and do not include display name', () => {
  const doc = fixture();
  const snapshot = freezeLayer(doc, 'a');
  const renamed = freezeLayer(applyLayerEdit(doc, 'a', { name: '别名' }), 'a');
  assert.equal(snapshot.snapshotId, renamed.snapshotId);
  doc.layers.a.bounds.x = 130;
  assert.equal(snapshot.bounds.x, 129);
  assert.throws(() => { snapshot.bounds.x = 0; });
  assert.equal(snapshot.source.fingerprint, 'source-test');
});
test('removal retains history but removes selection and active order', () => {
  const doc = removeLayer(fixture(), 'a');
  assert.deepEqual(doc.layerOrder, []);
  assert.equal(doc.activeLayerId, null);
  assert.equal(doc.layers.a.name, '主体');
  assert.throws(() => freezeLayer(doc, 'a'));
});
test('invalid categories, regions, names and identity changes are rejected', () => {
  for (const patch of [{ name: ' ' }, { processingCategory: 'custom-unknown' },
    { bounds: { x: -1, y: 0, width: 5, height: 5 } },
    { bounds: { x: 0, y: 0, width: 0, height: 5 } },
    { bounds: { x: 1500, y: 0, width: 100, height: 5 } }]) {
    assert.throws(() => addLayer(createDocument(documentInput()), layerInput(patch)));
  }
  assert.throws(() => applyLayerEdit(fixture(), 'a', { layerId: 'b' }));
  assert.throws(() => applyLayerEdit(fixture(), 'a', { acceptedVersionId: 'unreviewed' }));
  assert.throws(() => addLayer(fixture(), layerInput()));
  assert.throws(() => createDocument(documentInput({ documentId: '../outside' })));
});
test('new source belongs to a new document, H5 is an explicit supported mode', () => {
  const first = fixture();
  const next = createDocument(documentInput({ documentId: 'second', mode: 'h5', source: { ...first.source, fingerprint: 'new' } }));
  assert.deepEqual(next.layerOrder, []);
  assert.equal(first.source.fingerprint, 'source-test');
  assert.notEqual(next.documentId, first.documentId);
});
