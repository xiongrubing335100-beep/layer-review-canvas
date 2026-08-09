import assert from 'node:assert/strict';
import test from 'node:test';
import {
  appendAnchor,
  closePenPath,
  createPenPath,
  deleteAnchor,
  flattenPenPath,
  isValidClosedPath,
  moveAnchor,
  moveHandle,
  pathToSvgD,
  toggleAnchorMode,
} from './pen-path.js';

function curvedFixture() {
  let path = createPenPath({ id: 'curve', kind: 'boundary', point: { x: .1, y: .2 } });
  path = appendAnchor(path, { x: .9, y: .2 });
  path = appendAnchor(path, { x: .5, y: .85 });
  path = moveHandle(path, 0, 'out', { x: .35, y: .05 }, { breakLink: true });
  path = moveHandle(path, 1, 'in', { x: .65, y: .05 }, { breakLink: true });
  return closePenPath(path);
}

test('a path needs three distinct anchors before it can close', () => {
  let path = createPenPath({ id: 'p1', kind: 'foreground', point: { x: .1, y: .1 } });
  path = appendAnchor(path, { x: .9, y: .1 });
  assert.equal(isValidClosedPath(closePenPath(path)), false);
  path = appendAnchor(path, { x: .9, y: .9 });
  assert.equal(isValidClosedPath(closePenPath(path)), true);
});

test('linked handles stay collinear until option breaks the link', () => {
  const path = closePenPath(appendAnchor(appendAnchor(
    createPenPath({ id: 'p1', kind: 'boundary', point: { x: .1, y: .1 } }),
    { x: .9, y: .1 },
  ), { x: .5, y: .9 }));
  const linked = moveHandle(path, 0, 'out', { x: .3, y: .1 }, { breakLink: false });
  assert.deepEqual(linked.anchors[0].in, { x: -.1, y: .1 });
  const broken = moveHandle(linked, 0, 'out', { x: .3, y: .2 }, { breakLink: true });
  assert.deepEqual(broken.anchors[0].in, linked.anchors[0].in);
  assert.equal(broken.anchors[0].handlesLinked, false);
});

test('flattening a closed curve is deterministic and stays inside source pixels', () => {
  const points = flattenPenPath(curvedFixture(), { width: 640, height: 360, maxErrorPx: 1 });
  assert.deepEqual(points, flattenPenPath(curvedFixture(), { width: 640, height: 360, maxErrorPx: 1 }));
  assert.ok(points.length > curvedFixture().anchors.length);
  assert.ok(points.every(({ x, y }) => x >= 0 && x <= 640 && y >= 0 && y <= 360));
});

test('path operations are immutable and keep anchor coordinates normalized', () => {
  const initial = createPenPath({ id: 'p1', kind: 'boundary', point: { x: -.2, y: 1.4 } });
  const appended = appendAnchor(initial, { x: .6, y: .4 });
  const moved = moveAnchor(appended, 1, { x: 2, y: -1 });

  assert.deepEqual(initial.anchors[0], {
    x: 0, y: 1,
    in: { x: 0, y: 1 }, out: { x: 0, y: 1 }, handlesLinked: true,
  });
  assert.deepEqual(moved.anchors[1], {
    x: 1, y: 0,
    in: { x: 1, y: 0 }, out: { x: 1, y: 0 }, handlesLinked: true,
  });
  assert.notStrictEqual(moved, appended);
  assert.notStrictEqual(moved.anchors, appended.anchors);
});

test('switching an anchor mode toggles linked handles and deleting below three anchors invalidates a path', () => {
  let path = curvedFixture();
  path = toggleAnchorMode(path, 1);
  assert.equal(path.anchors[1].handlesLinked, true);
  assert.equal(isValidClosedPath(deleteAnchor(path, 1)), false);
  assert.equal(deleteAnchor(createPenPath({ id: 'only', kind: 'boundary', point: { x: .5, y: .5 } }), 0), null);
});

test('SVG serialization uses cubic segments and closes only when requested', () => {
  let path = createPenPath({ id: 'p1', kind: 'boundary', point: { x: .1, y: .2 } });
  path = appendAnchor(path, { x: .8, y: .2 });
  path = appendAnchor(path, { x: .5, y: .9 });
  path = moveHandle(path, 0, 'out', { x: .2, y: .1 }, { breakLink: true });
  path = moveHandle(path, 1, 'in', { x: .7, y: .1 }, { breakLink: true });
  path = closePenPath(path);

  assert.equal(
    pathToSvgD(path, { close: false }),
    'M 0.1 0.2 C 0.2 0.1 0.7 0.1 0.8 0.2 C 0.8 0.2 0.5 0.9 0.5 0.9',
  );
  assert.equal(
    pathToSvgD(path, { close: true }),
    'M 0.1 0.2 C 0.2 0.1 0.7 0.1 0.8 0.2 C 0.8 0.2 0.5 0.9 0.5 0.9 C 0.5 0.9 0.1 0.2 0.1 0.2 Z',
  );
});
