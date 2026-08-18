const terminalFailureStatuses = new Set(['failed', 'send_failed']);
const authoritativeReportStatuses = new Set(['completed', 'failed', 'needs_confirmation']);

const completedValidationKeys = {
  default: ['count', 'dimensions', 'alpha', 'annotation_conformance', 'obvious_exclusion'],
  result_refinement: [
    'dimensions',
    'alpha',
    'annotation_conformance',
    'outside_pixel_lock',
    'no_baked_checkerboard',
    'structure_integrity',
  ],
};

function completedValidationPassed(report) {
  const validation = report?.validation_results;
  const keys = completedValidationKeys[report?.execution_route]
    || completedValidationKeys.default;
  return Boolean(validation && keys.every((key) => validation[key] === true));
}

export function resolveExecutionReportStatus(report, { expectedCount, resultReady }) {
  if (report?.status === 'failed' || report?.status === 'needs_confirmation') return report.status;
  if (report?.status === 'completed') {
    if (resultReady && completedValidationPassed(report)) return 'completed';
  }
  if (typeof report?.status === 'string' && report.status !== 'completed') return report.status;
  if (!resultReady || !Number.isInteger(expectedCount) || expectedCount < 1) return null;
  if (!Number.isFinite(Date.parse(report?.timing?.completed_at || ''))) return null;
  if (!Array.isArray(report?.layers) || report.layers.length !== expectedCount) return null;

  const finalValidation = report.final_validation;
  const finalReportPassed = finalValidation?.only_requested_layer === true
    && finalValidation?.exact_output_size === true
    && finalValidation?.real_transparent_rgba_png === true
    && finalValidation?.final_png_count === expectedCount;
  const layersPassed = report.layers.every((layer) => (
    typeof layer.actual_output_path === 'string'
    && layer.actual_output_path.length > 0
    && layer.validation?.dimensions_pass === true
    && layer.validation?.annotation_conformance_pass === true
    && layer.validation?.obvious_exclusion_pass === true
    && layer.validation?.structure_integrity_pass === true
  ));

  return finalReportPassed && layersPassed ? 'completed' : null;
}

export function jobMatchesSource(job, source) {
  if (job?.imageId && source?.imageId) {
    const sameImage = job.imageId === source.imageId;
    const sameUploadedSource = Boolean(
      job.sourceFingerprint
      && source.sourceFingerprint
      && job.sourceFingerprint === source.sourceFingerprint,
    );
    if (!sameImage && !sameUploadedSource) return false;
    return (!job.sourceRevision || !source.sourceRevision || job.sourceRevision === source.sourceRevision)
      && (!job.sourceFingerprint || !source.sourceFingerprint || job.sourceFingerprint === source.sourceFingerprint);
  }
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
  if (planStatus === 'cancelled') {
    return { status: 'cancelled', detail: null };
  }
  if (planStatus === 'needs_confirmation') {
    return {
      status: 'needs_confirmation',
      detail: 'Codex 需要确认拆分目标后才能继续',
    };
  }
  if (reportStatus === 'completed') {
    return resultReady
      ? { status: 'completed', detail: null }
      : { status: 'failed', detail: '任务已结束，但拆分 PNG 数量不完整' };
  }
  if (planStatus === 'queued') {
    return {
      status: 'queued',
      detail: '当前 Codex 拆分完成后将自动发送',
    };
  }
  if (planStatus === 'awaiting_codex_message') {
    return {
      status: 'awaiting_codex_message',
      detail: '等待发送到当前 Codex 会话',
    };
  }
  if (planStatus === 'submitted_to_conversation') {
    return {
      status: 'submitted_to_conversation',
      detail: '旧版宿主已接收，等待当前 Codex 任务确认',
    };
  }
  if (planStatus === 'host_accepted') {
    return {
      status: 'host_accepted',
      detail: '宿主已接收请求，等待当前 Codex 任务显示并确认',
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
  return !['failed', 'send_failed', 'needs_confirmation', 'cancelled'].includes(job.status)
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
