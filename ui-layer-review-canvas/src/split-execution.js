const repairIntent = /(?:移除|删除|去掉|去除|擦掉|抹掉).{0,8}(?:文字|文本|数字|水印|内容)|补全.{0,12}(?:底板|空洞|遮挡|缺口)|修复.{0,8}(?:空洞|遮挡|缺口)|(?:remove|erase|delete)\s+(?:the\s+)?(?:text|copy|numbers?|watermarks?|content)|(?:fill|repair|reconstruct)\s+(?:the\s+)?(?:base|hole|occlusion|gap)/i;
const negatedRepairIntent = /(?:不要|无需|无须|不需要|不必|别|禁止)\s*(?:再)?(?:移除|删除|去掉|去除|擦掉|抹掉).{0,8}(?:文字|文本|数字|水印|内容)|(?:do\s+not|don't|dont|never)\s+(?:remove|erase|delete)\s+(?:the\s+)?(?:text|copy|numbers?|watermarks?|content)/gi;
const runningJobStatuses = new Set(['sending_to_codex', 'sent_to_codex', 'processing', 'partial', 'finalizing']);

export function nextPaint() {
  return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
}

export function isNodeRunning(nodeId, localSubmissions = {}, jobs = []) {
  return Boolean(localSubmissions[nodeId]) || jobs.some((job) => (
    job.nodeIds?.includes(nodeId) && runningJobStatuses.has(job.status)
  ));
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
  categoryDefault = '',
  requirement = '',
  refinementPrompt = '',
  removeBackground = false,
}) {
  const intent = combinedRequirement({ categoryDefault, requirement, refinementPrompt })
    .replace(negatedRepairIntent, '');
  if (repairIntent.test(intent)) return 'targeted_repair';
  return removeBackground ? 'alpha_extract' : 'direct_crop';
}
