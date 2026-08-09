import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildResultRefinementPlan,
  canSubmitResultRefinement,
  readPngPixelSize,
} from './result-refinement.js';

const fixtureLayer = {
  id: 'button',
  category: 'uiComponent',
  categoryLabel: 'UI组件',
  name: '发送按钮',
  executionMode: 'fast',
};

const fixtureProject = {
  projectId: 'project-1',
  imageId: 'image-1',
  sourceFingerprint: 'fingerprint-1',
  sourceRevision: 3,
};

function closedFixture() {
  return {
    id: 'pen-1',
    layer_id: 'button',
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

function openFixture() {
  return { ...closedFixture(), id: 'draft-1', closed: false };
}

test('text alone can submit a PNG refinement', () => {
  assert.deepEqual(
    canSubmitResultRefinement({ prompt: '增强按钮高光', paths: [], draft: null }),
    { ok: true, reason: null },
  );
});

test('a closed path alone can submit a PNG refinement', () => {
  assert.deepEqual(
    canSubmitResultRefinement({ prompt: '  ', paths: [closedFixture()], draft: null }),
    { ok: true, reason: null },
  );
});

test('an open pen draft blocks submission even when text is present', () => {
  const result = canSubmitResultRefinement({ prompt: '调整', paths: [], draft: openFixture() });
  assert.equal(result.ok, false);
  assert.match(result.reason, /闭合或取消/);
});

test('empty text without a valid closed path cannot submit', () => {
  const result = canSubmitResultRefinement({ prompt: '  ', paths: [], draft: null });
  assert.equal(result.ok, false);
  assert.match(result.reason, /要求.*闭合路径/);
});

test('PNG pixel decoding closes its ImageBitmap after reading dimensions', async () => {
  let closed = 0;
  const blob = new Blob(['png'], { type: 'image/png' });
  const size = await readPngPixelSize(blob, async (received) => {
    assert.strictEqual(received, blob);
    return { width: 1536, height: 837, close: () => { closed += 1; } };
  });

  assert.deepEqual(size, { width: 1536, height: 837 });
  assert.equal(closed, 1);
});

test('PNG pixel decoding closes its ImageBitmap when dimensions are invalid', async () => {
  let closed = 0;
  await assert.rejects(
    readPngPixelSize(new Blob(['png']), async () => ({
      width: 0,
      height: 837,
      close: () => { closed += 1; },
    })),
    /尺寸/,
  );
  assert.equal(closed, 1);
});

test('the refinement plan separates PNG pixels from logical placement', () => {
  const plan = buildResultRefinementPlan({
    pngSize: { width: 1536, height: 837 },
    placement: { x: 422, y: 1252, width: 156, height: 85 },
    prompt: '增强按钮高光',
    paths: [closedFixture()],
    baseResult: {
      jobId: 'base-job',
      versionId: 'base-v1',
      fileName: 'button.png',
      dataUrl: 'data:image/png;base64,AA==',
    },
    layer: fixtureLayer,
    project: fixtureProject,
  });

  assert.equal(plan.task, 'refine_split_result');
  assert.equal(plan.parent_job_id, 'base-job');
  assert.equal(plan.source.canvas.width, 1536);
  assert.equal(plan.source.canvas.height, 837);
  assert.equal(plan.layers[0].source_region_pixels.width, 1536);
  assert.equal(plan.layers[0].expected_output.width, 1536);
  assert.equal(plan.layers[0].output.width, 1536);
  assert.deepEqual(plan.layers[0].placement, { x: 422, y: 1252, width: 156, height: 85 });
  assert.deepEqual(plan.layers[0].review_snapshot, {
    placement: { x: 422, y: 1252, width: 156, height: 85 },
  });
  assert.equal(plan.layers[0].execution_route_hint, 'result_refinement');
  assert.equal(plan.layers[0].repair_engine, 'imagegen');
  assert.equal(plan.layers[0].maximum_imagegen_calls, 2);
  assert.equal(plan.layers[0].transparency_strategy, 'preserve_existing_alpha');
  assert.equal(plan.layers[0].rmbg_required, false);
  assert.equal(plan.layers[0].structure_validation_required, true);
  assert.equal(plan.layers[0].imagegen_input_kind, 'existing_result_png');
  assert.equal(plan.layers[0].imagegen_canvas_policy, 'prepared_result_locked_canvas');
  assert.equal(plan.layers[0].output_resolution_policy, 'existing_result_pixels');
  assert.equal(plan.layers[0].requirement, '增强按钮高光');
  assert.equal(plan.layers[0].mask_annotations[0].shape, 'bezier_path');
  assert.equal(plan.constraints.preserve_existing_alpha, true);
});
