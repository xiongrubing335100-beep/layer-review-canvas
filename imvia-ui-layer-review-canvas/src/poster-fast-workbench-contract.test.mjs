import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  createPosterFastInspectorDraft,
  posterFastCandidatePreviewPath,
  posterFastInspectorCommitPatch,
  posterFastPngReturnState,
  reducePosterFastInspectorDraft,
  posterFastWorkbenchContract,
} from './poster-fast-workbench-model.js';

function renderContract(candidate) {
  const contract = posterFastWorkbenchContract();
  const png = posterFastPngReturnState(candidate);
  return renderToStaticMarkup(createElement('section', { className: 'poster-fast-workbench' },
    createElement('aside', null,
      createElement('h2', null, contract.projectSelection.categoryLabel),
      createElement('button', { 'aria-current': contract.projectSelection.ariaCurrent }, contract.projectSelection.projectName)),
    createElement('main', null, contract.centerPanels.map((label) => createElement('section', { key: label, 'aria-label': label }, label))),
    createElement('aside', null, contract.inspectorControls.map((label) => createElement('label', { key: label }, label))),
    createElement('output', { 'data-png-state': png.kind }, png.label),
  ));
}

test('fast workbench contract exposes only the H5 panels and inspector controls', () => {
  const contract = posterFastWorkbenchContract();
  assert.deepEqual(contract.centerPanels, ['原图展示', '框选操作区', 'PNG 回传展示区']);
  assert.deepEqual(contract.inspectorControls, ['名称', '提示词', '去背景', '钢笔', '拆分当前项目']);
  assert.deepEqual(contract.prohibitedMarkup, ['poster-completion', 'bottom-step', 'PosterCandidateReview']);
});

test('fast workbench contract keeps category headers, selected projects, and all PNG states concrete', () => {
  const contract = posterFastWorkbenchContract();
  assert.equal(contract.projectSelection.ariaCurrent, 'true');
  assert.equal(contract.projectSelection.categoryLabel, '主体');
  assert.equal(contract.projectSelection.projectName, '花束');

  const cases = [
    [{ status: 'PENDING' }, 'empty'],
    [{ status: 'GENERATING' }, 'pending'],
    [{ status: 'NEEDS_USER_REVIEW' }, 'review-ready'],
    [{ status: 'HARD_REJECTED', failureCodes: ['REGISTRATION_UNCERTAIN'] }, 'rejected'],
    [{ status: 'ACCEPTED' }, 'accepted'],
  ];
  for (const [candidate, kind] of cases) assert.equal(posterFastPngReturnState(candidate).kind, kind);
});

test('candidate-id-only contract resolves the exact existing preview endpoint', () => {
  const preview = posterFastCandidatePreviewPath({
    jobId: 'poster-fast-1', layerIndex: 2, candidate: { candidateId: 'candidate-2', candidatePath: 'candidates/02.png' },
  });
  assert.equal(preview, '/api/poster-layer/jobs/poster-fast-1/layers/2/candidate-preview');
});

test('minimal server render expresses the concrete project, three panels, inspector, and PNG states', () => {
  for (const [candidate, state] of [
    [{ status: 'PENDING' }, 'empty'],
    [{ status: 'GENERATING' }, 'pending'],
    [{ status: 'NEEDS_USER_REVIEW' }, 'review-ready'],
    [{ status: 'HARD_REJECTED', failureCodes: ['KEY_UNUSABLE'] }, 'rejected'],
    [{ status: 'ACCEPTED' }, 'accepted'],
  ]) {
    const markup = renderContract(candidate);
    assert.match(markup, /主体/);
    assert.match(markup, /花束/);
    assert.match(markup, /aria-current="true"/);
    for (const label of ['原图展示', '框选操作区', 'PNG 回传展示区', '名称', '提示词', '去背景', '钢笔', '拆分当前项目']) assert.match(markup, new RegExp(label));
    assert.match(markup, new RegExp(`data-png-state="${state}"`));
    assert.doesNotMatch(markup, /poster-completion|bottom-step|PosterCandidateReview/);
  }
});

test('inspector draft keeps every keystroke local until one complete commit', () => {
  const initial = createPosterFastInspectorDraft({
    layer_index: 2,
    layer_name: '普通文字',
    prompt: '只保留文字',
  });
  const typed = ['教', '教师', '教师节', '教师节标题'].reduce(
    (draft, value) => reducePosterFastInspectorDraft(draft, { type: 'name-input', value }),
    initial,
  );

  assert.equal(typed.name, '教师节标题');
  assert.deepEqual(posterFastInspectorCommitPatch(typed, 'name'), { layer_name: '教师节标题' });
  assert.deepEqual(posterFastInspectorCommitPatch(
    reducePosterFastInspectorDraft(typed, { type: 'prompt-input', value: '只保留竖排教师节标题' }),
    'prompt',
  ), { prompt: '只保留竖排教师节标题' });
});

test('server acknowledgements do not overwrite another inspector field still being edited', () => {
  const initial = createPosterFastInspectorDraft({
    layer_index: 7,
    layer_name: '主体 2',
    prompt: '',
  });
  const withName = reducePosterFastInspectorDraft(initial, {
    type: 'name-input',
    value: '连续输入回归项目',
  });
  const withPrompt = reducePosterFastInspectorDraft(withName, {
    type: 'prompt-input',
    value: '仅保留当前框选内容，保持完整画布与原坐标',
  });
  const acknowledged = reducePosterFastInspectorDraft(withPrompt, {
    type: 'replace-layer',
    layer: {
      layer_index: 7,
      layer_name: '连续输入回归项目',
      prompt: '',
    },
  });

  assert.equal(acknowledged.name, '连续输入回归项目');
  assert.equal(acknowledged.originalName, '连续输入回归项目');
  assert.equal(acknowledged.prompt, '仅保留当前框选内容，保持完整画布与原坐标');
  assert.equal(acknowledged.originalPrompt, '');
  assert.deepEqual(posterFastInspectorCommitPatch(acknowledged, 'prompt'), {
    prompt: '仅保留当前框选内容，保持完整画布与原坐标',
  });
});
