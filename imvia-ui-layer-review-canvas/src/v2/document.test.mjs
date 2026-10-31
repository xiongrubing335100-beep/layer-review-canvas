import test from 'node:test';
import assert from 'node:assert/strict';
import { createDocument, addLayer, removeLayer, reorderLayers, applyLayerEdit, freezeLayer } from './document.js';
import { documentInput, layerInput } from './test-fixtures.mjs';
import * as documentActions from './document.js';

test('moving a selection clamps its position and moves both masks without resizing or changing other layers', () => {
  assert.equal(typeof documentActions.moveLayerRegion, 'function');
  const anchor = { x: 140, y: 1530, in: { x: 135, y: 1525 }, out: { x: 145, y: 1535 }, handlesLinked: true };
  const paths = [{ id: 'mask', kind: 'include', shape: 'bezier_path', closed: false, order: 0, anchors: [anchor] }];
  let doc = addLayer(createDocument(documentInput()), layerInput({ paths, strategy: { operation: 'extract', removeBackground: false, repairPaths: paths } }));
  doc = addLayer(doc, layerInput({ layerId: 'b' }));
  const moved = documentActions.moveLayerRegion(doc, 'a', { x: 10, y: -20 });
  assert.deepEqual(moved.layers.a.bounds, { x: 139, y: 1502, width: 1280, height: 1451 });
  assert.deepEqual(moved.layers.a.paths[0].anchors[0], { x: 150, y: 1510, in: { x: 145, y: 1505 }, out: { x: 155, y: 1515 }, handlesLinked: true });
  assert.deepEqual(moved.layers.a.strategy.repairPaths, moved.layers.a.paths);
  assert.deepEqual(moved.layers.b, doc.layers.b);
  assert.equal(moved.layers.a.layerRevision, doc.layers.a.layerRevision + 1);
  assert.deepEqual(documentActions.moveLayerRegion(doc, 'a', { x: -10000, y: 10000 }).layers.a.bounds,
    { x: 0, y: 1945, width: 1280, height: 1451 });
  assert.equal(documentActions.moveLayerRegion(doc, 'a', { x: 0, y: 0 }), doc);
  assert.equal(doc.layers.a.bounds.x, 129);
});

const fixture = () => addLayer(createDocument(documentInput()), layerInput());
test('new foreground layers freeze source-faithful repair by default without migrating explicit strategies', () => {
  for (const processingCategory of ['text','subject','brand_ui','decoration_prop','effect']) {
    const doc = addLayer(createDocument(documentInput()), layerInput({processingCategory,strategy:undefined}));
    assert.equal(freezeLayer(doc,'a').strategy.fidelityPolicy,'source_faithful_repair');
    assert.equal(doc.layers.a.strategy.operation,'extract');
  }
  const legacy = fixture();
  const before = freezeLayer(legacy,'a').snapshotId;
  const updated = addLayer(legacy,layerInput({layerId:'new',strategy:undefined}));
  assert.equal(freezeLayer(updated,'a').snapshotId,before);
  assert.equal(updated.layers.a.strategy.fidelityPolicy,undefined);
  const background = addLayer(createDocument(documentInput()),layerInput({processingCategory:'background',strategy:undefined}));
  assert.equal(background.layers.a.strategy.fidelityPolicy,undefined);
  assert.equal(background.layers.a.strategy.removeBackground,false);
});
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
