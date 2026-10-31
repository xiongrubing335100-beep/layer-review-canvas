import test from 'node:test';
import assert from 'node:assert/strict';
import { toLegacyPaths, fromLegacyPaths, toRegionPenPaths, fromRegionPenPaths } from './pen-adapter.js';

test('anchors and both handles map against source size, not selection bounds', () => {
  const paths = [{ id: 'path', kind: 'include', shape: 'bezier_path', closed: false, order: 0,
    anchors: [{ x: 100.25, y: 200.5, in: { x: 90.5, y: 210.25 }, out: { x: 120, y: 180 }, handlesLinked: false }] }];
  const original = structuredClone(paths);
  const normalized = toLegacyPaths(paths, { width: 400, height: 800 });
  assert.equal(normalized[0].kind, 'foreground');
  assert.equal(normalized[0].anchors[0].x, 0.250625);
  assert.equal(normalized[0].anchors[0].in.y, 0.2628125);
  assert.deepEqual(fromLegacyPaths(normalized, { width: 400, height: 800 }), paths);
  assert.deepEqual(paths, original);
  assert.equal(fromLegacyPaths([{ ...normalized[0], kind: 'background' }], { width: 400, height: 800 })[0].kind, 'exclude');
  assert.equal(fromLegacyPaths([{ ...normalized[0], kind: 'boundary' }], { width: 400, height: 800 })[0].kind, 'include');
  assert.throws(() => toLegacyPaths(paths, { width: 0, height: 800 }));
  assert.throws(() => fromLegacyPaths([{ ...normalized[0], kind: 'unknown' }], { width: 400, height: 800 }));
});

test('focused pen editor maps paths into the selected region and back without changing source coordinates', () => {
  const bounds = { x: 129, y: 1522, width: 1280, height: 1451 };
  const sourcePaths = [{ id: 'path', kind: 'include', shape: 'bezier_path', closed: true, order: 0, anchors: [
    { x: 449, y: 1812, in: { x: 429, y: 1792 }, out: { x: 469, y: 1832 }, handlesLinked: true },
    { x: 769, y: 2102, in: { x: 749, y: 2082 }, out: { x: 789, y: 2122 }, handlesLinked: true },
    { x: 1050, y: 2380, in: { x: 1030, y: 2360 }, out: { x: 1070, y: 2400 }, handlesLinked: true },
  ] }];
  const focused = toRegionPenPaths(sourcePaths, bounds);
  assert.ok(Math.abs(focused[0].anchors[0].x - .25) < 1e-12);
  assert.ok(Math.abs(focused[0].anchors[0].y - 290 / 1451) < 1e-12);
  assert.equal(focused[0].kind, 'foreground');
  assert.deepEqual(fromRegionPenPaths(focused, bounds), sourcePaths);
});
