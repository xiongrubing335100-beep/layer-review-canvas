import { posterCandidateEligibility } from './poster-candidate-eligibility.js';

const terminalFailureStatuses = new Set(['failed', 'send_failed']);
const authoritativeReportStatuses = new Set(['completed', 'failed', 'needs_confirmation']);
const activeRepairStatuses = new Set(['repair_rgb', 'repair_matte', 'alpha_matte']);

const POSTER_GENERATABLE_STATUSES = new Set(['PENDING', 'GENERATION_AUTHORIZED', 'RETRY_AUTHORIZED']);
const POSTER_RETRYABLE_STATUSES = new Set(['NEEDS_USER_REVIEW', 'HARD_REJECTED']);
const POSTER_DIAGNOSTIC_CANDIDATE_STATUSES = new Set(['STALE', 'CANCELLED', 'CANCELLED_LATE', 'INVALID', 'DIAGNOSTIC']);

function valueAt(object, ...keys) {
  for (const key of keys) if (object?.[key] !== undefined) return object[key];
  return undefined;
}

function candidateId(candidate) {
  return valueAt(candidate, 'candidate_id', 'candidateId', 'id');
}

function candidatePlanVersion(candidate) {
  return valueAt(candidate, 'plan_version', 'planVersion');
}

function candidatePath(candidate) {
  return valueAt(candidate, 'preview_url', 'previewUrl', 'candidate_url', 'candidateUrl', 'path', 'candidate_path', 'candidatePath');
}

function failureCodes(value) {
  const result = valueAt(value, 'failure_codes', 'failureCodes');
  return Array.isArray(result) ? result : [];
}

function visualInspection(layer) {
  return valueAt(layer, 'visual_inspection', 'visualInspection') || {};
}

function candidateGate(candidate, inspection) {
  return valueAt(candidate, 'release_gate', 'releaseGate') || valueAt(inspection, 'release_gate', 'releaseGate') || {};
}

function normalizedSize(value, widthKeys, heightKeys) {
  const width = valueAt(value, ...widthKeys);
  const height = valueAt(value, ...heightKeys);
  return Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0
    ? { width, height } : null;
}

function normalizedReviewFacts(candidate, inspection) {
  const stored = valueAt(candidate, 'facts') || candidate?.review?.facts || {};
  const dimensions = valueAt(candidate, 'dimensions', 'candidate_dimensions') || stored.dimensions || stored.canvas_dimensions || {};
  const actual = normalizedSize(dimensions, ['width'], ['height']);
  const expected = normalizedSize(dimensions, ['expected_width', 'expectedWidth'], ['expected_height', 'expectedHeight'])
    || normalizedSize(stored.expectedDimensions || stored.expected_dimensions || stored.sourceSize || stored.source_size, ['width'], ['height']);
  // Finalization stores dimensions.fillColor as the required project key, not
  // a key measured from a rejected PNG. Keep that distinction explicit.
  const expectedKey = valueAt(stored, 'expectedKey', 'expected_key')
    ?? valueAt(dimensions, 'fillColor', 'fill_color')
    ?? null;
  const observedKey = valueAt(stored, 'observedKey', 'observed_key')
    ?? valueAt(candidate, 'observedKey', 'observed_key')
    ?? valueAt(inspection, 'observedKey', 'observed_key')
    ?? null;
  const registration = valueAt(stored, 'registration', 'registrationDetail', 'registration_detail')
    ?? valueAt(candidate, 'registration', 'registrationDetail', 'registration_detail')
    ?? valueAt(inspection, 'registration', 'registrationDetail', 'registration_detail')
    ?? null;
  return {
    dimensions: actual,
    expectedDimensions: expected,
    expectedKey: typeof expectedKey === 'string' && expectedKey ? expectedKey : null,
    observedKey: typeof observedKey === 'string' && observedKey ? observedKey : null,
    registration: typeof registration === 'string' && registration ? registration : null,
  };
}

function candidateDiagnosticReason(candidate, planVersion, inspectionCandidateId) {
  const status = valueAt(candidate, 'status');
  if (POSTER_DIAGNOSTIC_CANDIDATE_STATUSES.has(status)) return status;
  if (candidatePlanVersion(candidate) !== planVersion) return 'STALE_PLAN_VERSION';
  if (inspectionCandidateId && candidateId(candidate) !== inspectionCandidateId) return 'SUPERSEDED_CANDIDATE';
  return null;
}

/**
 * Converts persisted plan/manifest state into a per-layer review model.  The
 * selected candidate must match the current plan and the manifest's visual
 * inspection binding; late, cancelled and stale entries stay diagnostic-only.
 */
export function posterCandidateViewModel(job, layerIndex) {
  const plan = job?.plan || {};
  const manifest = job?.manifest || {};
  const index = Number(layerIndex);
  const planLayer = (Array.isArray(plan.layers) ? plan.layers : [])
    .find((layer) => layer?.layer_index === index) || null;
  const manifestLayer = (Array.isArray(manifest.layers) ? manifest.layers : [])
    .find((layer) => layer?.layer_index === index) || null;
  const status = manifestLayer?.status || planLayer?.status || 'PENDING';
  const planVersion = plan?.plan_version;
  const inspection = visualInspection(manifestLayer);
  const inspectionCandidateId = valueAt(inspection, 'candidate_id', 'candidateId');
  const candidates = (Array.isArray(manifest.candidates) ? manifest.candidates : [])
    .filter((candidate) => candidate?.layer_index === index);
  const retryAuthorized = status === 'RETRY_AUTHORIZED' && manifestLayer?.candidate_output == null
    && inspection?.performed !== true;
  const diagnosticCandidates = candidates
    .map((candidate) => ({ candidate, reason: retryAuthorized ? 'RETRY_AUTHORIZED' : candidateDiagnosticReason(candidate, planVersion, inspectionCandidateId) }))
    .filter(({ reason }) => reason)
    .map(({ candidate, reason }) => ({
      candidateId: candidateId(candidate), candidatePath: candidatePath(candidate), reason,
      status: candidate.status,
    }));
  const activeCandidate = retryAuthorized ? null : candidates.find((candidate) => !candidateDiagnosticReason(candidate, planVersion, inspectionCandidateId)) || null;
  const id = candidateId(activeCandidate) || null;
  const path = candidatePath(activeCandidate) || null;
  const gate = candidateGate(activeCandidate, inspection);
  const codes = [...new Set([...failureCodes(manifestLayer), ...failureCodes(activeCandidate), ...failureCodes(inspection), ...failureCodes(gate)])];
  const facts = normalizedReviewFacts(activeCandidate, inspection);
  const review = {
    status,
    verdict: gate.verdict || inspection.verdict || status,
    failureCodes: codes,
    checks: gate.checks || inspection.checks || {},
    facts,
    notes: activeCandidate?.review_note || manifestLayer?.review_note || null,
    stale: !activeCandidate && candidates.length > 0,
  };
  const canAccept = posterCandidateEligibility({ plan, layer: manifestLayer, candidate: activeCandidate }).eligible;
  return {
    layerIndex: index,
    layer: {
      ...(planLayer || {}), ...(manifestLayer || {}),
      ...(facts.expectedDimensions ? { source_size: facts.expectedDimensions } : {}),
    },
    status,
    candidateId: id,
    candidatePath: path,
    candidateUrl: valueAt(activeCandidate, 'preview_url', 'previewUrl', 'candidate_url', 'candidateUrl') || null,
    execution: manifestLayer?.fast_execution || activeCandidate?.fast_execution || null,
    review,
    canGenerate: plan.status === 'PLAN_CONFIRMED' && POSTER_GENERATABLE_STATUSES.has(status),
    canAccept,
    canRetry: POSTER_RETRYABLE_STATUSES.has(status),
    diagnosticCandidates,
  };
}

const completedValidationKeys = {
  default: ['count', 'dimensions', 'alpha', 'annotation_conformance', 'obvious_exclusion'],
  codex_rgba_repair: [
    'dimensions',
    'alpha',
    'repair_scope_conformance',
    'repair_bundle_consistency',
    'source_pixel_lock',
    'structure_integrity',
  ],
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
  reportError,
  turnStatus,
  resultReady,
  imageCount,
}) {
  if (planStatus === 'cancelled') {
    return { status: 'cancelled', detail: null };
  }
  if (authoritativeReportStatuses.has(reportStatus)) planStatus = reportStatus;
  if (terminalFailureStatuses.has(planStatus)) {
    return { status: 'failed', detail: reportError || null };
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
  if (activeRepairStatuses.has(reportStatus)) {
    return { status: reportStatus, detail: null };
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

const FAILED_JOB_RECOVERY_WINDOW_MS = 30 * 60 * 1000;

export function shouldPollJob(job, now = Date.now()) {
  if (job.status === 'failed') {
    const failedAt = Number(job.completedAt ?? job.submittedAt);
    return Number.isFinite(failedAt)
      && now - failedAt <= FAILED_JOB_RECOVERY_WINDOW_MS;
  }
  return !['send_failed', 'needs_confirmation', 'cancelled'].includes(job.status)
    && (job.status !== 'completed' || !job.completedAt || !job.snapshotVerified);
}

export function jobsForPolling(jobs, { reconcileAll = false, now = Date.now() } = {}) {
  return reconcileAll ? jobs : jobs.filter((job) => shouldPollJob(job, now));
}

export function elapsedEnd(job, clockNow) {
  const reportCompletedAt = Date.parse(job.timing?.completed_at || '');
  if (Number.isFinite(reportCompletedAt)) return reportCompletedAt;
  if (job.status === 'needs_confirmation') {
    return job.confirmationRequestedAt || job.completedAt || job.submittedAt;
  }
  return job.completedAt || clockNow;
}
