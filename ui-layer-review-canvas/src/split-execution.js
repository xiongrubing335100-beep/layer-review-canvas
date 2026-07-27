const repairIntent = /(移除|删除|去掉|去除).{0,8}(文字|数字|水印|内容)|补全.{0,12}(底板|空洞|遮挡|缺口)|修复.{0,8}(空洞|遮挡|缺口)/;

export function nextPaint() {
  return new Promise((resolve) => requestAnimationFrame(resolve));
}

export function combinedRequirement({
  categoryDefault = '',
  requirement = '',
  refinementPrompt = '',
}) {
  const base = String(requirement).trim() || String(categoryDefault).trim();
  const refinement = String(refinementPrompt).trim();
  return [base, refinement ? `精修补充：${refinement}` : ''].filter(Boolean).join('\n\n');
}

export function classifyExecutionRoute({
  requirement = '',
  refinementPrompt = '',
  removeBackground = false,
}) {
  const intent = `${requirement}\n${refinementPrompt}`;
  if (repairIntent.test(intent)) return 'targeted_repair';
  return removeBackground ? 'alpha_extract' : 'direct_crop';
}
