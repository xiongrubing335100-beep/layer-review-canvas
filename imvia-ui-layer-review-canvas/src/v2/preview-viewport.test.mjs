import test from 'node:test';
import assert from 'node:assert/strict';
import { previewBounds, fitPreview, zoomPreview } from './preview-viewport.js';
import { toSource, toScreen } from './coordinates.js';

const source = { width: 880, height: 1808 };
const layers = [{ placement: { x: 104, y: 1515 }, width: 309, height: 117 }];
test('candidate fits its own PNG bounds, while composition retains the original canvas', () => {
  const bounds = previewBounds(source, layers);
  assert.deepEqual(bounds, { x: 104, y: 1515, width: 309, height: 117 });
  const view = fitPreview(bounds, { width: 800, height: 500 });
  const center = toScreen({ x: 104 + 309 / 2, y: 1515 + 117 / 2 }, view);
  assert.deepEqual(center, { x: 400, y: 250 });
  assert.deepEqual(previewBounds(source, layers, true), { x: 0, y: 0, ...source });
  assert.deepEqual(previewBounds(source, []), { x: 0, y: 0, ...source });
});
test('zoom anchors the same source pixel and never changes candidate geometry', () => {
  const before = structuredClone(layers), anchor = { x: 200, y: 230 };
  const view = fitPreview(previewBounds(source, layers), { width: 800, height: 500 });
  const pixel = toSource(anchor, view);
  const zoomed = zoomPreview(view, anchor, view.scale * 2);
  const after = toSource(anchor, zoomed);
  assert.ok(Math.abs(pixel.x - after.x) < 1e-9 && Math.abs(pixel.y - after.y) < 1e-9);
  assert.equal(zoomPreview(view, anchor, 1).scale, 1);
  assert.equal(zoomPreview(view, anchor, 1000).scale, 32);
  assert.equal(zoomPreview(view, anchor, 0).scale, .01);
  assert.deepEqual(layers, before);
});
