import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ABANDONED_JOB_TTL_MS,
  ABANDONED_RESULT_CLEANUP_GRACE_MS,
  PAGE_LEASE_TTL_MS,
  UNCONFIRMED_DELIVERY_TTL_MS,
  WARM_SHUTDOWN_DELAY_MS,
  activePageLeases,
  blocksNewSubmission,
  canCleanAbandonedJob,
  isCancelablePlanStatus,
  isStartedPlanStatus,
  isStaleUnconfirmedDelivery,
  shouldEnterWarmShutdown,
  shouldHideAbandonedJob,
  shouldMarkJobAbandoned,
} from './workbench-lifecycle.js';

const now = Date.parse('2026-07-29T12:00:00.000Z');

test('page leases survive a short refresh but expire after the offline grace', () => {
  const leases = {
    fresh: { lastSeen: new Date(now - 12_000).toISOString() },
    refreshing: { lastSeen: new Date(now - PAGE_LEASE_TTL_MS).toISOString() },
    closed: { lastSeen: new Date(now - PAGE_LEASE_TTL_MS - 1).toISOString() },
  };

  assert.deepEqual(Object.keys(activePageLeases(leases, now)), ['fresh', 'refreshing']);
});

test('only unconfirmed foreground delivery states are cancelable', () => {
  assert.equal(isCancelablePlanStatus('awaiting_codex_message'), true);
  assert.equal(isCancelablePlanStatus('sending_to_codex'), true);
  assert.equal(isCancelablePlanStatus('host_accepted'), true);
  assert.equal(isCancelablePlanStatus('submitted_to_conversation'), true);
  assert.equal(isCancelablePlanStatus('sent_to_codex'), false);
  assert.equal(isStartedPlanStatus('sent_to_codex'), true);
  assert.equal(isStartedPlanStatus('processing'), true);
});

test('an abandoned current-conversation task stays hidden without blocking new submissions', () => {
  const job = {
    planStatus: 'sent_to_codex',
    lifecycleStatus: 'abandoned_running',
    lifecycleCreatedAt: new Date(now - 30_000).toISOString(),
    reportStatus: null,
  };
  assert.equal(shouldHideAbandonedJob(job), true);
  assert.equal(blocksNewSubmission(job), false);
  assert.equal(blocksNewSubmission({ ...job, reportStatus: 'completed' }), false);
});

test('an unconfirmed delivery expires after the short handoff window', () => {
  assert.equal(isStaleUnconfirmedDelivery({
    planStatus: 'sending_to_codex',
    submittedAt: new Date(now - UNCONFIRMED_DELIVERY_TTL_MS - 1).toISOString(),
    reportStatus: null,
    now,
  }), true);
  assert.equal(isStaleUnconfirmedDelivery({
    planStatus: 'host_accepted',
    submittedAt: new Date(now - 10 * UNCONFIRMED_DELIVERY_TTL_MS).toISOString(),
    reportStatus: null,
    now,
  }), false);
});

test('a cancelled task never blocks a new submission even if an abandoned lease remains', () => {
  assert.equal(blocksNewSubmission({
    planStatus: 'cancelled',
    lifecycleStatus: 'abandoned_running',
    lifecycleCreatedAt: new Date(now - 30_000).toISOString(),
    reportStatus: null,
  }), false);
});

test('a terminal plan never blocks a new submission when its execution report is missing', () => {
  for (const planStatus of ['completed', 'failed', 'send_failed', 'needs_confirmation']) {
    assert.equal(blocksNewSubmission({
      planStatus,
      lifecycleStatus: 'abandoned_running',
      lifecycleCreatedAt: new Date(now - 30_000).toISOString(),
      reportStatus: null,
    }), false);
  }
});

test('only lifecycle-managed active jobs block new submissions', () => {
  assert.equal(blocksNewSubmission({
    planStatus: 'sent_to_codex',
    lifecycleStatus: null,
    lifecycleCreatedAt: null,
    reportStatus: null,
  }), false);
  assert.equal(blocksNewSubmission({
    planStatus: 'sent_to_codex',
    lifecycleStatus: 'active',
    lifecycleCreatedAt: new Date(now - 30_000).toISOString(),
    reportStatus: null,
  }), true);
});

test('an ownerless abandoned record created by the old reconciler does not block submissions', () => {
  assert.equal(blocksNewSubmission({
    planStatus: 'sent_to_codex',
    lifecycleStatus: 'abandoned_running',
    lifecycleCreatedAt: null,
    reportStatus: null,
  }), false);
});

test('offline cleanup leaves historical completed results untouched', () => {
  assert.equal(shouldMarkJobAbandoned({
    lifecycleStatus: 'active',
    lifecycleCreatedAt: new Date(now - 30_000).toISOString(),
    planStatus: 'sent_to_codex',
    reportStatus: 'completed',
    reportCompletedAt: new Date(now - 10_000).toISOString(),
    pageMissingSince: now,
  }), false);
  assert.equal(shouldMarkJobAbandoned({
    lifecycleStatus: 'active',
    lifecycleCreatedAt: new Date(now - 30_000).toISOString(),
    planStatus: 'sent_to_codex',
    reportStatus: 'completed',
    reportCompletedAt: new Date(now + 1_000).toISOString(),
    pageMissingSince: now,
  }), true);
});

test('offline cleanup never adopts a legacy job without lifecycle ownership', () => {
  assert.equal(shouldMarkJobAbandoned({
    lifecycleStatus: null,
    planStatus: 'sent_to_codex',
    reportStatus: null,
    reportCompletedAt: null,
    pageMissingSince: now,
  }), false);
});

test('an abandoned task is cleaned only after a terminal report or the conservative ttl', () => {
  const abandonedAt = new Date(now - 1_000).toISOString();
  assert.equal(canCleanAbandonedJob({
    lifecycleStatus: 'abandoned_running',
    reportStatus: null,
    abandonedAt,
    now,
  }), false);
  assert.equal(canCleanAbandonedJob({
    lifecycleStatus: 'abandoned_running',
    reportStatus: 'completed',
    reportCompletedAt: new Date(now - ABANDONED_RESULT_CLEANUP_GRACE_MS).toISOString(),
    abandonedAt,
    now,
  }), true);
  assert.equal(canCleanAbandonedJob({
    lifecycleStatus: 'abandoned_running',
    reportStatus: 'completed',
    reportCompletedAt: new Date(now - ABANDONED_RESULT_CLEANUP_GRACE_MS + 1).toISOString(),
    abandonedAt,
    now,
  }), false);
  assert.equal(canCleanAbandonedJob({
    lifecycleStatus: 'abandoned_running',
    reportStatus: null,
    abandonedAt: new Date(now - ABANDONED_JOB_TTL_MS).toISOString(),
    now,
  }), true);
});

test('warm shutdown waits for no pages, no jobs, no cleanup, and five minutes idle', () => {
  const idleSince = new Date(now - WARM_SHUTDOWN_DELAY_MS).toISOString();
  assert.equal(shouldEnterWarmShutdown({
    leaseCount: 0,
    activeJobCount: 0,
    cleanupInProgress: false,
    idleSince,
    now,
  }), true);
  assert.equal(shouldEnterWarmShutdown({
    leaseCount: 1,
    activeJobCount: 0,
    cleanupInProgress: false,
    idleSince,
    now,
  }), false);
  assert.equal(shouldEnterWarmShutdown({
    leaseCount: 0,
    activeJobCount: 1,
    cleanupInProgress: false,
    idleSince,
    now,
  }), false);
});
