import { randomUUID } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { withDirectoryLock } from './file-lock.js';

const dispatchFileName = 'foreground-dispatch.json';
const planFileName = 'layer-review-plan.json';
const reportFileName = 'execution-report.json';
const inFlightPlanStatuses = new Set([
  'sending_to_codex',
  'host_accepted',
  'submitted_to_conversation',
  'sent_to_codex',
  'processing',
  'partial',
  'finalizing',
]);
const terminalReportStatuses = new Set(['completed', 'failed', 'needs_confirmation']);

function withJobDispatchLock(jobDirectory, action) {
  return withDirectoryLock(path.join(jobDirectory, '.foreground-dispatch.lock'), action);
}

async function readPendingDispatches(jobsDirectory) {
  const entries = await readdir(jobsDirectory, { withFileTypes: true }).catch(() => []);
  const records = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      const jobDirectory = path.join(jobsDirectory, entry.name);
      const dispatch = JSON.parse(await readFile(
        path.join(jobDirectory, dispatchFileName),
        'utf8',
      ));
      if (dispatch.status === 'pending' || dispatch.status === 'claimed') {
        let report = null;
        try {
          report = JSON.parse(await readFile(path.join(jobDirectory, reportFileName), 'utf8'));
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
        }
        if (terminalReportStatuses.has(report?.status)) continue;
        records.push({ dispatch, jobDirectory });
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  records.sort((left, right) => (
    left.dispatch.submittedAt.localeCompare(right.dispatch.submittedAt)
  ));
  return records;
}

async function hasInFlightConversationJob(jobsDirectory, ignoredJobIds = new Set()) {
  const entries = await readdir(jobsDirectory, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory() || ignoredJobIds.has(entry.name)) continue;
    try {
      const jobDirectory = path.join(jobsDirectory, entry.name);
      const plan = JSON.parse(await readFile(path.join(jobDirectory, planFileName), 'utf8'));
      let report = null;
      try {
        report = JSON.parse(await readFile(path.join(jobDirectory, reportFileName), 'utf8'));
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      if (terminalReportStatuses.has(report?.status)) continue;
      if (inFlightPlanStatuses.has(plan.status)) return true;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  return false;
}

async function updatePlanStatus(jobDirectory, status, extra = {}) {
  const planPath = path.join(jobDirectory, planFileName);
  const plan = JSON.parse(await readFile(planPath, 'utf8'));
  await writeFile(planPath, JSON.stringify({
    ...plan,
    status,
    ...extra,
  }, null, 2));
}

function isDispatchForListener(dispatch, bridgeId, workbenchSessionId) {
  const sameWorkbenchSession = Boolean(
    workbenchSessionId
    && dispatch.workbenchSessionId
    && dispatch.workbenchSessionId === workbenchSessionId,
  );
  return (
    !dispatch.targetBridgeId
    || dispatch.targetBridgeId === bridgeId
    || sameWorkbenchSession
  ) && (
    !dispatch.workbenchSessionId
    || dispatch.workbenchSessionId === workbenchSessionId
  );
}

async function hydrateDispatch(dispatch) {
  const presentation = dispatch.presentation;
  if (!presentation?.previewPath) return dispatch;
  try {
    const data = await readFile(presentation.previewPath);
    return {
      ...dispatch,
      presentation: {
        ...presentation,
        preview: {
          mimeType: 'image/png',
          data: data.toString('base64'),
          path: presentation.previewPath,
        },
      },
    };
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return dispatch;
  }
}

async function toClaimResponse(dispatch, workbenchSessionId = null) {
  const hydrated = await hydrateDispatch(dispatch);
  return {
    jobId: hydrated.jobId,
    prompt: hydrated.prompt,
    submittedAt: hydrated.submittedAt,
    bridgeId: hydrated.bridgeId,
    claimToken: hydrated.claimToken,
    claimedAt: hydrated.claimedAt,
    leaseExpiresAt: hydrated.leaseExpiresAt,
    workbenchSessionId: hydrated.workbenchSessionId || workbenchSessionId || null,
    ...(hydrated.presentation ? { presentation: hydrated.presentation } : {}),
  };
}

export async function enqueueForegroundDispatch(jobDirectory, dispatch) {
  const jobsDirectory = path.dirname(jobDirectory);
  await withDirectoryLock(path.join(jobsDirectory, '.foreground-queue.lock'), async () => {
    await writeFile(path.join(jobDirectory, dispatchFileName), JSON.stringify({
      ...dispatch,
      status: 'pending',
    }, null, 2));
  });
}

export async function readNextForegroundDispatch(jobsDirectory) {
  const records = await readPendingDispatches(jobsDirectory);
  const next = records.find(({ dispatch }) => dispatch.status === 'pending')?.dispatch;
  return next ? {
    jobId: next.jobId,
    prompt: next.prompt,
    submittedAt: next.submittedAt,
  } : null;
}

export async function readForegroundQueueSummary(
  jobsDirectory,
  { bridgeId = null, workbenchSessionId = null } = {},
) {
  const records = await readPendingDispatches(jobsDirectory);
  const visible = records.filter(({ dispatch }) => (
    isDispatchForListener(dispatch, bridgeId, workbenchSessionId)
  ));
  return {
    count: visible.length,
    jobIds: visible.map(({ dispatch }) => dispatch.jobId),
  };
}

export async function claimNextForegroundDispatch(jobsDirectory, {
  bridgeId,
  workbenchSessionId = null,
  claimedAt = new Date().toISOString(),
  leaseMs = 5_000,
} = {}) {
  if (!bridgeId) throw new Error('会话桥接缺少实例标识');
  return withDirectoryLock(path.join(jobsDirectory, '.foreground-queue.lock'), async () => {
    const now = Date.parse(claimedAt);
    const records = await readPendingDispatches(jobsDirectory);
    const activeClaim = records.find(({ dispatch }) => (
      isDispatchForListener(dispatch, bridgeId, workbenchSessionId)
      &&
      dispatch.status === 'claimed'
      && Number.isFinite(Date.parse(dispatch.leaseExpiresAt))
      && Date.parse(dispatch.leaseExpiresAt) > now
    ));
    if (activeClaim) {
      if (activeClaim.dispatch.bridgeId !== bridgeId) return null;
      return toClaimResponse(activeClaim.dispatch, workbenchSessionId);
    }

    const expiredClaimJobIds = new Set(records
      .filter(({ dispatch }) => (
        dispatch.status === 'claimed'
        && (
          !Number.isFinite(Date.parse(dispatch.leaseExpiresAt))
          || Date.parse(dispatch.leaseExpiresAt) <= now
        )
      ))
      .map(({ dispatch }) => dispatch.jobId));
    if (await hasInFlightConversationJob(jobsDirectory, expiredClaimJobIds)) return null;

    const next = records.find(({ dispatch }) => (
      isDispatchForListener(dispatch, bridgeId, workbenchSessionId)
      && (
        dispatch.status === 'pending'
        || (
          dispatch.status === 'claimed'
          && (
            !Number.isFinite(Date.parse(dispatch.leaseExpiresAt))
            || Date.parse(dispatch.leaseExpiresAt) <= now
          )
        )
      )
    ));
    if (!next) return null;

    return withJobDispatchLock(next.jobDirectory, async () => {
      const dispatch = JSON.parse(await readFile(
        path.join(next.jobDirectory, dispatchFileName),
        'utf8',
      ));
      if (
        dispatch.status !== 'pending'
        && !(
          dispatch.status === 'claimed'
          && (
            !Number.isFinite(Date.parse(dispatch.leaseExpiresAt))
            || Date.parse(dispatch.leaseExpiresAt) <= now
          )
        )
      ) return null;

      const claimToken = randomUUID();
      const leaseExpiresAt = new Date(now + leaseMs).toISOString();
      const claimedDispatch = {
        ...dispatch,
        status: 'claimed',
        bridgeId,
        claimToken,
        claimedAt,
        leaseExpiresAt,
        deliveryAttempts: Number(dispatch.deliveryAttempts || 0) + 1,
      };
      await Promise.all([
        writeFile(
          path.join(next.jobDirectory, dispatchFileName),
          JSON.stringify(claimedDispatch, null, 2),
        ),
        updatePlanStatus(next.jobDirectory, 'sending_to_codex', {
          codex_message_claimed_at: claimedAt,
        }),
      ]);
      return toClaimResponse(claimedDispatch, workbenchSessionId);
    });
  });
}

export async function markForegroundDispatchDelivered(jobDirectory, {
  bridgeId,
  claimToken,
  deliveredAt = new Date().toISOString(),
} = {}) {
  return withJobDispatchLock(jobDirectory, async () => {
    const dispatchPath = path.join(jobDirectory, dispatchFileName);
    const dispatch = JSON.parse(await readFile(dispatchPath, 'utf8'));
    if (
      dispatch.status === 'delivered'
      && dispatch.bridgeId === bridgeId
      && dispatch.claimToken === claimToken
    ) {
      return true;
    }
    if (
      dispatch.status !== 'claimed'
      || dispatch.bridgeId !== bridgeId
      || dispatch.claimToken !== claimToken
    ) {
      throw new Error('拆分消息领取凭证已失效');
    }
    await Promise.all([
      writeFile(dispatchPath, JSON.stringify({
        ...dispatch,
        status: 'delivered',
        deliveredAt,
        leaseExpiresAt: null,
      }, null, 2)),
      updatePlanStatus(jobDirectory, 'host_accepted', {
        codex_host_accepted_at: deliveredAt,
      }),
    ]);
    return true;
  });
}

export async function releaseForegroundDispatchClaim(jobDirectory, {
  bridgeId,
  claimToken,
  releasedAt = new Date().toISOString(),
  error = null,
} = {}) {
  return withJobDispatchLock(jobDirectory, async () => {
    const dispatchPath = path.join(jobDirectory, dispatchFileName);
    const dispatch = JSON.parse(await readFile(dispatchPath, 'utf8'));
    if (
      dispatch.status !== 'claimed'
      || dispatch.bridgeId !== bridgeId
      || dispatch.claimToken !== claimToken
    ) {
      return false;
    }
    await Promise.all([
      writeFile(dispatchPath, JSON.stringify({
        ...dispatch,
        status: 'pending',
        bridgeId: null,
        claimToken: null,
        claimedAt: null,
        leaseExpiresAt: null,
        releasedAt,
        lastError: error,
      }, null, 2)),
      updatePlanStatus(jobDirectory, 'awaiting_codex_message', {
        codex_message_last_error: error,
      }),
    ]);
    return true;
  });
}

export async function acknowledgeForegroundDispatch(jobDirectory, sentAt, {
  confirmationSource = null,
} = {}) {
  if (confirmationSource !== 'codex_model_tool') {
    throw new Error('拆分消息必须由当前 Codex 任务确认后才能标记为已发送');
  }
  return withJobDispatchLock(jobDirectory, async () => {
    const dispatchPath = path.join(jobDirectory, dispatchFileName);
    const planPath = path.join(jobDirectory, planFileName);
    const dispatch = JSON.parse(await readFile(dispatchPath, 'utf8'));
    const plan = JSON.parse(await readFile(planPath, 'utf8'));
    if (dispatch.status === 'cancelled' || plan.status === 'cancelled') {
      throw new Error('拆分任务已取消，不能继续执行');
    }
    if (
      dispatch.status === 'sent'
      && [
        'sent_to_codex',
        'processing',
        'finalizing',
        'completed',
        'failed',
        'needs_confirmation',
      ].includes(plan.status)
    ) return true;
    if (
      dispatch.status !== 'delivered'
      || !['host_accepted', 'submitted_to_conversation'].includes(plan.status)
    ) {
      throw new Error('拆分消息尚未由宿主接收，不能标记为当前任务已接收');
    }
    await Promise.all([
      writeFile(dispatchPath, JSON.stringify({
        ...dispatch,
        status: 'sent',
        sentAt,
      }, null, 2)),
      writeFile(planPath, JSON.stringify({
        ...plan,
        status: 'sent_to_codex',
        codex_message_sent_at: sentAt,
        codex_message_confirmation: confirmationSource,
      }, null, 2)),
    ]);
    return true;
  });
}

export async function markDirectConversationMessageSent(
  jobDirectory,
  sentAt = new Date().toISOString(),
) {
  return withJobDispatchLock(jobDirectory, async () => {
    const planPath = path.join(jobDirectory, planFileName);
    const plan = JSON.parse(await readFile(planPath, 'utf8'));
    if (plan.status === 'host_accepted' || plan.status === 'sent_to_codex') return true;
    if (plan.status !== 'awaiting_codex_message') {
      throw new Error('拆分任务当前不能标记为会话已接收');
    }
    await writeFile(planPath, JSON.stringify({
      ...plan,
      status: 'host_accepted',
      codex_host_accepted_at: sentAt,
      delivery_channel: 'current_conversation',
    }, null, 2));
    return true;
  });
}

export async function markDirectConversationMessageFailed(
  jobDirectory,
  error,
  failedAt = new Date().toISOString(),
) {
  return withJobDispatchLock(jobDirectory, async () => {
    const planPath = path.join(jobDirectory, planFileName);
    const plan = JSON.parse(await readFile(planPath, 'utf8'));
    if (['completed', 'failed', 'cancelled', 'sent_to_codex'].includes(plan.status)) return false;
    await writeFile(planPath, JSON.stringify({
      ...plan,
      status: 'send_failed',
      send_failed_at: failedAt,
      send_error: String(error || '当前会话拒绝接收拆分消息'),
    }, null, 2));
    return true;
  });
}

export async function acknowledgeDirectConversationMessage(
  jobDirectory,
  sentAt,
  { confirmationSource = null } = {},
) {
  if (confirmationSource !== 'codex_model_tool') {
    throw new Error('拆分消息必须由当前 Codex 任务确认后才能标记为已发送');
  }
  return withJobDispatchLock(jobDirectory, async () => {
    const planPath = path.join(jobDirectory, planFileName);
    const plan = JSON.parse(await readFile(planPath, 'utf8'));
    if ([
      'sent_to_codex',
      'processing',
      'finalizing',
      'completed',
      'failed',
      'needs_confirmation',
    ].includes(plan.status)) return true;
    if (plan.status !== 'host_accepted') {
      throw new Error('拆分消息尚未由当前会话接收，不能开始执行');
    }
    await writeFile(planPath, JSON.stringify({
      ...plan,
      status: 'sent_to_codex',
      codex_message_sent_at: sentAt,
      codex_message_confirmation: confirmationSource,
    }, null, 2));
    return true;
  });
}

export async function cancelForegroundDispatch(jobDirectory, cancelledAt) {
  return withJobDispatchLock(jobDirectory, async () => {
    const dispatchPath = path.join(jobDirectory, dispatchFileName);
    const planPath = path.join(jobDirectory, planFileName);
    const dispatch = JSON.parse(await readFile(dispatchPath, 'utf8'));
    const plan = JSON.parse(await readFile(planPath, 'utf8'));
    if (
      !['pending', 'claimed', 'delivered'].includes(dispatch.status)
      || ![
        'queued',
        'awaiting_codex_message',
        'sending_to_codex',
        'host_accepted',
        'submitted_to_conversation',
      ].includes(plan.status)
    ) {
      throw new Error('任务已被 Codex 接收，无法取消');
    }
    await Promise.all([
      writeFile(dispatchPath, JSON.stringify({
        ...dispatch,
        status: 'cancelled',
        cancelledAt,
      }, null, 2)),
      writeFile(planPath, JSON.stringify({
        ...plan,
        status: 'cancelled',
        cancelled_at: cancelledAt,
      }, null, 2)),
    ]);
    return true;
  });
}

export async function cancelDirectConversationJob(
  jobDirectory,
  cancelledAt = new Date().toISOString(),
) {
  return withJobDispatchLock(jobDirectory, async () => {
    const planPath = path.join(jobDirectory, planFileName);
    const plan = JSON.parse(await readFile(planPath, 'utf8'));
    if (plan.status === 'cancelled') return true;
    if (!['awaiting_codex_message', 'host_accepted'].includes(plan.status)) {
      throw new Error('任务已被当前 Codex 会话接收，无法取消');
    }
    await writeFile(planPath, JSON.stringify({
      ...plan,
      status: 'cancelled',
      cancelled_at: cancelledAt,
    }, null, 2));
    return true;
  });
}
