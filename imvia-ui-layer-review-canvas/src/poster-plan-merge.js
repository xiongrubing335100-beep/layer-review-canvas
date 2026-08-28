const PROTECTED_ROLES = new Set(['date', 'cta', 'logo', 'brand', 'price', 'badge', 'icon', 'ui']);

function isHeadline(layer) { return ['headline', 'title'].includes(layer?.asset_role); }
function isProtectedIndependentUi(layer) {
  return PROTECTED_ROLES.has(layer?.asset_role) || layer?.ui_independence === 'independent';
}

export function validatePosterMerge(first, second) {
  if (!first || !second) return { valid: false, code: 'LAYER_REQUIRED', message: '需要选择两个图层' };
  if ((isHeadline(first) && isProtectedIndependentUi(second))
    || (isHeadline(second) && isProtectedIndependentUi(first))) {
    return { valid: false, code: 'UI_BUNDLING_ERROR', message: '独立日期、CTA、Logo、价格、角标和图标不能与标题合并' };
  }
  return { valid: true };
}
