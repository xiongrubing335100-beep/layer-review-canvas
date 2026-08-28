import assert from 'node:assert/strict';
import test from 'node:test';
import {
  posterFastCandidateDownloadPath,
  posterFastCandidatePreviewPath,
  posterFastContainedImageRect,
  posterFastCropPreviewGeometry,
  posterFastPointerPercent,
  posterFastExecutionView,
  posterFastRecoveryAction,
  groupPosterFastLayers,
  posterFastWorkbenchState,
} from './poster-fast-workbench-model.js';

test('crop preview geometry preserves the selected source-region aspect ratio', () => {
  const geometry = posterFastCropPreviewGeometry(
    { x: 0, y: 25, width: 79, height: 47 },
    { width: 1848, height: 4000 },
  );
  assert.equal(geometry.aspectRatioCss, '1459.92 / 1880');
  assert.ok(Math.abs(geometry.aspectRatio - (1459.92 / 1880)) < 1e-12);
  const renderedImageRatio = geometry.aspectRatio
    * (Number.parseFloat(geometry.imageStyle.width) / Number.parseFloat(geometry.imageStyle.height));
  assert.ok(Math.abs(renderedImageRatio - (1848 / 4000)) < 1e-12);
});

const fastPlan = {
  source: { width: 1200, height: 1800 },
  layers: [
    {
      layer_index: 1,
      layer_name: '花束',
      processing_category: 'subject',
      bounds: { percentage: { x: 10, y: 20, width: 30, height: 40 } },
      prompt: '保留花束，禁止新增内容',
      remove_background: true,
    },
  ],
};

test('grouping keeps category headers above concrete projects', () => {
  const groups = groupPosterFastLayers([{ processing_category: 'subject', layer_name: '花束' }]);
  assert.deepEqual(groups[0].items.map((item) => item.layer_name), ['花束']);
  assert.equal(groups[0].label, '主体');
  assert.equal(groups[0].items[0].category, undefined);
});

test('workbench state selects a concrete project without mutating its plan', () => {
  const before = JSON.stringify(fastPlan);
  const model = posterFastWorkbenchState({
    plan: fastPlan,
    selectedLayerIndex: 1,
    busy: true,
    sourceUrl: 'data:image/png;base64,source',
  });

  assert.equal(JSON.stringify(fastPlan), before);
  assert.equal(model.selection.layer.layer_name, '花束');
  assert.equal(model.inspector.name, '花束');
  assert.equal(model.inspector.removeBackground, true);
  assert.equal(model.source.readOnly, true);
  assert.equal(model.selection.busy, true);
});

test('PNG return state never labels a candidate as a formal layer', () => {
  const model = posterFastWorkbenchState({
    plan: fastPlan,
    selectedLayerIndex: 1,
    candidate: {
      status: 'NEEDS_USER_REVIEW',
      candidateUrl: 'data:image/png;base64,candidate',
    },
  });

  assert.equal(model.pngReturn.formalLayer, false);
  assert.equal(model.pngReturn.label, '候选，未写入正式图层');
  assert.equal(model.pngReturn.candidateUrl, 'data:image/png;base64,candidate');
});

test('letterboxed pointer conversion uses the contained source rectangle', () => {
  const imageRect = posterFastContainedImageRect({ width: 300, height: 300 }, { width: 600, height: 300 });
  assert.deepEqual(imageRect, { left: 0, top: 75, width: 300, height: 150 });
  assert.deepEqual(posterFastPointerPercent({ x: 150, y: 150 }, imageRect), { x: 50, y: 50 });
  assert.equal(posterFastPointerPercent({ x: 150, y: 30 }, imageRect), null);
});

test('candidate preview fallback is derived for persisted candidate identifiers', () => {
  assert.equal(posterFastCandidatePreviewPath({
    jobId: 'poster-fast-7', layerIndex: 3, candidate: { candidateId: 'candidate-3' },
  }), '/api/poster-layer/jobs/poster-fast-7/layers/3/candidate-preview');
  assert.equal(posterFastCandidatePreviewPath({
    jobId: 'poster-fast-7', layerIndex: 3, candidate: { candidateUrl: '/candidate.png' },
  }), '/candidate.png');
});

test('visible fast execution exposes four real stages and server elapsed time', () => {
  const view = posterFastExecutionView({
    status: 'running', current_stage: 'rmbg', started_at: '2026-08-22T08:00:00.000Z', completed_at: null,
    stages: {
      imagegen: { status: 'completed' }, rmbg: { status: 'running' },
      canvas_mapping: { status: 'pending' }, finalizing: { status: 'pending' },
    },
  }, Date.parse('2026-08-22T08:01:05.000Z'));
  assert.deepEqual(view.steps.map((step) => step.label), ['生成候选', '去除背景', '全画布归位', '回传工作台']);
  assert.equal(view.stageLabel, '去除背景');
  assert.equal(view.elapsedLabel, '01:05');
});

test('postprocess-only failure selects reprocessing instead of ImageGen retry', () => {
  assert.deepEqual(posterFastRecoveryAction({ execution: { recoverability: 'postprocess_only' } }), {
    kind: 'postprocess_only', label: '重新处理原 PNG',
  });
  assert.deepEqual(posterFastRecoveryAction({ execution: { recoverability: 'regenerate_required' } }), {
    kind: 'regenerate', label: '重新生成此项目',
  });
});

test('candidate download URL is derived without accepting a client file path', () => {
  assert.equal(posterFastCandidateDownloadPath({
    jobId: 'poster-fast-7', layerIndex: 3, candidate: { candidateId: 'candidate-3' },
  }), '/api/poster-layer/jobs/poster-fast-7/layers/3/candidate-download');
});
