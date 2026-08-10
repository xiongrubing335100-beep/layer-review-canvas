import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
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
const workbenchSkill = await readFile(new URL('../plugin-template/imvia-layer/skills/split-ui-design-layers-workbench-targeted/SKILL.md', import.meta.url), 'utf8');

function skillSection(title, nextTitle) {
  const start = workbenchSkill.indexOf(title);
  const end = workbenchSkill.indexOf(nextTitle, start + title.length);
  assert.notEqual(start, -1, `missing skill section ${title}`);
  assert.notEqual(end, -1, `missing skill section boundary ${nextTitle}`);
  return workbenchSkill.slice(start, end);
}

test('the workbench skill defines the executable version-2 local ROI refinement contract', () => {
  const section = skillSection('## PNG Result Refinement', '## Performance Report');
  const orderedStages = [
    '当前成功 PNG',
    'normalized_user_requirement',
    'expected_roi_tile_count',
    'maximum_imagegen_calls',
    'prepare-targeted-imagegen-canvas.py',
    'result_refinement_roi_manifest',
    'roi_jobs',
    'reference_path',
    'native 1:1',
    'RGB or RGBA',
    'candidate Alpha is not authoritative',
    '--generated-input roi-id=/absolute/path.png',
    'finalize-targeted-job.py',
    'last tool call',
  ];
  let cursor = -1;
  for (const stage of orderedStages) {
    const next = section.indexOf(stage, cursor + 1);
    assert.ok(next > cursor, `missing or out-of-order result_refinement stage: ${stage}`);
    cursor = next;
  }
  assert.match(section, /one initial candidate and at most one retry per `roi_job`/);
  assert.match(section, /empty `roi_jobs`[\s\S]*?must not call ImageGen/);
  assert.match(section, /resolved Python invocation[\s\S]*?absolute path/);
  assert.match(section, /original source[\s\S]*?earlier PNG version/);
  assert.match(section, /RMBG/);
  assert.match(section, /whole-page analysis/);
  assert.match(section, /forced resize/);
  assert.match(section, /chroma mask/);
  assert.match(section, /prompt-inferred deletion/);
  assert.doesNotMatch(section, /text-only[\s\S]*?full base PNG canvas editable/i);
  assert.doesNotMatch(section, /candidate must be[\s\S]*?RGBA PNG/i);
});

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
  assert.match(prompt, /bria-rmbg/);
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
  assert.doesNotMatch(prompt, /--model bria-rmbg/);
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

test('targeted repair prompts require the fixed ImageGen canvas mapping', () => {
  const prompt = buildWorkbenchPrompt({
    ...base,
    plan: {
      layers: [{
        id: 'component',
        name: 'UI 组件 1',
        execution_mode: 'fast',
        execution_route_hint: 'targeted_repair',
      }],
    },
  });

  assert.match(prompt, /定向修复层：UI 组件 1/);
  assert.match(prompt, /prepare-targeted-imagegen-canvas\.py/);
  assert.match(prompt, /标准参考画布/);
  assert.match(prompt, /--imagegen-mapping/);
  assert.match(prompt, /返回画布尺寸变化则失败/);
});

test('targeted repair RMBG prompt keeps the native ImageGen content resolution', () => {
  const prompt = buildWorkbenchPrompt({
    ...base,
    plan: {
      layers: [{
        id: 'component',
        name: 'UI 组件 1',
        execution_mode: 'fast',
        execution_route_hint: 'targeted_repair',
        remove_background: true,
        transparency_strategy: 'rembg',
        output_resolution_policy: 'native_imagegen_content',
      }],
    },
  });

  assert.match(prompt, /原生 content_region 分辨率直接进入 BRIA RMBG/);
  assert.match(prompt, /框选宽高仅作为画布逻辑尺寸/);
  assert.match(prompt, /禁止在 RMBG 前缩小/);
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
    plan: {
      task: 'refine_split_result',
      layers: [{ execution_mode: 'fast' }],
    },
  });
  assert.deepEqual(input.filter((item) => item.type === 'localImage').map((item) => item.path), [
    base.sourcePath,
  ]);
});

test('refinement still attaches only the source when route-aware context is disabled', () => {
  const previous = process.env.IMVIA_ROUTE_AWARE_CONTEXT_V1;
  process.env.IMVIA_ROUTE_AWARE_CONTEXT_V1 = '0';
  try {
    const input = buildWorkbenchTurnInput({
      ...base,
      prompt: 'run',
      plan: {
        task: 'refine_split_result',
        layers: [{ execution_mode: 'fast' }],
      },
    });
    assert.deepEqual(input.filter((item) => item.type === 'localImage').map((item) => item.path), [
      base.sourcePath,
    ]);
  } finally {
    if (previous === undefined) delete process.env.IMVIA_ROUTE_AWARE_CONTEXT_V1;
    else process.env.IMVIA_ROUTE_AWARE_CONTEXT_V1 = previous;
  }
});

test('result refinement prompt compiles the trusted local ROI policy into an executable message', () => {
  const previousCommand = process.env.IMVIA_LAYER_PYTHON_COMMAND;
  const previousArgs = process.env.IMVIA_LAYER_PYTHON_ARGS;
  process.env.IMVIA_LAYER_PYTHON_COMMAND = 'py';
  process.env.IMVIA_LAYER_PYTHON_ARGS = '["-3"]';
  const annotation = (id, operationRole) => ({
    id,
    shape: 'bezier_path',
    closed: true,
    operation_role: operationRole,
  });
  try {
    const prompt = buildWorkbenchPrompt({
      ...base,
      jobPath: '/workspace/imvia/output/jobs/job-1/layer-review-plan.json',
      plan: {
        task: 'refine_split_result',
        source: { canvas: { width: 1024, height: 1243 } },
        layers: [{
          id: 'button',
          name: '按钮',
          requirement: '  补全两个金币，保持原位置、大小、材质和光影。  ',
          normalized_user_requirement: '补全两个金币，保持原位置、大小、材质和光影。',
          execution_route_hint: 'result_refinement',
          transparency_strategy: 'preserve_existing_alpha',
          refinement_operation: {
            mode: 'path_scoped',
            subject_path_ids: [],
            alpha_include_path_ids: [],
          },
          mask_annotations: [
            annotation('coin-left', 'repair'),
            annotation('coin-right', 'repair'),
            annotation('old-copy', 'erase'),
          ],
          maximum_imagegen_calls: 4,
        }],
      },
    });

    assert.match(prompt, /PNG 结果局部精修层：按钮/);
    assert.match(prompt, /当前成功 PNG 是唯一权威 base；最终尺寸锁定为 1024×1243，禁止缩放或改变画布/);
    assert.match(prompt, /系统理解：2 个修复路径、1 个删除路径、0 个保护路径；路径外保持；非整图编辑/);
    assert.match(prompt, /用户目标：补全两个金币，保持原位置、大小、材质和光影。/);
    assert.match(prompt, /精确修复 ROI 数：2；ImageGen 调用预算：4/);
    assert.match(prompt, /每个 roi_job 只使用自己的 reference_path，原生 1:1 生成候选/);
    assert.match(prompt, /每个 ROI 一次初始候选，失败时最多一次重试/);
    assert.match(prompt, /候选可为 RGB 或 RGBA/);
    assert.match(prompt, /候选 Alpha 不具有最终决定权/);
    assert.match(prompt, /禁止.*RMBG/);
    assert.match(prompt, /py -3 "\/workspace\/imvia\/scripts\/prepare-targeted-imagegen-canvas\.py" --job-id job-1 --layer-id button/);
    assert.match(prompt, /py -3 "\/workspace\/imvia\/scripts\/finalize-targeted-job\.py" --job-id job-1 --layer-id button --generated-input roi-id=\/absolute\/path\.png/);
    assert.match(prompt, /每个 roi_job 重复 --generated-input/);
    assert.match(prompt, /--imagegen-mapping \/absolute\/path\/to\/result_refinement_roi_manifest\.json/);
    assert.match(prompt, /最终处理器.*最后一个工具调用|finalizer.*last tool call/i);
  } finally {
    if (previousCommand === undefined) delete process.env.IMVIA_LAYER_PYTHON_COMMAND;
    else process.env.IMVIA_LAYER_PYTHON_COMMAND = previousCommand;
    if (previousArgs === undefined) delete process.env.IMVIA_LAYER_PYTHON_ARGS;
    else process.env.IMVIA_LAYER_PYTHON_ARGS = previousArgs;
  }
});

test('deterministic-only result refinement forbids ImageGen and finalizes with zero candidate bindings', () => {
  const prompt = buildWorkbenchPrompt({
    ...base,
    plan: {
      task: 'refine_split_result',
      source: { canvas: { width: 1024, height: 1243 } },
      layers: [{
        id: 'button',
        name: '按钮',
        requirement: '',
        normalized_user_requirement: '',
        execution_route_hint: 'result_refinement',
        refinement_operation: {
          mode: 'keep_inside_delete_outside',
          subject_path_ids: ['subject'],
          alpha_include_path_ids: [],
        },
        mask_annotations: [
          { id: 'subject', operation_role: 'subject' },
          { id: 'old-copy', operation_role: 'erase' },
        ],
        maximum_imagegen_calls: 0,
      }],
    },
  });

  assert.match(prompt, /系统理解：0 个修复路径、1 个删除路径、0 个保护路径；路径外透明；非整图编辑/);
  assert.match(prompt, /精确修复 ROI 数：0；ImageGen 调用预算：0/);
  assert.match(prompt, /roi_jobs 为空时禁止调用 ImageGen/);
  assert.match(prompt, /finalizer 仅执行确定性 Alpha 操作/);
  const finalizerLine = prompt.split('\n').find((line) => line.includes('finalize-targeted-job.py'));
  assert.ok(finalizerLine);
  assert.doesNotMatch(finalizerLine, /--generated-input/);
  assert.match(finalizerLine, /--imagegen-mapping \/absolute\/path\/to\/result_refinement_roi_manifest\.json/);
});
