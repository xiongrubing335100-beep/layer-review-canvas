import assert from 'node:assert/strict';
import test from 'node:test';
import {
  RESULT_REFINEMENT_ROI_POLICY,
  deriveRefinementPolicy,
  polygonAreaRatio,
  refinementSubmissionState,
  refinementSummary,
} from './result-refinement-policy.js';

const canvas = { width: 100, height: 100 };
const pathScoped = {
  mode: 'path_scoped',
  subject_path_ids: [],
  alpha_include_path_ids: [],
};

function polygon(id, kind, points = [
  { x: 10, y: 10 },
  { x: 30, y: 10 },
  { x: 30, y: 30 },
  { x: 10, y: 30 },
]) {
  return {
    id,
    kind,
    shape: 'bezier_path',
    closed: true,
    source_polygon_pixels: points,
  };
}

const boundary = (id, points) => polygon(id, 'boundary', points);
const erase = (id, points) => polygon(id, 'background', points);
const protect = (id, points) => polygon(id, 'foreground', points);

test('text-only refinement is blocked unless full canvas mode is explicit', () => {
  assert.deepEqual(refinementSubmissionState({
    prompt: '增强整体高光', paths: [], draft: null,
    operation: pathScoped,
    canvas: { width: 1024, height: 1243 },
  }), {
    ok: false,
    reason: '局部二次编辑必须添加至少一条有效闭合路径',
    warnings: [],
  });
});

test('each boundary repair path receives two calls and non-repair paths receive none', () => {
  const policy = deriveRefinementPolicy({
    prompt: '补全两个金币',
    annotations: [boundary('coin-left'), boundary('coin-right'), erase('copy')],
    operation: pathScoped,
    canvas: { width: 1024, height: 1243 },
  });
  assert.deepEqual(policy.repair_path_ids, ['coin-left', 'coin-right']);
  assert.deepEqual(policy.erase_path_ids, ['copy']);
  assert.equal(policy.expected_roi_tile_count, 2);
  assert.equal(policy.maximum_imagegen_calls, 4);
});

test('a subject boundary is not also a repair ROI', () => {
  const policy = deriveRefinementPolicy({
    prompt: '补全内部金币',
    annotations: [boundary('subject'), boundary('coin')],
    operation: {
      mode: 'keep_inside_delete_outside',
      subject_path_ids: ['subject'],
      alpha_include_path_ids: [],
    },
    canvas: { width: 1024, height: 1243 },
  });
  assert.deepEqual(policy.subject_path_ids, ['subject']);
  assert.deepEqual(policy.repair_path_ids, ['coin']);
  assert.equal(policy.maximum_imagegen_calls, 2);
});

test('open pen drafts are rejected before otherwise valid local edits', () => {
  assert.deepEqual(refinementSubmissionState({
    prompt: '调整边缘', paths: [boundary('coin')], draft: { id: 'draft' },
    operation: pathScoped, canvas,
  }), {
    ok: false,
    reason: '请先闭合或取消当前钢笔路径',
    warnings: [],
  });
});

test('a boundary repair path requires a normalized prompt', () => {
  assert.deepEqual(refinementSubmissionState({
    prompt: ' \n ', paths: [boundary('coin')], draft: null,
    operation: pathScoped, canvas,
  }), {
    ok: false,
    reason: '修复路径必须填写修改目标',
    warnings: [],
  });
});

test('an erase-only submission needs no prompt and no ImageGen calls', () => {
  const state = refinementSubmissionState({
    prompt: '', paths: [erase('copy')], draft: null,
    operation: pathScoped, canvas,
  });
  assert.deepEqual(state, { ok: true, reason: null, warnings: [] });
  assert.equal(deriveRefinementPolicy({
    prompt: '', annotations: [erase('copy')], operation: pathScoped, canvas,
  }).maximum_imagegen_calls, 0);
});

test('a protect-only submission is rejected as a no-op', () => {
  assert.deepEqual(refinementSubmissionState({
    prompt: '', paths: [protect('logo')], draft: null,
    operation: pathScoped, canvas,
  }), {
    ok: false,
    reason: '仅保护路径不会产生任何修改',
    warnings: [],
  });
});

test('repair coverage above 40% warns and above 70% blocks local mode', () => {
  const warningPath = boundary('large', [
    { x: 0, y: 0 }, { x: 50, y: 0 }, { x: 50, y: 100 }, { x: 0, y: 100 },
  ]);
  const blockingPath = boundary('too-large', [
    { x: 0, y: 0 }, { x: 80, y: 0 }, { x: 80, y: 100 }, { x: 0, y: 100 },
  ]);

  assert.deepEqual(refinementSubmissionState({
    prompt: '修复', paths: [warningPath], draft: null, operation: pathScoped, canvas,
  }).warnings, ['局部修复路径范围较大，可能产生重新构图']);
  assert.deepEqual(refinementSubmissionState({
    prompt: '修复', paths: [blockingPath], draft: null, operation: pathScoped, canvas,
  }), {
    ok: false,
    reason: '局部修复路径覆盖超过 70%，必须缩小路径或明确启用整图编辑',
    warnings: ['局部修复路径范围较大，可能产生重新构图'],
  });
});

test('fully overlapping repair paths use their polygon union for coverage', () => {
  const overlapping = [
    { x: 0, y: 0 }, { x: 60, y: 0 }, { x: 60, y: 60 }, { x: 0, y: 60 },
  ];
  const paths = [boundary('overlap-a', overlapping), boundary('overlap-b', overlapping)];
  const policy = deriveRefinementPolicy({
    prompt: '修复重叠区域', annotations: paths, operation: pathScoped, canvas,
  });

  assert.equal(policy.repair_coverage_ratio, 0.36);
  assert.deepEqual(policy.warnings, []);
  assert.deepEqual(refinementSubmissionState({
    prompt: '修复重叠区域', paths, draft: null, operation: pathScoped, canvas,
  }), { ok: true, reason: null, warnings: [] });
});

test('self-intersecting repair paths use the actual even-odd mutable fill area', () => {
  const bowTie = boundary('bow-tie', [
    { x: 0, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }, { x: 100, y: 0 },
  ]);
  const policy = deriveRefinementPolicy({
    prompt: '修复交叉区域', annotations: [bowTie], operation: pathScoped, canvas,
  });

  assert.equal(policy.repair_coverage_ratio, 0.5);
  assert.deepEqual(policy.warnings, ['局部修复路径范围较大，可能产生重新构图']);
});

test('explicit full-canvas mode allows text-only edits and derives native tile calls', () => {
  const operation = {
    mode: 'full_canvas_explicit', subject_path_ids: [], alpha_include_path_ids: [],
  };
  const state = refinementSubmissionState({
    prompt: '增强整体高光', paths: [], draft: null, operation,
    canvas: { width: 1024, height: 1243 },
  });
  assert.equal(state.ok, true);
  const policy = deriveRefinementPolicy({ prompt: '增强整体高光', annotations: [], operation, canvas: {
    width: 1024, height: 1243,
  } });
  assert.equal(policy.expected_roi_tile_count, 1);
  assert.equal(policy.maximum_imagegen_calls, 2);
});

test('subject IDs must reference closed boundary paths', () => {
  assert.deepEqual(refinementSubmissionState({
    prompt: '', paths: [erase('copy')], draft: null,
    operation: {
      mode: 'keep_inside_delete_outside',
      subject_path_ids: ['missing'],
      alpha_include_path_ids: [],
    },
    canvas,
  }), {
    ok: false,
    reason: 'subject_path_ids 必须引用闭合 boundary 路径',
    warnings: [],
  });
});

test('normalizes whitespace and calculates polygon coverage independently', () => {
  const policy = deriveRefinementPolicy({
    prompt: '  补全\n  两个\t金币  ', annotations: [boundary('coin')],
    operation: pathScoped, canvas,
  });
  assert.equal(policy.normalized_user_requirement, '补全 两个 金币');
  assert.equal(polygonAreaRatio(boundary('coin').source_polygon_pixels, canvas), 0.04);
});

test('natural-language scope instructions require matching structured operations', () => {
  assert.equal(refinementSubmissionState({
    prompt: '把框外删除', paths: [boundary('subject')], draft: null,
    operation: pathScoped, canvas,
  }).reason, '请开启“仅保留路径内，路径外透明”，不要只在提示词中描述范围');
  assert.equal(refinementSubmissionState({
    prompt: '对整图进行调整', paths: [boundary('coin')], draft: null,
    operation: pathScoped, canvas,
  }).reason, '请明确开启“整图编辑（高风险）”');
});

test('native tile counts use padded bounds, supported canvases, and 32px overlap', () => {
  const policy = deriveRefinementPolicy({
    prompt: '修复',
    annotations: [boundary('wide', [
      { x: 0, y: 0 }, { x: 1800, y: 0 }, { x: 1800, y: 900 }, { x: 0, y: 900 },
    ])],
    operation: pathScoped,
    canvas: { width: 1800, height: 900 },
  });
  assert.equal(RESULT_REFINEMENT_ROI_POLICY.tile_overlap_pixels, 32);
  assert.equal(policy.expected_roi_tile_count, 2);
  assert.equal(policy.maximum_imagegen_calls, 4);
});

test('refinement summary reports path counts and structured scope state', () => {
  const policy = deriveRefinementPolicy({
    prompt: '补全金币',
    annotations: [boundary('subject'), boundary('coin'), erase('copy'), protect('logo')],
    operation: {
      mode: 'keep_inside_delete_outside',
      subject_path_ids: ['subject'],
      alpha_include_path_ids: ['coin'],
    },
    canvas,
  });
  assert.equal(
    refinementSummary(policy),
    '修复 1 处 · 擦除 1 处 · 保护 1 处 · 主体 1 处 · 路径外透明：开启 · 整图编辑：关闭',
  );
});
