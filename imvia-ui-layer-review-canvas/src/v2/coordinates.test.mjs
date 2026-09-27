import test from 'node:test';
import assert from 'node:assert/strict';
import { fitViewport, toScreen, toSource, quantizeBounds } from './coordinates.js';

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
