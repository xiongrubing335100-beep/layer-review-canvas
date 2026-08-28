const repairIntent = /(?:移除|删除|去掉|去除|擦掉|抹掉).{0,8}(?:文字|文本|数字|水印|内容)|补全.{0,16}(?:底板|空洞|遮挡|缺口|隐藏|被挡)|(?:被遮挡|被挡|遮挡区域|隐藏部分)|修复.{0,8}(?:空洞|遮挡|缺口)|(?:remove|erase|delete)\s+(?:the\s+)?(?:text|copy|numbers?|watermarks?|content)|(?:fill|repair|reconstruct)\s+(?:the\s+)?(?:base|hole|occlusion|gap|hidden\s+area)/i;
const negatedRepairIntent = /(?:不要|无需|无须|不需要|不必|别|禁止)\s*(?:再)?(?:移除|删除|去掉|去除|擦掉|抹掉).{0,8}(?:文字|文本|数字|水印|内容)|(?:do\s+not|don't|dont|never)\s+(?:remove|erase|delete)\s+(?:the\s+)?(?:text|copy|numbers?|watermarks?|content)/gi;
const codexRgbaCategories = new Set(['text', 'brand_ui']);

function normalizedIntent(value) {
  return String(value || '').replace(negatedRepairIntent, '');
}

export function classifyPosterFastRoute({
  processingCategory = '', prompt = '', removeBackground = false,
} = {}) {
  const intent = normalizedIntent(prompt);
  if (repairIntent.test(intent)) return 'targeted_repair';
  if (removeBackground && codexRgbaCategories.has(processingCategory)) return 'codex_rgba';
  if (removeBackground) return 'alpha_extract';
  return 'direct_crop';
}

export function buildPosterFastRouteMetadata({
  processingCategory = '', route = 'direct_crop', removeBackground = false, sourcePixels = {},
} = {}) {
  const transparencyStrategy = route === 'codex_rgba'
    ? 'codex_rgba'
    : route === 'alpha_extract' || (route === 'targeted_repair' && removeBackground)
      ? 'rembg'
      : 'none';
  return {
    execution_route: route,
    transparency_strategy: transparencyStrategy,
    rmbg_required: transparencyStrategy === 'rembg',
    maximum_imagegen_calls: route === 'codex_rgba' || route === 'targeted_repair' ? 1 : 0,
    input_kind: 'frozen_selected_crop',
    output_resolution_policy: 'selected_region_pixels',
    expected_output: {
      width: Number.isFinite(sourcePixels.width) ? sourcePixels.width : null,
      height: Number.isFinite(sourcePixels.height) ? sourcePixels.height : null,
      original_source_x: Number.isFinite(sourcePixels.x) ? sourcePixels.x : null,
      original_source_y: Number.isFinite(sourcePixels.y) ? sourcePixels.y : null,
    },
  };
}
