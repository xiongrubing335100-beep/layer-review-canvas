import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyExecutionRoute, combinedRequirement } from './split-execution.js';

test('keeps explicit user intent and appends refinement once', () => {
  assert.equal(combinedRequirement({
    categoryDefault: '保留组件。',
    requirement: '只要卡片底板',
    refinementPrompt: '删除右下角数字',
  }), '只要卡片底板\n\n精修补充：删除右下角数字');
});

test('uses the category default only when requirement is empty', () => {
  assert.equal(combinedRequirement({
    categoryDefault: '保留标题并输出透明 PNG。',
    requirement: '   ',
    refinementPrompt: '',
  }), '保留标题并输出透明 PNG。');
});

test('chooses direct crop when no alpha or repair is requested', () => {
  assert.equal(classifyExecutionRoute({
    category: 'kvElement',
    requirement: '保持框内原始像素',
    refinementPrompt: '',
    removeBackground: false,
  }), 'direct_crop');
});

test('chooses alpha extraction for a clean subject cutout', () => {
  assert.equal(classifyExecutionRoute({
    category: 'kvElement',
    requirement: '保留图标和附着阴影',
    refinementPrompt: '',
    removeBackground: true,
  }), 'alpha_extract');
});

test('chooses targeted repair only for explicit repair work', () => {
  assert.equal(classifyExecutionRoute({
    category: 'uiComponent',
    requirement: '移除文字并补全底板',
    refinementPrompt: '',
    removeBackground: true,
  }), 'targeted_repair');
});
