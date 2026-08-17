export const PAGE_HEARTBEAT_INTERVAL_MS = 10_000;
export const PAGE_LEASE_TTL_MS = 45_000;
export const WARM_SHUTDOWN_DELAY_MS = 5 * 60_000;
export const ABANDONED_JOB_TTL_MS = 24 * 60 * 60_000;
export const ABANDONED_RESULT_CLEANUP_GRACE_MS = 60_000;
export const UNCONFIRMED_DELIVERY_TTL_MS = 2 * 60_000;

const cancelablePlanStatuses = new Set([
  'queued',
  'awaiting_codex_message',
  'sending_to_codex',
  'host_accepted',
  'submitted_to_conversation',
]);
const startedPlanStatuses = new Set([
  'sent_to_codex',
  'processing',
  'repair_rgb',
  'repair_matte',
  'alpha_matte',
  'partial',
  'finalizing',
]);
const terminalReportStatuses = new Set([
  'completed',
  'failed',
  'needs_confirmation',
]);
const terminalPlanStatuses = new Set([
  'completed',
  'failed',
  'send_failed',
  'needs_confirmation',
  'cancelled',
]);

export function isPageLeaseActive(lease, now = Date.now()) {
  const lastSeen = Date.parse(lease?.lastSeen || '');
  return Number.isFinite(lastSeen) && now - lastSeen <= PAGE_LEASE_TTL_MS;
}

export function activePageLeases(leases, now = Date.now()) {
  return Object.fromEntries(
    Object.entries(leases || {}).filter(([, lease]) => isPageLeaseActive(lease, now)),
  );
}

export function isCancelablePlanStatus(status) {
  return cancelablePlanStatuses.has(status);
}

export function isStartedPlanStatus(status) {
  return startedPlanStatuses.has(status);
}

export function isTerminalExecutionReport(status) {
  return terminalReportStatuses.has(status);
}

export function isStaleUnconfirmedDelivery({
  planStatus,
  submittedAt,
  reportStatus,
  now = Date.now(),
}) {
  if (!['awaiting_codex_message', 'sending_to_codex'].includes(planStatus)) return false;
  if (isTerminalExecutionReport(reportStatus)) return false;
  const submitted = Date.parse(submittedAt || '');
  return Number.isFinite(submitted) && now - submitted >= UNCONFIRMED_DELIVERY_TTL_MS;
}

export function shouldHideAbandonedJob({ lifecycleStatus }) {
  return lifecycleStatus === 'abandoned_running' || lifecycleStatus === 'discarded';
}

export function shouldMarkJobAbandoned({
  lifecycleStatus,
  lifecycleCreatedAt,
  planStatus,
  reportStatus,
  reportCompletedAt,
  pageMissingSince,
}) {
  if (lifecycleStatus !== 'active' || !Number.isFinite(Date.parse(lifecycleCreatedAt || ''))) {
    return false;
  }
  if (!isStartedPlanStatus(planStatus)) return false;
  if (!isTerminalExecutionReport(reportStatus)) return true;
  const completedTime = Date.parse(reportCompletedAt || '');
  return !Number.isFinite(completedTime) || completedTime >= pageMissingSince;
}

export function canCleanAbandonedJob({
  lifecycleStatus,
  reportStatus,
  reportCompletedAt,
  abandonedAt,
  now = Date.now(),
}) {
  if (lifecycleStatus !== 'abandoned_running') return false;
  if (isTerminalExecutionReport(reportStatus)) {
    const completedTime = Date.parse(reportCompletedAt || '');
    return Number.isFinite(completedTime)
      && now - completedTime >= ABANDONED_RESULT_CLEANUP_GRACE_MS;
  }
  const abandonedTime = Date.parse(abandonedAt || '');
  return Number.isFinite(abandonedTime) && now - abandonedTime >= ABANDONED_JOB_TTL_MS;
}

export function shouldEnterWarmShutdown({
  leaseCount: _leaseCount,
  activeJobCount: _activeJobCount,
  cleanupInProgress: _cleanupInProgress,
  idleSince: _idleSince,
  now: _now = Date.now(),
}) {
  // Page leases still drive abandoned-job cleanup, but idleness must never
  // terminate the user-owned workbench. SIGINT/SIGTERM remain the explicit
  // close/restart boundary.
  return false;
}

export function blocksNewSubmission({
  planStatus,
  lifecycleStatus,
  lifecycleCreatedAt,
  reportStatus,
}) {
  if (terminalPlanStatuses.has(planStatus)) return false;
  if (isTerminalExecutionReport(reportStatus)) return false;
  if (!Number.isFinite(Date.parse(lifecycleCreatedAt || ''))) return false;
  if (lifecycleStatus === 'abandoned_running') return false;
  if (lifecycleStatus !== 'active') return false;
  return isCancelablePlanStatus(planStatus) || isStartedPlanStatus(planStatus);
}
