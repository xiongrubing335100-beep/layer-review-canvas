import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildExecutionPolicy,
  buildRouteMetadata,
  classifyExecutionRoute,
  combinedRequirement,
  isNodeRunning,
  nextPaint,
} from './split-execution.js';

test('nextPaint waits for two animation frames before resolving', async () => {
  const original = globalThis.requestAnimationFrame;
  const callbacks = [];
  globalThis.requestAnimationFrame = (callback) => callbacks.push(callback);
  try {
    let resolved = false;
    const paint = nextPaint().then((timestamp) => {
      resolved = true;
      return timestamp;
    });

    assert.equal(callbacks.length, 1);
    callbacks.shift()(12);
    await Promise.resolve();
    assert.equal(resolved, false);
    assert.equal(callbacks.length, 1);

    callbacks.shift()(24);
    assert.equal(await paint, 24);
  } finally {
    globalThis.requestAnimationFrame = original;
  }
});

test('isNodeRunning blocks only local or pending work for the same node', () => {
  const jobs = [
    { nodeIds: ['pending-node'], status: 'processing' },
    { nodeIds: ['bridge-node'], status: 'awaiting_codex_message' },
    { nodeIds: ['host-node'], status: 'host_accepted' },
    { nodeIds: ['legacy-host-node'], status: 'submitted_to_conversation' },
    { nodeIds: ['completed-node'], status: 'completed' },
  ];

  assert.equal(isNodeRunning('local-node', { 'local-node': { status: 'sending_to_codex' } }, jobs), true);
  assert.equal(isNodeRunning('pending-node', {}, jobs), true);
  assert.equal(isNodeRunning('bridge-node', {}, jobs), true);
  assert.equal(isNodeRunning('host-node', {}, jobs), true);
  assert.equal(isNodeRunning('legacy-host-node', {}, jobs), true);
  assert.equal(isNodeRunning('completed-node', {}, jobs), false);
  assert.equal(isNodeRunning('other-node', {}, jobs), false);
});

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

test('checked remove-background option appends the mandatory RMBG requirement', () => {
  const requirement = combinedRequirement({
    categoryDefault: '保留组件。',
    requirement: '只要卡片底板',
    refinementPrompt: '',
    removeBackground: true,
  });

  assert.match(requirement, /只要卡片底板/);
  assert.match(requirement, /真实透明 RGBA PNG/);
  assert.match(requirement, /RMBG/);
  assert.match(requirement, /bria-rmbg/);
});

test('text categories require direct Codex RGBA instead of RMBG', () => {
  const requirement = combinedRequirement({
    category: 'kvTitle',
    categoryDefault: '保留完整标题。',
    removeBackground: true,
  });

  assert.match(requirement, /直接拆出/);
  assert.match(requirement, /真实透明 RGBA PNG/);
  assert.match(requirement, /不得使用 RMBG/);
  assert.doesNotMatch(requirement, /bria-rmbg/);
});

test('unchecked remove-background option does not append an alpha requirement', () => {
  assert.equal(combinedRequirement({
    categoryDefault: '保留组件。',
    requirement: '只要卡片底板',
    refinementPrompt: '',
    removeBackground: false,
  }), '只要卡片底板');
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

test('chooses Codex RGBA for title and ordinary text cutouts', () => {
  assert.equal(classifyExecutionRoute({
    category: 'kvTitle',
    requirement: '保留完整标题字形和描边',
    removeBackground: true,
  }), 'codex_rgba');
  assert.equal(classifyExecutionRoute({
    category: 'ordinaryText',
    requirement: '保留全部文字',
    removeBackground: true,
  }), 'codex_rgba');
});

test('text transparency stays on Codex RGBA even when the text requirement mentions repair', () => {
  assert.equal(classifyExecutionRoute({
    category: 'kvTitle',
    requirement: '补全被遮挡的标题并保留完整字形',
    removeBackground: true,
  }), 'codex_rgba');
});

test('chooses targeted repair only for explicit repair work', () => {
  assert.equal(classifyExecutionRoute({
    category: 'uiComponent',
    requirement: '移除文字并补全底板',
    refinementPrompt: '',
    removeBackground: true,
  }), 'targeted_repair');
});

test('classifies an empty requirement from its category default', () => {
  assert.equal(classifyExecutionRoute({
    categoryDefault: '移除普通文字并补全干净底板',
    requirement: '   ',
    refinementPrompt: '',
    removeBackground: true,
  }), 'targeted_repair');
});

test('does not turn a negated text-removal request into repair work', () => {
  assert.equal(classifyExecutionRoute({
    requirement: '不要移除文字，只保留当前组件',
    refinementPrompt: '',
    removeBackground: true,
  }), 'alpha_extract');
});

test('recognizes colloquial text removal as repair work', () => {
  assert.equal(classifyExecutionRoute({
    requirement: '擦掉文字，补回下面的底板',
    refinementPrompt: '',
    removeBackground: false,
  }), 'targeted_repair');
});

test('recognizes English text removal as repair work', () => {
  assert.equal(classifyExecutionRoute({
    requirement: 'remove text and reconstruct the clean base',
    refinementPrompt: '',
    removeBackground: false,
  }), 'targeted_repair');
});

test('fast targeted repair short-circuits after the first accepted candidate and allows one failed-candidate retry', () => {
  assert.deepEqual(buildExecutionPolicy({
    executionMode: 'fast',
    executionRoute: 'targeted_repair',
  }), {
    first_candidate_gate: 'validate_then_short_circuit',
    acceptance_checks: [
      'dimensions',
      'annotation_conformance',
      'obvious_exclusion',
      'structure_integrity',
    ],
    on_pass: 'skip_repair_mask_and_source_lock_then_finalize',
    on_fail: 'single_imagegen_retry_then_fail',
  });
  assert.equal(buildExecutionPolicy({
    executionMode: 'quality',
    executionRoute: 'targeted_repair',
  }), null);
});

test('buildRouteMetadata keeps simple routes mechanical and disables ImageGen', () => {
  assert.deepEqual(buildRouteMetadata({
    category: 'kvElement',
    executionRoute: 'alpha_extract',
    removeBackground: true,
    sourceRegionPixels: { x: 4, y: 8, width: 120, height: 64 },
  }), {
    repair_engine: 'none',
    requires_global_context: false,
    maximum_imagegen_calls: 0,
    transparency_strategy: 'rembg',
    rmbg_required: true,
    structure_validation_required: false,
    imagegen_input_kind: null,
    imagegen_canvas_policy: null,
    expected_output: {
      width: 120,
      height: 64,
      original_source_x: 4,
      original_source_y: 8,
    },
  });
});

test('buildRouteMetadata gives text alpha one conditional ImageGen retry', () => {
  assert.deepEqual(buildRouteMetadata({
    category: 'kvTitle',
    executionRoute: 'codex_rgba',
    removeBackground: true,
    sourceRegionPixels: { x: 8, y: 12, width: 588, height: 91 },
  }), {
    repair_engine: 'none',
    requires_global_context: false,
    maximum_imagegen_calls: 2,
    transparency_strategy: 'codex_rgba',
    rmbg_required: false,
    structure_validation_required: true,
    imagegen_input_kind: 'codex_alpha_matte',
    imagegen_canvas_policy: 'prepared_source_locked_canvas',
    expected_output: {
      width: 588,
      height: 91,
      original_source_x: 8,
      original_source_y: 12,
    },
  });
});

test('buildRouteMetadata uses crop-only context and one conditional retry for simple text repair', () => {
  const metadata = buildRouteMetadata({
    category: 'uiComponent',
    requirement: '移除普通文字并保持底板结构',
    executionMode: 'fast',
    executionRoute: 'targeted_repair',
  });

  assert.equal(metadata.repair_engine, 'imagegen');
  assert.equal(metadata.requires_global_context, false);
  assert.equal(metadata.maximum_imagegen_calls, 2);
});

test('targeted repair with RMBG declares native ImageGen content resolution output', () => {
  const metadata = buildRouteMetadata({
    category: 'uiComponent',
    requirement: '移除普通文字并保持底板结构',
    executionMode: 'fast',
    executionRoute: 'targeted_repair',
    removeBackground: true,
    sourceRegionPixels: { x: 422, y: 1174, width: 156, height: 85 },
  });

  assert.equal(metadata.output_resolution_policy, 'native_imagegen_content');
  assert.deepEqual(metadata.expected_output, {
    width: 156,
    height: 85,
    original_source_x: 422,
    original_source_y: 1174,
  });
});

test('result refinement metadata preserves existing PNG alpha and pixels', () => {
  const metadata = buildRouteMetadata({
    executionRoute: 'result_refinement',
    sourceRegionPixels: { x: 0, y: 0, width: 1536, height: 837 },
  });

  assert.equal(metadata.transparency_strategy, 'preserve_existing_alpha');
  assert.equal(metadata.rmbg_required, false);
  assert.equal(metadata.output_resolution_policy, 'existing_result_pixels');
  assert.equal(metadata.imagegen_input_kind, 'existing_result_png');
  assert.equal(metadata.imagegen_canvas_policy, 'prepared_result_locked_canvas');
  assert.equal(metadata.maximum_imagegen_calls, null);
  assert.deepEqual(metadata.expected_output, {
    width: 1536,
    height: 837,
    original_source_x: 0,
    original_source_y: 0,
  });
});

test('buildRouteMetadata requires global context for occlusion, backgrounds, and quality mode', () => {
  assert.equal(buildRouteMetadata({
    category: 'uiComponent',
    requirement: '补全被遮挡区域',
    executionRoute: 'targeted_repair',
  }).requires_global_context, true);
  assert.equal(buildRouteMetadata({
    category: 'kvBackground',
    executionRoute: 'direct_crop',
  }).requires_global_context, true);
  assert.equal(buildRouteMetadata({
    category: 'uiComponent',
    executionMode: 'quality',
    executionRoute: 'targeted_repair',
  }).maximum_imagegen_calls, 2);
});
