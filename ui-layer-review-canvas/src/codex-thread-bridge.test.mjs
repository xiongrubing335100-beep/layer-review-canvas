import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildWorkbenchPrompt,
  buildWorkbenchTurnInput,
  resolvePythonInvocation,
  selectExecutionAttachments,
} from '../codex-thread-bridge.mjs';

const base = {
  jobId: 'job-1',
  jobPath: 'C:/jobs/job-1/layer-review-plan.json',
  sourcePath: 'C:/images/source.png',
  outputDirectory: 'C:/jobs/job-1/final',
  reviewCropPaths: ['C:/jobs/job-1/01-selection.png'],
};

test('compact prompt points to the authoritative plan without duplicating requirements', () => {
  const prompt = buildWorkbenchPrompt({
    ...base,
    plan: { layers: [{ name: '卡片', requirement: 'UNIQUE_LONG_REQUIREMENT' }] },
  });
  assert.equal(prompt.includes('UNIQUE_LONG_REQUIREMENT'), false);
  assert.ok(prompt.includes(base.jobPath));
  assert.ok(prompt.includes('confirm_layer_review_foreground_dispatch'));
  assert.ok(prompt.includes('confirm-layer-review-dispatch.mjs'));
  assert.ok(prompt.includes(base.jobId));
  assert.ok(prompt.length < 1400);
});

test('direct current-thread delivery does not ask for a foreground bridge confirmation', () => {
  const prompt = buildWorkbenchPrompt({
    ...base,
    plan: { layers: [{ name: '卡片' }] },
    requireForegroundConfirmation: false,
  });

  assert.doesNotMatch(prompt, /confirm_layer_review_foreground_dispatch/);
  assert.doesNotMatch(prompt, /confirm-layer-review-dispatch\.mjs/);
});

test('remove-background finalization is delegated to RMBG after Codex finishes the split result', () => {
  const prompt = buildWorkbenchPrompt({
    ...base,
    plan: {
      layers: [{
        id: 'component',
        name: '透明组件',
        category: 'kvElement',
        remove_background: true,
        transparency_strategy: 'rembg',
      }],
    },
  });
  assert.match(prompt, /finalize-rmbg\.py/);
  assert.match(prompt, /isnet-general-use/);
  assert.match(prompt, /Codex 最终拆分结果/);
  assert.match(prompt, /写入 final/);
});

test('split prompts reuse the Python runtime selected during setup', () => {
  assert.equal(resolvePythonInvocation({ IMVIA_LAYER_PYTHON_COMMAND: 'python3' }, 'darwin'), 'python3');
  assert.equal(resolvePythonInvocation({
    IMVIA_LAYER_PYTHON_COMMAND: 'py',
    IMVIA_LAYER_PYTHON_ARGS: '["-3"]',
  }, 'win32'), 'py -3');
});

test('title background removal is routed to visible Codex RGBA without RMBG', () => {
  const prompt = buildWorkbenchPrompt({
    ...base,
    plan: {
      layers: [{
        id: 'title',
        name: 'KV 标题 1',
        category: 'kvTitle',
        remove_background: true,
        transparency_strategy: 'codex_rgba',
      }],
    },
  });

  assert.match(prompt, /文字\/标志透明层：KV 标题 1/);
  assert.match(prompt, /prepare-targeted-imagegen-canvas\.py/);
  assert.match(prompt, /黑底白主体语义 matte/);
  assert.match(prompt, /--imagegen-mapping/);
  assert.match(prompt, /不得调用 RMBG/);
  assert.doesNotMatch(prompt, /--model isnet-general-use/);
});

test('fast ImageGen routes accept a clean first candidate and retry only after failure', () => {
  const prompt = buildWorkbenchPrompt({
    ...base,
    plan: {
      layers: [{ execution_mode: 'fast', execution_route_hint: 'targeted_repair' }],
    },
  });

  assert.match(prompt, /首个工作结果通过尺寸、标注、明显排除和结构完整性验收就立即结束/);
  assert.match(prompt, /仅在失败时允许一次定向 ImageGen 重试/);
  assert.match(prompt, /第二次仍失败则停止/);
  assert.match(prompt, /禁止绕过尺寸校验/);
});

test('completed finalization is the final tool call in the Codex turn', () => {
  const prompt = buildWorkbenchPrompt({
    ...base,
    plan: { layers: [{ execution_mode: 'fast', execution_route_hint: 'direct_crop' }] },
  });

  assert.match(prompt, /该调用必须是本 turn 最后一个工具调用/);
  assert.match(prompt, /禁止再预览、读取或重复校验/);
  assert.match(prompt, /立即交付返回的 PNG 路径并结束回复/);
});

test('checked remove-background layers are stated explicitly in the Codex conversation message', () => {
  const prompt = buildWorkbenchPrompt({
    ...base,
    plan: {
      layers: [
        { id: 'keep-alpha', name: '透明组件', remove_background: true },
        { id: 'keep-background', name: '完整背景', remove_background: false },
      ],
    },
  });

  assert.match(prompt, /去背景已开启/);
  assert.match(prompt, /透明组件/);
  assert.doesNotMatch(prompt, /完整背景.*去背景已开启/);
});

test('fast alpha extraction attaches only the crop image', () => {
  const input = buildWorkbenchTurnInput({
    ...base,
    prompt: 'run',
    plan: { layers: [{ execution_mode: 'fast', execution_route_hint: 'alpha_extract' }] },
  });
  assert.deepEqual(input.filter((item) => item.type === 'localImage').map((item) => item.path), base.reviewCropPaths);
});

test('Codex RGBA attaches only the crop image', () => {
  const input = buildWorkbenchTurnInput({
    ...base,
    prompt: 'run',
    plan: { layers: [{ execution_mode: 'fast', execution_route_hint: 'codex_rgba' }] },
  });
  assert.deepEqual(input.filter((item) => item.type === 'localImage').map((item) => item.path), base.reviewCropPaths);
});

test('targeted repair attaches source context and crop image', () => {
  const input = buildWorkbenchTurnInput({
    ...base,
    prompt: 'run',
    plan: { layers: [{ execution_mode: 'fast', execution_route_hint: 'targeted_repair' }] },
  });
  assert.deepEqual(input.filter((item) => item.type === 'localImage').map((item) => item.path), [
    base.sourcePath,
    ...base.reviewCropPaths,
  ]);
});

test('simple targeted repair uses only the crop when global context is not required', () => {
  const input = buildWorkbenchTurnInput({
    ...base,
    prompt: 'run',
    plan: {
      layers: [{
        execution_mode: 'fast',
        execution_route_hint: 'targeted_repair',
        requires_global_context: false,
      }],
    },
  });
  assert.deepEqual(input.filter((item) => item.type === 'localImage').map((item) => item.path), base.reviewCropPaths);
});

test('direct crop does not attach visual inputs', () => {
  assert.deepEqual(selectExecutionAttachments({
    execution_route_hint: 'direct_crop',
  }, {
    sourcePath: base.sourcePath,
    reviewCropPaths: base.reviewCropPaths,
  }), []);
});

test('refinement attaches the existing transparent source without a crop', () => {
  const input = buildWorkbenchTurnInput({
    ...base,
    prompt: 'run',
    reviewCropPaths: [],
    plan: {
      task: 'refine_split_result',
      layers: [{ execution_mode: 'fast' }],
    },
  });
  assert.deepEqual(input.filter((item) => item.type === 'localImage').map((item) => item.path), [
    base.sourcePath,
  ]);
});
