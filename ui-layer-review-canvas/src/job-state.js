const terminalFailureStatuses = new Set(['failed', 'send_failed']);

export function jobMatchesSource(job, source) {
  if (!job?.sourceSize?.width || !job?.sourceSize?.height) return false;
  if (job.sourceName && job.sourceName !== source.name) return false;
  return job.sourceSize.width === source.width && job.sourceSize.height === source.height;
}

export function reconcileTurnStatus({
  planStatus,
  turnStatus,
  resultReady,
  imageCount,
}) {
  if (terminalFailureStatuses.has(planStatus)) {
    return { status: 'failed', detail: null };
  }
  if (turnStatus === 'inProgress') {
    return { status: 'processing', detail: null };
  }
  if (turnStatus === 'failed' || turnStatus === 'interrupted' || turnStatus === 'missing') {
    return {
      status: 'failed',
      detail: turnStatus === 'missing'
        ? '未找到对应的 Codex 拆分任务'
        : 'Codex 拆分任务已结束，未完成结果回传',
    };
  }
  if (turnStatus === 'completed') {
    if (resultReady) return { status: 'completed', detail: null };
    return {
      status: 'failed',
      detail: imageCount
        ? 'Codex 任务已结束，但拆分 PNG 数量不完整'
        : 'Codex 任务已结束，但没有回传拆分 PNG',
    };
  }
  if (planStatus === 'completed') {
    return resultReady
      ? { status: 'completed', detail: null }
      : { status: 'failed', detail: '任务已结束，但拆分 PNG 数量不完整' };
  }
  if (resultReady) return { status: 'finalizing', detail: null };
  if (imageCount > 0) return { status: 'partial', detail: null };
  return {
    status: planStatus === 'sending_to_codex' ? 'sending_to_codex' : 'processing',
    detail: null,
  };
}
