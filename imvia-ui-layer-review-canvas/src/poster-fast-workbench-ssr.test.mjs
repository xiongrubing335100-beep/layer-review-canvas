import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import test from 'node:test';
import { createServer } from 'vite';

const plan = {
  source: { width: 1200, height: 1800 },
  layers: [{
    layer_index: 1,
    layer_name: '花束',
    processing_category: 'subject',
    bounds: { percentage: { x: 10, y: 20, width: 30, height: 40 } },
    prompt: '保留花束，禁止新增内容',
    remove_background: true,
  }],
};

let vite;
let PosterFastWorkbench;
let PosterFastCandidateResult;
let posterFastCandidatePreviewPath;
let posterCandidateViewModel;

test.before(async () => {
  vite = await createServer({ root: process.cwd(), appType: 'custom', server: { middlewareMode: true } });
  ({ PosterFastWorkbench } = await vite.ssrLoadModule('/src/PosterFastWorkbench.jsx'));
  ({ PosterFastCandidateResult } = await vite.ssrLoadModule('/src/PosterFastCandidateResult.jsx'));
  ({ posterFastCandidatePreviewPath } = await vite.ssrLoadModule('/src/poster-fast-workbench-model.js'));
  ({ posterCandidateViewModel } = await vite.ssrLoadModule('/src/job-state.js'));
});

test.after(async () => { await vite?.close(); });

function renderWorkbench(candidate, extra = {}) {
  return renderToStaticMarkup(createElement(PosterFastWorkbench, {
    sourceUrl: 'data:image/png;base64,source', sourceSize: { width: 1200, height: 1800 },
    sourceName: 'teachers-day-poster.png',
    plan, selectedLayerIndex: 1, candidate,
    onDeleteSource() {}, onSelectLayer() {}, onAddLayer() {}, onDeleteLayer() {}, onUpdateLayer() {}, onOpenPen() {}, onSplit() {}, onAccept() {}, onRetry() {},
    ...extra,
  }));
}

test('generating result shows four real stages and elapsed time', () => {
  const markup = renderWorkbench({
    status: 'GENERATING',
    execution: {
      status: 'running', current_stage: 'rmbg', started_at: '2026-08-22T00:00:00.000Z',
      stages: { imagegen: { status: 'completed' }, rmbg: { status: 'running' } },
    },
  }, { clockNow: Date.parse('2026-08-22T00:01:05.000Z') });
  for (const label of ['生成候选', '去除背景', '全画布归位', '回传工作台']) assert.match(markup, new RegExp(label));
  assert.match(markup, /01:05/);
});

test('fast task control is compact inside the result header', () => {
  const markup = renderWorkbench({ status: 'GENERATING' }, {
    taskControl: { action: 'abandon', label: '放弃任务' },
    onTaskControl() {},
  });
  const resultPanel = markup.match(/<section class="[^"]*poster-fast-workbench__result-panel[\s\S]*?<\/section>/)?.[0] || '';
  assert.match(resultPanel, /放弃任务/);
  assert.doesNotMatch(markup, /释放工作台队列|active Codex turn|poster-task-control/);
});

test('returned PNG exposes a download control in the result header', () => {
  const markup = renderWorkbench({ status: 'NEEDS_USER_REVIEW', candidateUrl: '/candidate.png' }, {
    downloadUrl: '/api/poster-layer/jobs/job/layers/1/candidate-download',
  });
  assert.match(markup, /candidate-download/);
  assert.match(markup, /下载 PNG/);
});

test('real fast workbench SSR has the three panels, selected concrete project, and guided inspector', () => {
  const markup = renderWorkbench({ status: 'NEEDS_USER_REVIEW', candidateUrl: '/candidate.png' });
  assert.equal((markup.match(/aria-label="(?:原图展示|框选操作区|PNG 回传展示区)"/g) || []).length, 3);
  assert.ok(markup.indexOf('主体') < markup.indexOf('花束'));
  assert.match(markup, /aria-current="true"/);
  const inspector = markup.match(/<aside class="[^"]*poster-fast-workbench__inspector[^"]*"[\s\S]*?<\/aside>/)?.[0] || '';
  for (const label of ['图层名称', '具体拆分需求', '去除背景', '边界精修', '拆分']) assert.match(inspector, new RegExp(label));
  assert.ok((inspector.match(/<button/g) || []).length >= 10);
  assert.doesNotMatch(markup, /poster-completion|bottom-step|PosterCandidateReview/);
});

test('real fast workbench follows the UI workbench hierarchy and exposes project deletion', () => {
  const markup = renderWorkbench({ status: 'PENDING' });
  assert.match(markup, /class="sidebar sidebar--left poster-fast-workbench__projects"/);
  assert.match(markup, /class="guided-viewport poster-fast-workbench__center"/);
  assert.match(markup, /class="sidebar sidebar--right poster-fast-workbench__inspector"/);
  assert.match(markup, /class="source-meta poster-fast-workbench__source-meta"/);
  assert.match(markup, /teachers-day-poster\.png/);
  assert.match(markup, /aria-label="删除原始画布"/);
  assert.match(markup, /poster-fast-workbench__preview-layout/);
  assert.match(markup, /poster-fast-workbench__result-panel/);
  assert.match(markup, /aria-label="删除当前选中的主体项目"/);
  assert.match(markup, /class="text-field"/);
  assert.match(markup, /class="requirement-field"/);
});

test('current crop preview uses expand/restore without exposing a destructive reset control', () => {
  const markup = renderWorkbench({ status: 'PENDING' });
  assert.match(markup, /aria-label="放大当前框选预览"/);
  assert.match(markup, /aria-pressed="false"/);
  assert.doesNotMatch(markup, /重置当前框选/);
  assert.match(markup, /poster-fast-workbench__crop-preview/);
  assert.match(markup, /aspect-ratio:360 \/ 720/);
});

test('poster fast mode reuses the complete guided H5 review structure', () => {
  const markup = renderWorkbench({ status: 'PENDING' });
  for (const text of [
    '第 1 / 1 项', '原图位置', '当前框选', 'Codex 拆分结果',
    '具体拆分需求', '常用拆分要求', '拆分模式', '快速', '高质量',
    '去除背景', '边界精修', '保留钢笔', '排除钢笔', '边界钢笔', '补全钢笔',
    '上一个', '确认并下一个', '拆分',
  ]) assert.match(markup, new RegExp(text));
  assert.match(markup, /aria-label="上一个拆分项"/);
  assert.match(markup, /aria-label="下一个拆分项"/);
  assert.match(markup, /aria-label="删除当前拆分项"/);
  assert.match(markup, /class="processing-option processing-option--active"/);
});

test('real fast candidate result renders every PNG return state', () => {
  const cases = [
    [{ status: 'PENDING' }, '尚未生成候选'],
    [{ status: 'GENERATING' }, '候选生成中'],
    [{ status: 'NEEDS_USER_REVIEW', candidateUrl: '/candidate.png' }, '候选，未写入正式图层'],
    [{ status: 'HARD_REJECTED', failureCodes: ['REGISTRATION_UNCERTAIN'] }, '候选未通过自动质检'],
    [{ status: 'ACCEPTED', candidateUrl: '/candidate.png' }, '已写入正式图层'],
  ];
  for (const [candidate, expected] of cases) {
    const markup = renderToStaticMarkup(createElement(PosterFastCandidateResult, { candidate, layer: plan.layers[0] }));
    assert.match(markup, new RegExp(expected));
  }
});

test('hard-rejected raw PNG remains visible beside its failure report', () => {
  const markup = renderToStaticMarkup(createElement(PosterFastCandidateResult, {
    candidate: {
      status: 'HARD_REJECTED',
      failureCodes: ['GENERATION_FAILED'],
      candidateUrl: '/api/poster-layer/jobs/job/layers/2/candidate-preview',
    },
    layer: plan.layers[0],
  }));
  assert.match(markup, /候选未通过自动质检/);
  assert.match(markup, /<img[^>]+candidate-preview/);
  assert.match(markup, /原始 PNG 已保留/);
});

test('persisted KEY_UNUSABLE facts render the required key without claiming an observed key', () => {
  const view = posterCandidateViewModel({
    plan: { status: 'PLAN_REVIEW', plan_version: 1, layers: [{ layer_index: 1, layer_name: '花束' }] },
    manifest: {
      layers: [{
        layer_index: 1, status: 'HARD_REJECTED',
        visual_inspection: { performed: true, verdict: 'HARD_REJECTED', failure_codes: ['KEY_UNUSABLE'], candidate_id: 'key-failed', plan_version: 1 },
      }],
      candidates: [{
        candidate_id: 'key-failed', layer_index: 1, plan_version: 1, path: '/candidate.png', status: 'HARD_REJECTED',
        failure_codes: ['KEY_UNUSABLE'],
        dimensions: { width: 1200, height: 1800, expected_width: 1200, expected_height: 1800, fillColor: '#00FF00' },
      }],
    },
  }, 1);
  const markup = renderToStaticMarkup(createElement(PosterFastCandidateResult, { candidate: view, layer: plan.layers[0] }));
  assert.match(markup, /要求键色：#00FF00/);
  assert.doesNotMatch(markup, /实际键色：/);
});

test('real candidate view wired through the fast workbench renders actual and persisted expected dimensions', () => {
  const view = posterCandidateViewModel({
    plan: { status: 'PLAN_REVIEW', plan_version: 1, layers: plan.layers },
    manifest: {
      layers: [{
        layer_index: 1, status: 'HARD_REJECTED',
        visual_inspection: {
          performed: false, verdict: 'HARD_REJECTED',
          failure_codes: ['CANVAS_OR_GREEN_FIELD_INVALID'], candidate_id: 'canvas-failed', plan_version: 1,
        },
      }],
      candidates: [{
        candidate_id: 'canvas-failed', layer_index: 1, plan_version: 1,
        path: '/candidate.png', status: 'HARD_REJECTED', failure_codes: ['CANVAS_OR_GREEN_FIELD_INVALID'],
        dimensions: { width: 852, height: 1846, expected_width: 1848, expected_height: 4000, fillColor: '#00FF00' },
      }],
    },
  }, 1);

  const markup = renderWorkbench(view);
  assert.match(markup, /实际画布：852 × 1846 px/);
  assert.match(markup, /要求画布：1848 × 4000 px/);
});

test('real SSR suite uses the same candidate-id preview fallback as main', () => {
  assert.equal(posterFastCandidatePreviewPath({
    jobId: 'poster-fast-1', layerIndex: 1, candidate: { candidateId: 'candidate-1' },
  }), '/api/poster-layer/jobs/poster-fast-1/layers/1/candidate-preview');
});
