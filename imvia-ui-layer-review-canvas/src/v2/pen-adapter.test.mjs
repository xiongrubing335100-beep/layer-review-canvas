import test from 'node:test';
import assert from 'node:assert/strict';
import { toLegacyPaths, fromLegacyPaths } from './pen-adapter.js';

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
