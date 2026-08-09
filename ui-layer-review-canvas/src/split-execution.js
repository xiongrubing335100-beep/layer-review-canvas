const repairIntent = /(?:移除|删除|去掉|去除|擦掉|抹掉).{0,8}(?:文字|文本|数字|水印|内容)|补全.{0,12}(?:底板|空洞|遮挡|缺口)|修复.{0,8}(?:空洞|遮挡|缺口)|(?:remove|erase|delete)\s+(?:the\s+)?(?:text|copy|numbers?|watermarks?|content)|(?:fill|repair|reconstruct)\s+(?:the\s+)?(?:base|hole|occlusion|gap)/i;
const negatedRepairIntent = /(?:不要|无需|无须|不需要|不必|别|禁止)\s*(?:再)?(?:移除|删除|去掉|去除|擦掉|抹掉).{0,8}(?:文字|文本|数字|水印|内容)|(?:do\s+not|don't|dont|never)\s+(?:remove|erase|delete)\s+(?:the\s+)?(?:text|copy|numbers?|watermarks?|content)/gi;
const globalContextIntent = /(?:遮挡|被挡|补全.{0,12}(?:底板|背景|空洞|缺口)|修复.{0,8}(?:底板|背景|空洞|缺口)|完整背景|occlusion|reconstruct\s+(?:the\s+)?(?:background|base|hole|gap))/i;
const codexRgbaCategories = new Set(['kvTitle', 'ordinaryText', 'logo']);
export const RMBG_MODEL = 'bria-rmbg';
const runningJobStatuses = new Set([
  'queued',
  'sending_to_codex',
  'awaiting_codex_message',
  'host_accepted',
  'submitted_to_conversation',
  'sent_to_codex',
  'processing',
  'partial',
  'finalizing',
]);

export function nextPaint() {
  return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
}

export function isNodeRunning(nodeId, localSubmissions = {}, jobs = []) {
  return Boolean(localSubmissions[nodeId]) || jobs.some((job) => (
    job.nodeIds?.includes(nodeId) && runningJobStatuses.has(job.status)
  ));
}

export function combinedRequirement({
  category = '',
  categoryDefault = '',
  requirement = '',
  refinementPrompt = '',
  removeBackground = false,
}) {
  const base = String(requirement).trim() || String(categoryDefault).trim();
  const refinement = String(refinementPrompt).trim();
  const strategy = transparencyStrategy({ category, removeBackground });
  const backgroundRemoval = strategy === 'codex_rgba'
    ? '去背景要求：直接拆出当前文字或标志主体并输出真实透明 RGBA PNG；保留完整字形、描边、渐变、材质和附着光效；禁止将全不透明底图作为拆分结果；此类图层不得使用 RMBG。'
    : strategy === 'rembg'
      ? `去背景要求：最终仅保留当前图层主体并输出真实透明 RGBA PNG；完成 Codex 最终拆分结果后，必须使用 RMBG 2.0（${RMBG_MODEL}）去除背景。`
      : '';
  return [
    base,
    refinement ? `精修补充：${refinement}` : '',
    backgroundRemoval,
  ].filter(Boolean).join('\n\n');
}

export function transparencyStrategy({ category = '', removeBackground = false } = {}) {
  if (!removeBackground) return 'none';
  return codexRgbaCategories.has(category) ? 'codex_rgba' : 'rembg';
}

export function buildExecutionPolicy({
  executionMode = 'fast',
  executionRoute = 'direct_crop',
}) {
  if (executionMode !== 'fast' || executionRoute !== 'targeted_repair') return null;
  return {
    first_candidate_gate: 'validate_then_short_circuit',
    acceptance_checks: [
      'dimensions',
      'annotation_conformance',
      'obvious_exclusion',
      'structure_integrity',
    ],
    on_pass: 'skip_repair_mask_and_source_lock_then_finalize',
    on_fail: 'single_imagegen_retry_then_fail',
  };
}

export function buildRouteMetadata({
  category = '',
  requirement = '',
  executionMode = 'fast',
  executionRoute = 'direct_crop',
  removeBackground = false,
  sourceRegionPixels = {},
}) {
  const isRepair = executionRoute === 'targeted_repair';
  const isQuality = executionMode === 'quality';
  const transparency = transparencyStrategy({ category, removeBackground });
  const requiresGlobalContext = isQuality
    || category === 'kvBackground'
    || (isRepair && globalContextIntent.test(String(requirement)));
  const maximumImagegenCalls = isRepair || transparency === 'codex_rgba' ? 2 : 0;
  const codexAlphaMatte = transparency === 'codex_rgba';
  return {
    repair_engine: isRepair ? 'imagegen' : 'none',
    requires_global_context: requiresGlobalContext,
    maximum_imagegen_calls: maximumImagegenCalls,
    transparency_strategy: transparency,
    rmbg_required: transparency === 'rembg',
    structure_validation_required: transparency === 'codex_rgba',
    imagegen_input_kind: codexAlphaMatte ? 'codex_alpha_matte' : null,
    imagegen_canvas_policy: codexAlphaMatte ? 'prepared_source_locked_canvas' : null,
    ...(isRepair && transparency === 'rembg'
      ? { output_resolution_policy: 'native_imagegen_content' }
      : {}),
    expected_output: {
      width: Number.isFinite(sourceRegionPixels.width) ? sourceRegionPixels.width : null,
      height: Number.isFinite(sourceRegionPixels.height) ? sourceRegionPixels.height : null,
      original_source_x: Number.isFinite(sourceRegionPixels.x) ? sourceRegionPixels.x : null,
      original_source_y: Number.isFinite(sourceRegionPixels.y) ? sourceRegionPixels.y : null,
    },
  };
}

export function classifyExecutionRoute({
  category = '',
  categoryDefault = '',
  requirement = '',
  refinementPrompt = '',
  removeBackground = false,
}) {
  const intent = combinedRequirement({ category, categoryDefault, requirement, refinementPrompt })
    .replace(negatedRepairIntent, '');
  const transparency = transparencyStrategy({ category, removeBackground });
  if (transparency === 'codex_rgba') return 'codex_rgba';
  if (repairIntent.test(intent)) return 'targeted_repair';
  return transparency === 'rembg' ? 'alpha_extract' : 'direct_crop';
}
