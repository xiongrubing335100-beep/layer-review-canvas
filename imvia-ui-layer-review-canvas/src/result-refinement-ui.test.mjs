import assert from 'node:assert/strict';
import test from 'node:test';

const ui = await import('./result-refinement-ui.js').catch(() => ({}));

function required(name) {
  assert.equal(typeof ui[name], 'function', `${name} must be exported`);
  return ui[name];
}

const defaultOperation = {
  mode: 'path_scoped',
  subject_path_ids: [],
  alpha_include_path_ids: [],
};

function closedPath(id, kind = 'boundary') {
  return {
    id,
    layer_id: 'button',
    kind,
    shape: 'bezier_path',
    closed: true,
    anchors: [
      { x: 0.1, y: 0.1, in: { x: 0.1, y: 0.1 }, out: { x: 0.1, y: 0.1 }, handlesLinked: true },
      { x: 0.4, y: 0.1, in: { x: 0.4, y: 0.1 }, out: { x: 0.4, y: 0.1 }, handlesLinked: true },
      { x: 0.1, y: 0.4, in: { x: 0.1, y: 0.4 }, out: { x: 0.1, y: 0.4 }, handlesLinked: true },
    ],
  };
}

test('decoded base PNG dimensions own editor geometry while placement stays metadata', () => {
  const geometry = required('resultRefinementGeometry')({
    pngSize: { width: 1200, height: 400 },
    placement: { x: 40, y: 80, width: 200, height: 300 },
  });

  assert.deepEqual(geometry.canvas, { width: 1200, height: 400 });
  assert.equal(geometry.aspect, 3);
  assert.deepEqual(geometry.placement, { x: 40, y: 80, width: 200, height: 300 });
});

test('base PNG cache identity stays scoped to the active uploaded image', () => {
  const keyFor = required('resultRefinementBaseKey');
  const result = {
    job: { id: 'base-job' },
    image: { versionId: 'base-v1', url: '/results/base.png' },
  };

  assert.notEqual(
    keyFor({ imageId: 'image-a', result }),
    keyFor({ imageId: 'image-b', result }),
  );
});

test('changing pen tools cancels only the open draft', () => {
  const reduce = required('reduceResultRefinementUi');
  const path = closedPath('repair-1');
  const state = {
    tool: 'boundary',
    prompt: '补全金币',
    paths: [path],
    draft: { id: 'draft-1', anchors: [{ x: 0.8, y: 0.8 }] },
    selection: { pathId: 'repair-1' },
    feedbackToken: 7,
    operation: {
      mode: 'path_scoped',
      subject_path_ids: [],
      alpha_include_path_ids: ['repair-1'],
    },
  };

  const next = reduce(state, { type: 'select-tool', tool: 'background' });

  assert.equal(next.tool, 'background');
  assert.equal(next.draft, null);
  assert.strictEqual(next.paths, state.paths);
  assert.equal(next.prompt, '补全金币');
  assert.strictEqual(next.operation, state.operation);
  assert.strictEqual(next.selection, state.selection);
  assert.equal(next.feedbackToken, 7);
});

test('path deletion removes stale roles and clearing paths resets only path state', () => {
  const reduce = required('reduceResultRefinementUi');
  const subject = closedPath('subject-1');
  const repair = closedPath('repair-1');
  const state = {
    tool: 'boundary',
    prompt: '保留主体',
    paths: [subject, repair],
    draft: null,
    selection: { pathId: 'subject-1' },
    feedbackToken: 3,
    operation: {
      mode: 'keep_inside_delete_outside',
      subject_path_ids: ['subject-1'],
      alpha_include_path_ids: ['repair-1'],
    },
  };

  const deleted = reduce(state, {
    type: 'editor-change',
    paths: [repair],
    draft: null,
    selection: null,
    feedbackToken: 4,
  });
  assert.deepEqual(deleted.operation, {
    mode: 'path_scoped',
    subject_path_ids: [],
    alpha_include_path_ids: ['repair-1'],
  });

  const cleared = reduce(deleted, { type: 'clear-paths' });
  assert.deepEqual(cleared.paths, []);
  assert.equal(cleared.draft, null);
  assert.equal(cleared.selection, null);
  assert.equal(cleared.feedbackToken, null);
  assert.deepEqual(cleared.operation, defaultOperation);
  assert.equal(cleared.prompt, '保留主体');
  assert.equal(cleared.tool, 'boundary');
});

test('cancelling the full-canvas confirmation prevents the submission request', async () => {
  const coordinate = required('coordinateResultRefinementSubmission');
  let submissions = 0;
  const result = await coordinate({
    prompt: '整体增强光影',
    paths: [],
    operation: { ...defaultOperation, mode: 'full_canvas_explicit' },
    policy: {
      operation: { ...defaultOperation, mode: 'full_canvas_explicit' },
      repair_path_ids: [], erase_path_ids: [], protect_path_ids: [], subject_path_ids: [],
    },
    basePng: { pngSize: { width: 1200, height: 400 }, dataUrl: 'data:image/png;base64,AA==' },
    placement: { x: 40, y: 80, width: 200, height: 300 },
    baseResult: { jobId: 'base-job', versionId: 'base-v1', fileName: 'button.png' },
    layer: { id: 'button', category: 'uiComponent', categoryLabel: 'UI组件', name: '按钮', executionMode: 'fast' },
    project: { projectId: 'project-1', imageId: 'image-1', sourceFingerprint: 'fp', sourceRevision: 1 },
    confirmFullCanvas: () => false,
    submitPlan: async () => { submissions += 1; },
  });

  assert.deepEqual(result, { cancelled: true });
  assert.equal(submissions, 0);
});

test('confirmed submission returns the operation and summary used by the pending snapshot', async () => {
  const coordinate = required('coordinateResultRefinementSubmission');
  const operation = { ...defaultOperation, mode: 'full_canvas_explicit' };
  const result = await coordinate({
    prompt: '  整体增强光影  ',
    paths: [],
    operation,
    policy: {
      operation,
      repair_path_ids: [], erase_path_ids: [], protect_path_ids: [], subject_path_ids: [],
    },
    basePng: { pngSize: { width: 1200, height: 400 }, dataUrl: 'data:image/png;base64,AA==' },
    placement: { x: 40, y: 80, width: 200, height: 300 },
    baseResult: { jobId: 'base-job', versionId: 'base-v1', fileName: 'button.png' },
    layer: { id: 'button', category: 'uiComponent', categoryLabel: 'UI组件', name: '按钮', executionMode: 'fast' },
    project: { projectId: 'project-1', imageId: 'image-1', sourceFingerprint: 'fp', sourceRevision: 1 },
    confirmFullCanvas: () => true,
    submitPlan: async (plan) => ({ job_id: 'revision-1', receivedPlan: plan }),
  });

  assert.equal(result.cancelled, false);
  assert.deepEqual(result.refinementSnapshot, {
    prompt: '整体增强光影',
    paths: [],
    operation,
    summary: '修复 0 处 · 擦除 0 处 · 保护 0 处 · 主体 0 处 · 路径外透明：关闭 · 整图编辑：开启',
  });
  assert.equal(result.delivery.job_id, 'revision-1');
  assert.deepEqual(result.payload.source.canvas, { width: 1200, height: 400 });
  assert.deepEqual(result.payload.layers[0].placement, { x: 40, y: 80, width: 200, height: 300 });
  assert.deepEqual(result.payload.layers[0].refinement_operation, operation);
});
