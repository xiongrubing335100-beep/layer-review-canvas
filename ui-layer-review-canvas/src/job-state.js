const terminalFailureStatuses = new Set(['failed', 'send_failed']);
const authoritativeReportStatuses = new Set(['failed', 'needs_confirmation']);

export function jobMatchesSource(job, source) {
  if (!job?.sourceSize?.width || !job?.sourceSize?.height) return false;
  if (job.sourceName && job.sourceName !== source.name) return false;
  return job.sourceSize.width === source.width && job.sourceSize.height === source.height;
}

export function reconcileTurnStatus({
  planStatus,
  reportStatus,
  turnStatus,
  resultReady,
  imageCount,
}) {
  if (authoritativeReportStatuses.has(reportStatus)) planStatus = reportStatus;
  if (terminalFailureStatuses.has(planStatus)) {
    return { status: 'failed', detail: null };
  }
  if (planStatus === 'needs_confirmation') {
    return {
      status: 'needs_confirmation',
      detail: 'Codex 需要确认拆分目标后才能继续',
    };
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

export function shouldPollJob(job) {
  return !['failed', 'send_failed', 'needs_confirmation'].includes(job.status)
    && (job.status !== 'completed' || !job.completedAt || !job.snapshotVerified);
}

export function elapsedEnd(job, clockNow) {
  const reportCompletedAt = Date.parse(job.timing?.completed_at || '');
  if (Number.isFinite(reportCompletedAt)) return reportCompletedAt;
  if (job.status === 'needs_confirmation') {
    return job.confirmationRequestedAt || job.completedAt || job.submittedAt;
  }
  return job.completedAt || clockNow;
}
