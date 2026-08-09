import assert from 'node:assert/strict';
import test from 'node:test';
import { annotationForPlan } from './annotation-plan.js';

function closedFixture() {
  return {
    id: 'pen-1',
    layer_id: 'layer-1',
    kind: 'boundary',
    shape: 'bezier_path',
    closed: true,
    anchors: [
      { x: 0, y: 0, in: { x: 0, y: 0 }, out: { x: 0, y: 0 }, handlesLinked: true },
      { x: 1, y: 0, in: { x: 1, y: 0 }, out: { x: 1, y: 0 }, handlesLinked: true },
      { x: 0, y: 1, in: { x: 0, y: 1 }, out: { x: 0, y: 1 }, handlesLinked: true },
    ],
  };
}

test('serializes a closed pen path into editable anchors and source pixel samples', () => {
  const mark = closedFixture();
  const annotation = annotationForPlan(
    mark,
    { x: 10, y: 20, width: 50, height: 40 },
    { width: 1000, height: 500 },
    0,
  );

  assert.equal(annotation.shape, 'bezier_path');
  assert.equal(annotation.kind, 'boundary');
  assert.equal(annotation.semantics, 'edge_override');
  assert.equal(annotation.coordinate_space, 'selected_region_normalized');
  assert.deepEqual(annotation.anchors, mark.anchors);
  assert.equal(annotation.closed, true);
  assert.deepEqual(annotation.source_polygon_pixels, [
    { x: 100, y: 100 },
    { x: 600, y: 100 },
    { x: 100, y: 300 },
    { x: 100, y: 100 },
  ]);
});

test('preserves rectangle and legacy stroke annotations while normalizing legacy boundary kind', () => {
  const bounds = { x: 10, y: 20, width: 50, height: 40 };
  const sourceSize = { width: 1000, height: 500 };
  const rectangle = annotationForPlan({
    id: 'rect-1', kind: 'foreground', shape: 'rect', x: 20, y: 25, width: 30, height: 50,
  }, bounds, sourceSize, 1);
  const legacyStroke = annotationForPlan({
    id: 'stroke-1', kind: 'brush', shape: 'stroke', points: [{ x: 0, y: 0 }, { x: 100, y: 100 }],
    brush_size_percent: 5,
  }, bounds, sourceSize, 2);

  assert.deepEqual(rectangle.region_percent, { x: 20, y: 25, width: 30, height: 50 });
  assert.deepEqual(rectangle.source_rect_pixels, { x: 200, y: 150, width: 150, height: 100 });
  assert.equal(legacyStroke.kind, 'boundary');
  assert.equal(legacyStroke.semantics, 'edge_override');
  assert.deepEqual(legacyStroke.source_points_pixels, [{ x: 100, y: 100 }, { x: 600, y: 300 }]);
});
