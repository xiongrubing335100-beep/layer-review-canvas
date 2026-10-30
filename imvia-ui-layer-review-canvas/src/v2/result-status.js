export function exportReadiness(document, composition) {
  const ids = document?.layerOrder || [];
  const current = composition?.documentId === document?.documentId && composition?.documentRevision === document?.revision;
  const missing = ids.filter(id => !current || !composition.layers?.some(layer => layer.layerId === id && layer.versionId));
  return { ready: ids.length > 0 && missing.length === 0, adopted: ids.length - missing.length, total: ids.length, missing };
}

export const candidateLabels = { pending: '待拆分', processing: '处理中', ready: '已完成', validation_pending: '自动检查中', validation_failed: '自动处理失败', quality_failed: '未达到交付标准', stale: '结果已过期', failed: '拆分失败', cancelled: '已取消', inactive: '已移出列表' };

// Use the same revision and eligibility checks as export, not a visit to the review screen.
export function workflowProgress(document, composition) {
  const result = { ...exportReadiness(document, composition), checking: false, splitIds: [], reviewIds: [], processingIds: [], validationIds: [], attentionIds: [] };
  if (!result.total) return result;
  if (composition?.documentId !== document.documentId || composition?.documentRevision !== document.revision) {
    return { ...result, checking: true };
  }
  for (const id of result.missing) {
    const state = composition.states?.[id];
    if (!state) result.checking = true;
    else if (state.versionIds?.length) result.checking = true;
    else if (state.status === 'processing') result.processingIds.push(id);
    else if (state.status === 'validation_pending') result.validationIds.push(id);
    else if (['validation_failed', 'quality_failed'].includes(state.status)) result.attentionIds.push(id);
    else result.splitIds.push(id);
  }
  return result;
}

export function transparencyStatus(alpha) {
  if (!alpha || !Number.isFinite(alpha.min) || !Number.isFinite(alpha.max)) return '未检测';
  if (alpha.max === 0) return '完全透明，无可见内容';
  return alpha.min < 255 ? '含透明像素' : '无透明像素';
}
