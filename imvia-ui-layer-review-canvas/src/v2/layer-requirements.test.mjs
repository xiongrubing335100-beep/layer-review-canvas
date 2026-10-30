import test from 'node:test';
import assert from 'node:assert/strict';
import { addLayer, createDocument, freezeLayer } from './document.js';
import { createEditorDraft, reduceEditorDraft, commitEditorDraft } from './editor-state.js';
import { toRegionPenPaths, fromRegionPenPaths } from './pen-adapter.js';
import { combinedLayerRequirements, executionRegionRequirements } from './layer-requirements.js';
import { documentInput, layerInput } from './test-fixtures.mjs';

const region = (id, requirements, x = 150) => ({ id, requirements, kind: 'include', shape: 'bezier_path', closed: true, order: 0,
  anchors: [[x, 1540], [x + 50, 1540], [x + 50, 1590]].map(([x, y]) => ({ x, y, in: { x, y }, out: { x, y }, handlesLinked: true })) });

test('saving and reopening retains all local requirements and binds their changes into the frozen snapshot', () => {
  const document = addLayer(createDocument(documentInput()), layerInput());
  const paths = [region('nickname', '移除昵称，补全底板'), region('amount', '保留数字的金色描边', 300)];
  let draft = createEditorDraft(document, 'a');
  draft = reduceEditorDraft(draft, { type: 'set-strategy', field: 'repairPaths', value: paths });
  assert.equal(draft.values.strategy.operation, 'reconstruct');
  const saved = commitEditorDraft(document, draft);
  const reopened = createEditorDraft(saved, 'a');
  assert.deepEqual(reopened.values.strategy.repairPaths, paths);
  assert.deepEqual(fromRegionPenPaths(toRegionPenPaths(paths, saved.layers.a.bounds), saved.layers.a.bounds), paths);
  const summary = combinedLayerRequirements(reopened.values);
  assert.match(summary, /保留原位/);
  assert.match(summary, /修复区域 1.*\n移除昵称，补全底板/);
  assert.match(summary, /修复区域 2.*\n保留数字的金色描边/);
  const snapshot = freezeLayer(saved, 'a');
  paths[0].requirements = '新的局部要求';
  const changed = commitEditorDraft(saved, reduceEditorDraft(reopened, { type: 'set-strategy', field: 'repairPaths', value: paths }));
  assert.notEqual(freezeLayer(changed, 'a').snapshotId, snapshot.snapshotId);
  assert.equal(snapshot.strategy.repairPaths[0].requirements, '移除昵称，补全底板');
});

test('execution instructions identify each path in crop and prepared-reference coordinates', () => {
  const layer = layerInput({ paths: [region('outline', '保留边缘')], strategy: { operation: 'reconstruct', removeBackground: true,
    repairPaths: [region('nickname', '去除昵称'), region('empty', '  '), { ...region('open', '未闭合要求'), closed: false }] } });
  const instructions = executionRegionRequirements(layer, { contentRegion: { x: 100, y: 80, width: 640, height: 725.5 } });
  assert.deepEqual(instructions.map(({ target, pathId }) => [target, pathId]), [['paths', 'outline'], ['repairPaths', 'nickname']]);
  assert.deepEqual(instructions[1].anchors[0], { x: 21, y: 18, in: { x: 21, y: 18 }, out: { x: 21, y: 18 } });
  assert.deepEqual(instructions[1].referenceAnchors[0], { x: 110.5, y: 89, in: { x: 110.5, y: 89 }, out: { x: 110.5, y: 89 } });
  assert.doesNotMatch(combinedLayerRequirements(layer), /未闭合要求/);
});
