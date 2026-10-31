import assert from 'node:assert/strict';
import test from 'node:test';
import * as jobState from './job-state.js';

const { jobMatchesSource, reconcileTurnStatus, resolveExecutionReportStatus } = jobState;

test('jobs from another uploaded image do not bind to the current layer ids', () => {
  const currentSource = { name: '情报探索-4个副本.png', width: 750, height: 1624 };
  const oldJob = {
    sourceName: 'source.png',
    sourceSize: { width: 1500, height: 3664 },
  };

  assert.equal(jobMatchesSource(oldJob, currentSource), false);
});

test('jobs from the current image remain visible', () => {
  const currentSource = { name: 'screen.png', width: 750, height: 1624 };
  const currentJob = {
    sourceName: 'screen.png',
    sourceSize: { width: 750, height: 1624 },
  };

  assert.equal(jobMatchesSource(currentJob, currentSource), true);
});

test('a reloaded image can recover history by its uploaded-source fingerprint', () => {
  const source = {
    imageId: 'new-document-id',
    sourceFingerprint: 'screen.png:123:456:789',
    sourceRevision: 1,
    name: 'screen.png',
    width: 750,
    height: 1624,
  };
  const job = {
    imageId: 'old-document-id',
    sourceFingerprint: source.sourceFingerprint,
    sourceRevision: 1,
    sourceSize: { width: 750, height: 1624 },
    sourceName: 'screen.png',
  };

  assert.equal(jobMatchesSource(job, source), true);
});

test('a different uploaded image does not match only because its dimensions agree', () => {
  const source = {
    imageId: 'new-document-id',
    sourceFingerprint: 'new.png:123:456:789',
    sourceRevision: 1,
    width: 750,
    height: 1624,
  };
  const job = {
    imageId: 'old-document-id',
    sourceFingerprint: 'old.png:123:456:789',
    sourceRevision: 1,
    sourceSize: { width: 750, height: 1624 },
  };

  assert.equal(jobMatchesSource(job, source), false);
});

test('a completed Codex turn without a PNG does not stay processing', () => {
  assert.deepEqual(reconcileTurnStatus({
    planStatus: 'sent_to_codex',
    turnStatus: 'completed',
    resultReady: false,
    imageCount: 0,
  }), {
    status: 'failed',
    detail: 'Codex 任务已结束，但没有回传拆分 PNG',
  });
});

test('an active Codex turn remains processing', () => {
  assert.deepEqual(reconcileTurnStatus({
    planStatus: 'sent_to_codex',
    turnStatus: 'inProgress',
    resultReady: false,
    imageCount: 0,
  }), {
    status: 'processing',
    detail: null,
  });
});

test('a foreground split stays waiting until the bridge posts it to the conversation', () => {
  assert.deepEqual(reconcileTurnStatus({
    planStatus: 'awaiting_codex_message',
    turnStatus: null,
    resultReady: false,
    imageCount: 0,
  }), {
    status: 'awaiting_codex_message',
    detail: '等待发送到当前 Codex 会话',
  });
});

test('a queued split stays queued until the active conversation task finishes', () => {
  assert.deepEqual(reconcileTurnStatus({
    planStatus: 'queued',
    reportStatus: null,
    turnStatus: null,
    resultReady: false,
    imageCount: 0,
  }), {
    status: 'queued',
    detail: '当前 Codex 拆分完成后将自动发送',
  });
});

test('a transport-submitted message is distinct from a queued split', () => {
  assert.deepEqual(reconcileTurnStatus({
    planStatus: 'submitted_to_conversation',
    turnStatus: null,
    resultReady: false,
    imageCount: 0,
  }), {
    status: 'submitted_to_conversation',
    detail: '旧版宿主已接收，等待当前 Codex 任务确认',
  });
});

test('host acceptance stays distinct from a message confirmed in the current task', () => {
  assert.deepEqual(reconcileTurnStatus({
    planStatus: 'host_accepted',
    turnStatus: null,
    resultReady: false,
    imageCount: 0,
  }), {
    status: 'host_accepted',
    detail: '宿主已接收请求，等待当前 Codex 任务显示并确认',
  });
});

test('a completed execution report finishes a foreground split without a background turn', () => {
  assert.deepEqual(reconcileTurnStatus({
    planStatus: 'sent_to_codex',
    reportStatus: 'completed',
    turnStatus: null,
    resultReady: true,
    imageCount: 1,
  }), {
    status: 'completed',
    detail: null,
  });
});

test('a completed execution report overrides a stale active Codex turn', () => {
  assert.deepEqual(reconcileTurnStatus({
    planStatus: 'sent_to_codex',
    reportStatus: 'completed',
    turnStatus: 'inProgress',
    resultReady: true,
    imageCount: 1,
  }), {
    status: 'completed',
    detail: null,
  });
});

test('a verified legacy report without a status is completed', () => {
  assert.equal(resolveExecutionReportStatus({
    timing: { completed_at: '2026-08-02T13:09:00.000Z' },
    layers: [{
      actual_output_path: 'final/ui-component.png',
      validation: {
        dimensions_pass: true,
        annotation_conformance_pass: true,
        obvious_exclusion_pass: true,
        structure_integrity_pass: true,
      },
    }],
    final_validation: {
      only_requested_layer: true,
      exact_output_size: true,
      real_transparent_rgba_png: true,
      final_png_count: 1,
    },
  }, {
    expectedCount: 1,
    resultReady: true,
  }), 'completed');
});

test('an incomplete legacy report does not become completed from a PNG alone', () => {
  assert.equal(resolveExecutionReportStatus({
    timing: { completed_at: '2026-08-02T13:09:00.000Z' },
    layers: [{ actual_output_path: 'final/ui-component.png', validation: {} }],
    final_validation: { final_png_count: 1 },
  }, {
    expectedCount: 1,
    resultReady: true,
  }), null);
});

test('a completed executor report requires results and mandatory validation', () => {
  const report = {
    status: 'completed',
    validation_results: {
      count: true,
      dimensions: true,
      alpha: true,
      annotation_conformance: true,
      obvious_exclusion: true,
    },
  };
  assert.equal(resolveExecutionReportStatus(report, { expectedCount: 1, resultReady: true }), 'completed');
  assert.equal(resolveExecutionReportStatus(report, { expectedCount: 1, resultReady: false }), null);
  assert.equal(resolveExecutionReportStatus({
    ...report,
    validation_results: { ...report.validation_results, alpha: false },
  }, { expectedCount: 1, resultReady: true }), null);
});

test('a completed result refinement report finishes with its route-specific validation', () => {
  const report = {
    status: 'completed',
    execution_route: 'result_refinement',
    validation_results: {
      dimensions: true,
      alpha: true,
      annotation_conformance: true,
      outside_pixel_lock: true,
      no_baked_checkerboard: true,
      structure_integrity: true,
    },
  };

  assert.equal(resolveExecutionReportStatus(report, {
    expectedCount: 1,
    resultReady: true,
  }), 'completed');
  assert.equal(resolveExecutionReportStatus({
    ...report,
    validation_results: {
      ...report.validation_results,
      outside_pixel_lock: false,
    },
  }, {
    expectedCount: 1,
    resultReady: true,
  }), null);
});

test('an active transparent-repair report exposes its exact stage', () => {
  assert.deepEqual(reconcileTurnStatus({
    planStatus: 'processing',
    reportStatus: 'repair_matte',
    turnStatus: 'inProgress',
    resultReady: false,
    imageCount: 0,
  }), {
    status: 'repair_matte',
    detail: null,
  });
});

test('a completed Codex RGBA repair report finishes with its repair validation', () => {
  const report = {
    status: 'completed',
    execution_route: 'codex_rgba_repair',
    validation_results: {
      dimensions: true,
      alpha: true,
      repair_scope_conformance: true,
      repair_bundle_consistency: true,
      source_pixel_lock: true,
      structure_integrity: true,
    },
  };

  assert.equal(resolveExecutionReportStatus(report, {
    expectedCount: 1,
    resultReady: true,
  }), 'completed');
  assert.equal(resolveExecutionReportStatus({
    ...report,
    validation_results: {
      ...report.validation_results,
      structure_integrity: false,
    },
  }, {
    expectedCount: 1,
    resultReady: true,
  }), null);
  const { repair_bundle_consistency, ...incompleteValidation } = report.validation_results;
  assert.equal(repair_bundle_consistency, true);
  assert.equal(resolveExecutionReportStatus({
    ...report,
    validation_results: incompleteValidation,
  }, {
    expectedCount: 1,
    resultReady: true,
  }), null);
});

test('a confirmation request is not shown as processing', () => {
  assert.deepEqual(reconcileTurnStatus({
    planStatus: 'needs_confirmation',
    turnStatus: 'completed',
    resultReady: false,
    imageCount: 0,
  }), {
    status: 'needs_confirmation',
    detail: 'Codex 需要确认拆分目标后才能继续',
  });
});

test('a failed executor report overrides an active turn and existing PNGs', () => {
  assert.deepEqual(reconcileTurnStatus({
    planStatus: 'sent_to_codex',
    reportStatus: 'failed',
    reportError: '补全蒙版超出已提交遮挡区域',
    turnStatus: 'inProgress',
    resultReady: true,
    imageCount: 1,
  }), {
    status: 'failed',
    detail: '补全蒙版超出已提交遮挡区域',
  });
});

test('a failed executor report overrides a completed turn and existing PNGs', () => {
  assert.deepEqual(reconcileTurnStatus({
    planStatus: 'completed',
    reportStatus: 'failed',
    turnStatus: 'completed',
    resultReady: true,
    imageCount: 1,
  }), {
    status: 'failed',
    detail: null,
  });
});

test('needs confirmation is terminal for polling until resubmission', () => {
  assert.equal(jobState.shouldPollJob?.({
    status: 'needs_confirmation',
    completedAt: null,
    snapshotVerified: false,
  }), false);
});

test('a cancelled queued split is terminal and stops polling', () => {
  assert.deepEqual(reconcileTurnStatus({
    planStatus: 'cancelled',
    turnStatus: null,
    resultReady: false,
    imageCount: 0,
  }), {
    status: 'cancelled',
    detail: null,
  });
  assert.equal(jobState.shouldPollJob?.({
    status: 'cancelled',
    completedAt: Date.now(),
    snapshotVerified: false,
  }), false);
});

test('a recent failed job keeps polling so a successful retry can replace stale state', () => {
  const submittedAt = Date.parse('2026-08-17T07:40:00.000Z');
  const completedAt = Date.parse('2026-08-17T08:50:00.000Z');
  const now = Date.parse('2026-08-17T08:55:00.000Z');

  assert.equal(jobState.shouldPollJob({ status: 'failed', submittedAt, completedAt }, now), true);
});

test('initial reconciliation includes an old failed job without polling it forever', () => {
  const submittedAt = Date.parse('2026-08-17T08:00:00.000Z');
  const now = Date.parse('2026-08-17T09:00:00.000Z');
  const jobs = [{ id: 'job-old-failure', status: 'failed', submittedAt }];

  assert.deepEqual(jobState.jobsForPolling(jobs, { reconcileAll: true, now }), jobs);
  assert.deepEqual(jobState.jobsForPolling(jobs, { now }), []);
});

test('elapsed time stops at report completion timing when available', () => {
  const reportCompletedAt = '2026-07-27T00:00:05.000Z';
  assert.equal(jobState.elapsedEnd?.({
    status: 'needs_confirmation',
    submittedAt: Date.parse('2026-07-27T00:00:00.000Z'),
    confirmationRequestedAt: Date.parse('2026-07-27T00:00:09.000Z'),
    timing: { completed_at: reportCompletedAt },
  }, Date.parse('2026-07-27T00:00:12.000Z')), Date.parse(reportCompletedAt));
});
