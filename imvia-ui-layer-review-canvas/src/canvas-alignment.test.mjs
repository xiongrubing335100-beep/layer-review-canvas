import assert from 'node:assert/strict';
import test from 'node:test';
import { alignCanvasItems } from './canvas-alignment.js';

const items = [
  { key: 'a', x: 40, y: 80, width: 100, height: 60 },
  { key: 'b', x: 210, y: 20, width: 160, height: 100 },
  { key: 'c', x: 120, y: 170, width: 80, height: 40 },
];

test('aligns selected canvas items to the left, center, and right bounds', () => {
  assert.deepEqual(alignCanvasItems(items, 'left'), {
    a: { x: 40, y: 80 },
    b: { x: 40, y: 20 },
    c: { x: 40, y: 170 },
  });
  assert.deepEqual(alignCanvasItems(items, 'center'), {
    a: { x: 155, y: 80 },
    b: { x: 125, y: 20 },
    c: { x: 165, y: 170 },
  });
  assert.deepEqual(alignCanvasItems(items, 'right'), {
    a: { x: 270, y: 80 },
    b: { x: 210, y: 20 },
    c: { x: 290, y: 170 },
  });
});

test('aligns selected canvas items to the top and bottom bounds', () => {
  assert.deepEqual(alignCanvasItems(items, 'top'), {
    a: { x: 40, y: 20 },
    b: { x: 210, y: 20 },
    c: { x: 120, y: 20 },
  });
  assert.deepEqual(alignCanvasItems(items, 'bottom'), {
    a: { x: 40, y: 150 },
    b: { x: 210, y: 110 },
    c: { x: 120, y: 170 },
  });
});

test('returns no positions when fewer than two nodes are selected', () => {
  assert.deepEqual(alignCanvasItems(items.slice(0, 1), 'left'), {});
});
