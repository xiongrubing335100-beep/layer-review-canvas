import assert from 'node:assert/strict';
import test from 'node:test';
import * as resultRefinementState from './result-refinement.js';
import {
  buildResultRefinementPlan,
  canSubmitResultRefinement,
  recordResultRefinementDelivery,
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

function buildFixturePlan({ prompt, paths }) {
  return buildResultRefinementPlan({
    pngSize: { width: 1536, height: 837 },
    placement: { x: 422, y: 1252, width: 156, height: 85 },
    prompt,
    paths,
    baseResult: {
      jobId: 'base-job',
      versionId: 'base-v1',
      fileName: 'button.png',
      dataUrl: 'data:image/png;base64,AA==',
    },
    layer: fixtureLayer,
    project: fixtureProject,
  });
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
  const plan = buildFixturePlan({ prompt: '增强按钮高光', paths: [closedFixture()] });

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

test('text-only refinement keeps the full PNG editable without enabling path-scoped locks', () => {
  const plan = buildFixturePlan({ prompt: '整体增强高光', paths: [] });
  const layer = plan.layers[0];

  assert.equal(layer.mask_annotations.length, 0);
  assert.equal(layer.mask_policy.edit_scope, 'full_result_canvas');
  assert.equal(layer.mask_policy.preserve_unmarked_pixels, false);
  assert.equal(layer.mask_policy.preserve_existing_alpha_outside_annotations, false);
  assert.equal(plan.constraints.preserve_unmarked_pixels, false);
  assert.equal(plan.constraints.visible_pixels, 'full_canvas_editable');
  assert.equal(plan.constraints.alpha_edit_scope, 'full_canvas_editable_preserve_alpha_structure');
  assert.equal(layer.transparency_strategy, 'preserve_existing_alpha');
  assert.equal(plan.constraints.preserve_existing_alpha, true);
  assert.deepEqual(layer.output, { crop_to_source_region: true, x: 0, y: 0, width: 1536, height: 837 });
});

test('closed-path refinement locks pixels and alpha only outside its path scope', () => {
  const plan = buildFixturePlan({ prompt: '调整边缘', paths: [closedFixture()] });
  const layer = plan.layers[0];

  assert.equal(layer.mask_annotations.length, 1);
  assert.equal(layer.mask_policy.edit_scope, 'closed_paths_only');
  assert.equal(layer.mask_policy.preserve_unmarked_pixels, true);
  assert.equal(layer.mask_policy.preserve_existing_alpha_outside_annotations, true);
  assert.equal(plan.constraints.preserve_unmarked_pixels, true);
  assert.equal(plan.constraints.visible_pixels, 'existing_result_pixel_locked_outside_annotations');
  assert.equal(plan.constraints.alpha_edit_scope, 'locked_outside_closed_paths');
});

test('a delivered current-conversation revision remains locally pending when acknowledgement fails', async () => {
  const baseJob = { id: 'base-job', status: 'completed', nodeIds: ['button'] };
  const revisionJob = {
    id: 'revision-job',
    status: 'awaiting_codex_message',
    nodeIds: ['button'],
    parentJobId: 'base-job',
    refinementSnapshot: { prompt: '增强按钮高光', paths: [closedFixture()] },
  };
  const delivery = {
    job_id: 'revision-job',
    status: 'awaiting_codex_message',
    delivery_channel: 'current_conversation',
    prompt: '请精修已有 PNG',
    submitted_at: '2026-08-09T12:00:00.000Z',
    thread_id: 'thread-1',
    turn_id: null,
    skill_name: 'split-ui-design-layers-workbench-targeted',
  };
  let jobs = [baseJob];
  const setJobs = (updater) => { jobs = updater(jobs); };

  const outcome = await recordResultRefinementDelivery({
    delivery,
    revisionJob,
    setJobs,
    sendFollowUpMessage: async (prompt) => {
      assert.equal(prompt, '请精修已有 PNG');
    },
    markMessageSent: async (jobId) => {
      assert.equal(jobId, 'revision-job');
      assert.equal(jobs.at(-1).id, 'revision-job', 'the local pending job must exist before acknowledgement');
      throw new Error('状态回写失败');
    },
  });

  assert.equal(outcome.followUpPosted, true);
  assert.match(outcome.acknowledgementError.message, /回写失败/);
  assert.equal(jobs.length, 2);
  assert.equal(jobs.at(-1).status, 'sent_to_codex');
  assert.equal(jobs.at(-1).deliveredToConversation, true);
  assert.deepEqual(jobs.at(-1).refinementSnapshot, revisionJob.refinementSnapshot);

  jobs = jobs.map((job) => (job.id === 'revision-job' ? { ...job, status: 'processing' } : job));
  await recordResultRefinementDelivery({
    delivery,
    revisionJob,
    setJobs,
    sendFollowUpMessage: async () => {},
    markMessageSent: async () => {},
  });
  assert.equal(jobs.filter((job) => job.id === 'revision-job').length, 1);
  assert.equal(jobs.find((job) => job.id === 'revision-job').status, 'processing');
});

test('stale pre-delivery polling cannot downgrade a locally delivered revision', () => {
  const deliveredJob = {
    id: 'revision-job',
    editKind: 'result_refinement',
    status: 'sent_to_codex',
    deliveredToConversation: true,
    refinementSnapshot: { prompt: '增强高光', paths: [] },
  };
  const staleStatuses = [
    'queued',
    'awaiting_codex_message',
    'sending_to_codex',
    'host_accepted',
    'submitted_to_conversation',
  ];

  staleStatuses.forEach((status) => {
    const merged = resultRefinementState.mergeResultRefinementPollUpdate?.(
      deliveredJob,
      { ...deliveredJob, status, statusDetail: `stale:${status}` },
    );
    assert.equal(merged?.status, 'sent_to_codex');
    assert.equal(merged?.deliveredToConversation, true);
  });
});

test('polling can advance a delivered revision to processing and terminal states', () => {
  const deliveredJob = {
    id: 'revision-job',
    editKind: 'result_refinement',
    status: 'sent_to_codex',
    deliveredToConversation: true,
  };
  const merge = resultRefinementState.mergeResultRefinementPollUpdate;
  const processing = merge?.(deliveredJob, { ...deliveredJob, status: 'processing' });

  assert.equal(processing?.status, 'processing');
  assert.equal(
    merge?.(processing, { ...processing, status: 'awaiting_codex_message' })?.status,
    'processing',
  );
  ['completed', 'failed', 'cancelled'].forEach((status) => {
    assert.equal(merge?.(processing, { ...processing, status })?.status, status);
  });
});
