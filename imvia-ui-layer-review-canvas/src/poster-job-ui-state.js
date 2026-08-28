import {
  canAdvanceForegroundDispatch,
  isForegroundDispatchStatus,
} from './foreground-dispatch-transitions.js';

const TERMINAL_DISPATCH = new Set([
  'completed', 'PLAN_REVIEW', 'PLAN_CONFIRMED', 'ANALYSIS_FAILED',
  'failed', 'send_failed', 'cancelled', 'abandoned',
]);

const LEGACY_TRANSPORT_ADVANCES = Object.freeze({
  queued: new Set([
    'pending', 'awaiting_codex_message', 'claimed', 'delivered',
    'sending_to_codex', 'submitted_to_conversation', 'sent',
    'host_accepted', 'sent_to_codex', 'ANALYZING', 'processing', 'finalizing',
  ]),
  pending: new Set([
    'awaiting_codex_message', 'claimed', 'delivered', 'sending_to_codex',
    'submitted_to_conversation', 'sent', 'host_accepted', 'sent_to_codex',
    'ANALYZING', 'processing', 'finalizing',
  ]),
  awaiting_codex_message: new Set([
    'claimed', 'delivered', 'sending_to_codex', 'submitted_to_conversation',
    'sent', 'host_accepted', 'sent_to_codex', 'ANALYZING', 'processing', 'finalizing',
  ]),
  sending_to_codex: new Set([
    'submitted_to_conversation', 'sent', 'host_accepted', 'sent_to_codex',
    'ANALYZING', 'processing', 'finalizing',
  ]),
  submitted_to_conversation: new Set([
    'sent', 'host_accepted', 'sent_to_codex', 'ANALYZING', 'processing', 'finalizing',
  ]),
  host_accepted: new Set(['sent', 'sent_to_codex', 'ANALYZING', 'processing', 'finalizing']),
  sent: new Set(['host_accepted', 'sent_to_codex', 'ANALYZING', 'processing', 'finalizing']),
  sent_to_codex: new Set(['ANALYZING', 'processing', 'finalizing']),
  ANALYZING: new Set(['processing', 'finalizing']),
  processing: new Set(['finalizing']),
  finalizing: new Set(),
});

function revision(job) { return Number.isInteger(job?.manifest_revision) ? job.manifest_revision : -1; }

function dispatchStatus(job) {
  return job?.dispatch?.status || '';
}

function dispatchId(job) {
  return job?.dispatch?.dispatch_id ?? job?.dispatch?.dispatchId
    ?? job?.dispatch_id ?? job?.dispatchId ?? null;
}

function normalizeSyntheticQueued(job) {
  if (dispatchStatus(job) !== 'queued') return { job, syntheticQueued: false };
  return {
    syntheticQueued: true,
    job: {
      ...job,
      dispatch: { ...job.dispatch, status: 'pending' },
    },
  };
}

function withTransport(currentJob, incomingJob) {
  return {
    ...currentJob,
    ...(incomingJob.status ? { status: incomingJob.status } : {}),
    ...(incomingJob.dispatch ? { dispatch: incomingJob.dispatch } : {}),
  };
}

function canAdvanceLegacyTransport(currentStatus, incomingStatus) {
  if (currentStatus === incomingStatus) return true;
  if (TERMINAL_DISPATCH.has(currentStatus)) return false;
  if (TERMINAL_DISPATCH.has(incomingStatus)) return true;
  return LEGACY_TRANSPORT_ADVANCES[currentStatus]?.has(incomingStatus) || false;
}

function canAdvanceDispatch(currentStatus, incomingStatus, hasDispatchIdentity) {
  if (isForegroundDispatchStatus(currentStatus) && isForegroundDispatchStatus(incomingStatus)) {
    return canAdvanceForegroundDispatch(currentStatus, incomingStatus);
  }
  if (hasDispatchIdentity && (isForegroundDispatchStatus(currentStatus) || isForegroundDispatchStatus(incomingStatus))) {
    return TERMINAL_DISPATCH.has(incomingStatus) && !TERMINAL_DISPATCH.has(currentStatus);
  }
  return canAdvanceLegacyTransport(currentStatus, incomingStatus);
}

export function mergePosterJobUpdate(currentJob, incomingJob) {
  const normalizedCurrent = normalizeSyntheticQueued(currentJob);
  const normalizedIncoming = normalizeSyntheticQueued(incomingJob);
  currentJob = normalizedCurrent.job;
  incomingJob = normalizedIncoming.job;
  if (!currentJob || currentJob.job_id !== incomingJob?.job_id) return incomingJob;
  if (revision(incomingJob) > revision(currentJob)) return incomingJob;
  if (revision(incomingJob) < revision(currentJob)) return currentJob;
  const currentId = dispatchId(currentJob);
  const incomingId = dispatchId(incomingJob);
  const currentStatus = dispatchStatus(currentJob);
  const incomingStatus = dispatchStatus(incomingJob);

  // A submit response has a new identity even though the plan remains
  // PLAN_CONFIRMED at the same manifest revision.  A new queue may replace a
  // completed/no dispatch, while a delayed old dispatch cannot replace an
  // active new one.
  if (incomingId && incomingId !== currentId) {
    if (!currentId || !currentStatus || TERMINAL_DISPATCH.has(currentStatus)) return incomingJob;
    return currentJob;
  }
  if (!incomingStatus) return currentJob;
  if (!currentStatus) return withTransport(currentJob, incomingJob);
  if (
    normalizedIncoming.syntheticQueued
    && currentId === incomingId
    && isForegroundDispatchStatus(currentStatus)
    && currentStatus !== 'pending'
  ) return currentJob;
  if (!canAdvanceDispatch(currentStatus, incomingStatus, Boolean(currentId || incomingId))) return currentJob;
  return withTransport(currentJob, incomingJob);
}
