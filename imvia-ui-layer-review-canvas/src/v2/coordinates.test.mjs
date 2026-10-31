import test from 'node:test';
import assert from 'node:assert/strict';
import { fitViewport, toScreen, toSource, quantizeBounds } from './coordinates.js';
import * as coordinates from './coordinates.js';

test('all eight resize handles preserve opposite edges in source pixels', () => {
  const b = { x: 100, y: 200, width: 80, height: 60 };
  const limit = { x: 0, y: 0, width: 400, height: 500 };
  const expected = {
    nw: [110, 215, 70, 45], n: [100, 215, 80, 45], ne: [100, 215, 90, 45],
    e: [100, 200, 90, 60], se: [100, 200, 90, 75], s: [100, 200, 80, 75],
    sw: [110, 200, 70, 75], w: [110, 200, 70, 60],
  };
  for (const [handle, result] of Object.entries(expected)) {
    assert.deepEqual(Object.values(coordinates.resizeRegionBounds(b, handle, { x: 10, y: 15 }, limit)), result);
  }
  assert.deepEqual(b, { x: 100, y: 200, width: 80, height: 60 });
});

test('resize clamps to entry crop, never flips or collapses, and converts scaled pointer distance', () => {
  const b = { x: 123, y: 1535, width: 278, height: 84 };
  assert.deepEqual(coordinates.resizeRegionBounds(b, 'se', { x: 1000, y: 1000 }, b), b);
  assert.deepEqual(coordinates.resizeRegionBounds(b, 'nw', { x: 1000, y: 1000 }, b), { x: 400, y: 1618, width: 1, height: 1 });
  const t = fitViewport(b, { width: 600, height: 400 });
  const start = toSource({ x: 300, y: 200 }, t);
  const end = toSource({ x: 300 - 20*t.scale, y: 200 - 10*t.scale }, t);
  assert.deepEqual(coordinates.resizeRegionBounds(b, 'se', { x: end.x-start.x, y: end.y-start.y }, b), { ...b, width: 258, height: 74 });
});

test('fit preserves the whole tall image inside viewport and padding', () => {
  const t = fitViewport({ x: 0, y: 0, width: 1562, height: 3396 }, { width: 640, height: 480 });
  for (const p of [{ x: 0, y: 0 }, { x: 1562, y: 3396 }]) {
    const s = toScreen(p, t);
    assert.ok(s.x >= 16 - 1e-9 && s.x <= 624 + 1e-9);
    assert.ok(s.y >= 16 - 1e-9 && s.y <= 464 + 1e-9);
  }
  assert.ok(Math.abs(t.scale - 448 / 3396) < 1e-12);
});
test('focused bounds use original coordinates, without accumulating view drift', () => {
  const point = { x: 129.25, y: 1522.75 };
  for (let i = 0; i < 100; i++) {
    const t = fitViewport({ x: 129, y: 1522, width: 1280, height: 1451 }, { width: 420 + i, height: 800 });
    const back = toSource(toScreen(point, t), t);
    assert.ok(Math.abs(back.x - 129.25) < 1e-9);
    assert.ok(Math.abs(back.y - 1522.75) < 1e-9);
  }
  assert.deepEqual(point, { x: 129.25, y: 1522.75 });
});
test('saved bounds normalize reverse drags, outward round, clamp and reject empty', () => {
  const size = { width: 100, height: 200 };
  assert.deepEqual(quantizeBounds({ x: 10.5, y: 20.5, width: -5.2, height: -6.1 }, size), { x: 5, y: 14, width: 6, height: 7 });
  assert.deepEqual(quantizeBounds({ x: 99, y: 199, width: 5, height: 6 }, size), { x: 99, y: 199, width: 1, height: 1 });
  for (const b of [{ x: 10, y: 10, width: 0, height: 3 }, { x: 150, y: 10, width: 2, height: 2 }, { x: NaN, y: 0, width: 2, height: 2 }]) assert.throws(() => quantizeBounds(b, size));
  assert.throws(() => fitViewport({ x: 0, y: 0, width: 0, height: 1 }, size));
  assert.throws(() => toSource({ x: 1, y: 1 }, { scale: 0, offsetX: 0, offsetY: 0 }));
});
