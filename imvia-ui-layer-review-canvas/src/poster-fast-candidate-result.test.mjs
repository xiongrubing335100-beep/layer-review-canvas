import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const [resultSource, workbenchSource, modelSource, mainSource] = await Promise.all([
  readFile(new URL('./PosterFastCandidateResult.jsx', import.meta.url), 'utf8'),
  readFile(new URL('./PosterFastWorkbench.jsx', import.meta.url), 'utf8'),
  readFile(new URL('./poster-fast-workbench-model.js', import.meta.url), 'utf8'),
  readFile(new URL('./main.jsx', import.meta.url), 'utf8'),
]);

test('fast PNG result makes review state explicit and keeps the candidate non-formal', () => {
  assert.match(resultSource, /候选，未写入正式图层/);
  assert.match(resultSource, /review-ready/);
  assert.match(resultSource, /接受候选/);
  assert.match(resultSource, /重新生成此项目/);
});

test('fast PNG result translates factual failures while keeping raw codes technical', () => {
  assert.match(resultSource, /CANVAS_OR_GREEN_FIELD_INVALID/);
  assert.match(resultSource, /画布尺寸或键色不符合当前项目要求/);
  assert.match(resultSource, /技术详情/);
  assert.match(resultSource, /REGISTRATION_UNCERTAIN/);
});

test('fast PNG result distinguishes empty, pending, accepted and rejected return states', () => {
  assert.match(resultSource, /尚未生成候选/);
  assert.match(resultSource, /候选生成中/);
  assert.match(resultSource, /已写入正式图层/);
  assert.match(resultSource, /候选未通过自动质检/);
});

test('fast workbench keeps exactly the three H5 panels and a focused inspector', () => {
  for (const label of ['原图展示', '框选操作区', 'PNG 回传展示区']) assert.match(modelSource, new RegExp(label));
  for (const control of ['名称', '提示词', '去背景', '钢笔', '拆分当前项目']) assert.match(modelSource, new RegExp(control));
  assert.match(workbenchSource, /posterFastWorkbenchContract/);
  const inspector = workbenchSource.match(/<aside className="[^"]*poster-fast-workbench__inspector[^"]*"[\s\S]*?<\/aside>/)?.[0] || '';
  assert.doesNotMatch(inspector, /证据|审核|导出|重组/);
  assert.match(workbenchSource, /aria-current=/);
  assert.match(workbenchSource, /posterFastContainedImageRect/);
  assert.match(workbenchSource, /releasePointerCapture/);
  assert.match(workbenchSource, /aria-label="删除原始画布"/);
  assert.match(workbenchSource, /onClick=\{\(\) => onDeleteSource\?\.\(\)\}/);
  assert.match(mainSource, /onDeleteSource=\{deleteOriginalCanvas\}/);
  assert.match(workbenchSource, /if \(!cancelled && changed\) commit\(drag.nextBounds\)/);
  assert.doesNotMatch(workbenchSource, /commit\(next\)/);
  assert.doesNotMatch(workbenchSource, /poster-completion|PosterCandidateReview|计划复核|重组审计/);
});

test('main resolves persisted fast candidates through the existing preview route', () => {
  assert.match(mainSource, /posterFastCandidatePreviewPath/);
  assert.match(mainSource, /resolveWorkbenchUrl\(posterFastPreviewPath\)/);
  assert.match(mainSource, /posterFastCandidateDownloadPath/);
  assert.match(mainSource, /reprocessPosterFastCandidateRequest/);
  assert.match(mainSource, /taskControl=\{posterTaskControl\}/);
  assert.match(mainSource, /!isFastPosterPlan/);
});
