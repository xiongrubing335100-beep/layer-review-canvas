import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { withDirectoryLock } from './file-lock.js';
import { isAbandonablePlanStatus } from './workbench-lifecycle.js';

export {
  FOREGROUND_DISPATCH_TRANSITIONS,
  canAdvanceForegroundDispatch,
  isForegroundDispatchStatus,
} from './foreground-dispatch-transitions.js';

const dispatchFileName = 'foreground-dispatch.json';
const planFileName = 'layer-review-plan.json';
const reportFileName = 'execution-report.json';
const posterReportFileName = 'poster-execution-report.json';
const posterDispatchDirectory = 'foreground-dispatches';
const queueSequenceFileName = '.foreground-queue-sequence.json';
const posterPlanFileName = 'poster-layer-plan.json';
const posterTaskKinds = new Set(['poster_analysis', 'poster_candidate']);
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
  // Lock order: foreground dispatch lock first, then poster-job-store's job lock.
  // Cancel/abandon only take this lock; finalization retains it through publication.
  return withDirectoryLock(path.join(jobDirectory, '.foreground-dispatch.lock'), action);
}

/** Serialize a poster reservation/reconciliation transaction with finalizers,
 * controls, and the foreground queue record for this exact job. */
export async function withForegroundDispatchLock(jobDirectory, action) {
  if (typeof action !== 'function') throw new TypeError('foreground dispatch action must be a function');
  return withJobDispatchLock(jobDirectory, action);
}


function rootKindForJobDirectory(jobDirectory) {
  const rootName = path.basename(path.dirname(path.resolve(jobDirectory)));
  if (rootName === 'poster-jobs') return 'poster';
  return 'ui';
}

function expectedPlanPath(jobDirectory, rootKind) {
  return path.join(jobDirectory, rootKind === 'poster' ? posterPlanFileName : planFileName);
}

function dispatchPath(jobDirectory, rootKind, dispatchId) {
  if (rootKind === 'ui') return path.join(jobDirectory, dispatchFileName);
  if (typeof dispatchId !== 'string' || !/^[a-zA-Z0-9-]+$/.test(dispatchId)) throw new Error('poster dispatchId 无效');
  return path.join(jobDirectory, posterDispatchDirectory, `${dispatchId}.json`);
}

function assertDispatchBinding(jobDirectory, dispatch, rootKind) {
  if (!dispatch || dispatch.rootKind !== rootKind || dispatch.jobId !== path.basename(jobDirectory)) {
    throw new Error('dispatch 根目录或 jobId 不匹配');
  }
  if (path.resolve(dispatch.planPath || '') !== expectedPlanPath(jobDirectory, rootKind)) {
    throw new Error('dispatch 计划路径不匹配');
  }
  if (rootKind === 'ui' && dispatch.taskKind !== 'ui_layer_review') throw new Error('UI dispatch 类型无效');
  if (rootKind === 'poster') {
    if (!posterTaskKinds.has(dispatch.taskKind) || typeof dispatch.dispatchId !== 'string') {
      throw new Error('poster dispatch 类型或标识无效');
    }
    if (dispatch.taskKind === 'poster_candidate' && (!Number.isInteger(dispatch.layerIndex) || !Number.isInteger(dispatch.candidateNumber))) {
      throw new Error('poster 候选 dispatch 绑定无效');
    }
  }
}

async function readDispatchAt(jobDirectory, { dispatchId = null, rootKind = null } = {}) {
  const actualRootKind = rootKindForJobDirectory(jobDirectory);
  if (rootKind && rootKind !== actualRootKind) throw new Error('dispatch 根类型不匹配');
  if (actualRootKind === 'poster' && !dispatchId) throw new Error('poster 操作需要 dispatchId');
  const file = dispatchPath(jobDirectory, actualRootKind, dispatchId);
  const raw = JSON.parse(await readFile(file, 'utf8'));
  const dispatch = actualRootKind === 'ui' && !raw.rootKind ? {
    ...raw,
    rootKind: 'ui', taskKind: 'ui_layer_review', dispatchId: raw.dispatchId || `legacy-${path.basename(jobDirectory)}`,
    planPath: raw.planPath || expectedPlanPath(jobDirectory, 'ui'),
  } : raw;
  assertDispatchBinding(jobDirectory, dispatch, actualRootKind);
  if (dispatchId && dispatch.dispatchId !== dispatchId) throw new Error('dispatchId 不匹配');
  return { dispatch, file, rootKind: actualRootKind };
}

async function listDispatches(jobDirectory) {
  const rootKind = rootKindForJobDirectory(jobDirectory);
  const files = rootKind === 'ui'
    ? [path.join(jobDirectory, dispatchFileName)]
    : (await readdir(path.join(jobDirectory, posterDispatchDirectory)).catch(() => []))
      .filter((name) => /^[a-zA-Z0-9-]+\.json$/.test(name))
      .map((name) => path.join(jobDirectory, posterDispatchDirectory, name));
  const records = [];
  for (const file of files) {
    try {
      const raw = JSON.parse(await readFile(file, 'utf8'));
      const dispatch = rootKind === 'ui' && !raw.rootKind ? {
        ...raw,
        rootKind: 'ui', taskKind: 'ui_layer_review', dispatchId: raw.dispatchId || `legacy-${path.basename(jobDirectory)}`,
        planPath: raw.planPath || expectedPlanPath(jobDirectory, 'ui'),
      } : raw;
      assertDispatchBinding(jobDirectory, dispatch, rootKind);
      records.push({ dispatch, jobDirectory, file, rootKind });
    } catch (error) {
      if (error.code !== 'ENOENT') continue;
    }
  }
  return records;
}

function containsPath(root, target) {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(target);
  return resolvedTarget === resolvedRoot || resolvedTarget.startsWith(`${resolvedRoot}${path.sep}`);
}

function resolveDispatchPlanPath(jobDirectory, dispatch, allowedOutputRoots = []) {
  const rootKind = dispatch?.rootKind || rootKindForJobDirectory(jobDirectory);
  const expected = expectedPlanPath(jobDirectory, rootKind);
  if (dispatch?.planPath && path.resolve(dispatch.planPath) !== expected) {
    throw new Error('dispatch 计划路径不匹配');
  }
  return expected;
}

function commonAncestor(paths) {
  const components = paths.map((item) => path.resolve(item).split(path.sep));
  const first = components[0] || [];
  let length = first.length;
  for (const current of components.slice(1)) {
    length = Math.min(length, current.length);
    for (let index = 0; index < length; index += 1) {
      if (first[index] !== current[index]) {
        length = index;
        break;
      }
    }
  }
  const joined = first.slice(0, length).join(path.sep);
  return joined || path.parse(path.resolve(paths[0])).root;
}

function queueLockForRoots(roots) {
  return path.join(commonAncestor(roots), '.foreground-queue.lock');
}

function compareQueuedDispatches(left, right) {
  const submitted = String(left.dispatch.submittedAt || '').localeCompare(String(right.dispatch.submittedAt || ''));
  if (submitted !== 0) return submitted;
  const leftOrdinal = Number(left.dispatch.enqueueOrdinal || 0);
  const rightOrdinal = Number(right.dispatch.enqueueOrdinal || 0);
  if (leftOrdinal !== rightOrdinal) return leftOrdinal - rightOrdinal;
  return String(left.dispatch.dispatchId || '').localeCompare(String(right.dispatch.dispatchId || ''));
}

async function nextQueueOrdinal(outputDirectory) {
  const file = path.join(outputDirectory, queueSequenceFileName);
  let current = 0;
  try {
    current = Number(JSON.parse(await readFile(file, 'utf8')).last || 0);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const ordinal = current + 1;
  await writeFile(file, JSON.stringify({ last: ordinal }, null, 2));
  return ordinal;
}

async function readReport(jobDirectory) {
  for (const filename of [reportFileName, posterReportFileName]) {
    try {
      return JSON.parse(await readFile(path.join(jobDirectory, filename), 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  return null;
}

async function readPendingDispatches(jobsDirectory, allowedOutputRoots = [path.dirname(jobsDirectory)]) {
  const entries = await readdir(jobsDirectory, { withFileTypes: true }).catch(() => []);
  const records = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      const jobDirectory = path.join(jobsDirectory, entry.name);
      for (const record of await listDispatches(jobDirectory)) {
        const { dispatch } = record;
        if (dispatch.status !== 'pending' && dispatch.status !== 'claimed') continue;
        const report = await readReport(jobDirectory);
        if (terminalReportStatuses.has(report?.status)) continue;
        records.push(record);
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  records.sort(compareQueuedDispatches);
  return records;
}

async function readPendingDispatchesFromRoots(roots) {
  const allowedOutputRoots = roots.map((root) => path.dirname(path.resolve(root)));
  const records = (await Promise.all(roots.map((root) => readPendingDispatches(root, allowedOutputRoots)))).flat();
  records.sort(compareQueuedDispatches);
  return records;
}

async function hasInFlightConversationJobFromRoots(roots, ignoredDispatches = new Set()) {
  const allowedOutputRoots = roots.map((root) => path.dirname(path.resolve(root)));
  for (const jobsDirectory of roots) {
    const entries = await readdir(jobsDirectory, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const jobDirectory = path.join(jobsDirectory, entry.name);
      if (!entry.isDirectory()) continue;
    try {
      const report = await readReport(jobDirectory);
      if (terminalReportStatuses.has(report?.status)) continue;
      const rootKind = rootKindForJobDirectory(jobDirectory);
      const dispatches = await listDispatches(jobDirectory);
      if (dispatches.some(({ dispatch }) => !ignoredDispatches.has(`${jobDirectory}:${dispatch.dispatchId}`)
        && ['claimed', 'delivered', 'sent', 'finalizing'].includes(dispatch.status))) return true;
      if (rootKind === 'ui') {
        if (dispatches.some(({ dispatch }) => ignoredDispatches.has(`${jobDirectory}:${dispatch.dispatchId}`))) continue;
        const plan = JSON.parse(await readFile(expectedPlanPath(jobDirectory, 'ui'), 'utf8'));
        if (inFlightPlanStatuses.has(plan.status)) return true;
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    }
  }
  return false;
}

async function updatePlanStatus(jobDirectory, dispatch, status, extra = {}, allowedOutputRoots = [path.dirname(jobDirectory)]) {
  if ((dispatch?.rootKind || rootKindForJobDirectory(jobDirectory)) === 'poster') return;
  const planPath = resolveDispatchPlanPath(jobDirectory, dispatch, allowedOutputRoots);
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
    dispatchId: hydrated.dispatchId,
    rootKind: hydrated.rootKind,
    prompt: hydrated.prompt,
    submittedAt: hydrated.submittedAt,
    bridgeId: hydrated.bridgeId,
    claimToken: hydrated.claimToken,
    claimedAt: hydrated.claimedAt,
    leaseExpiresAt: hydrated.leaseExpiresAt,
    workbenchSessionId: hydrated.workbenchSessionId || workbenchSessionId || null,
    taskKind: hydrated.taskKind || 'ui_layer_review',
    ...(hydrated.layerIndex ? { layerIndex: hydrated.layerIndex, candidateNumber: hydrated.candidateNumber } : {}),
    ...(hydrated.presentation ? { presentation: hydrated.presentation } : {}),
  };
}

export async function enqueueForegroundDispatch(jobDirectory, dispatch) {
  const jobsDirectory = path.dirname(jobDirectory);
  const rootKind = rootKindForJobDirectory(jobDirectory);
  const normalized = {
    ...dispatch,
    jobId: dispatch.jobId || path.basename(jobDirectory),
    rootKind,
    taskKind: rootKind === 'ui' ? 'ui_layer_review' : dispatch.taskKind,
    dispatchId: dispatch.dispatchId || randomUUID(),
    planPath: dispatch.planPath || expectedPlanPath(jobDirectory, rootKind),
    status: 'pending',
  };
  assertDispatchBinding(jobDirectory, normalized, rootKind);
  const [rootEntry, jobEntry] = await Promise.all([lstat(jobsDirectory), lstat(jobDirectory)]);
  if (!rootEntry.isDirectory() || rootEntry.isSymbolicLink() || !jobEntry.isDirectory() || jobEntry.isSymbolicLink()) {
    throw new Error('dispatch 任务目录不安全');
  }
  const [physicalRoot, physicalJob] = await Promise.all([realpath(jobsDirectory), realpath(jobDirectory)]);
  if (!containsPath(physicalRoot, physicalJob)) throw new Error('dispatch 任务目录越界');
  await withDirectoryLock(path.join(path.dirname(jobsDirectory), '.foreground-queue.lock'), async () => {
    normalized.enqueueOrdinal = await nextQueueOrdinal(path.dirname(jobsDirectory));
    if (rootKind === 'poster') await mkdir(path.join(jobDirectory, posterDispatchDirectory), { recursive: true });
    await writeFile(dispatchPath(jobDirectory, rootKind, normalized.dispatchId), JSON.stringify(normalized, null, 2));
  });
  return normalized;
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

export async function readNextForegroundDispatchFromRoots(roots) {
  const records = await readPendingDispatchesFromRoots(roots);
  const next = records.find(({ dispatch }) => dispatch.status === 'pending')?.dispatch;
  return next ? {
    jobId: next.jobId,
    prompt: next.prompt,
    submittedAt: next.submittedAt,
    taskKind: next.taskKind || 'ui_layer_review',
    ...(next.presentation ? { presentation: next.presentation } : {}),
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

export async function readForegroundQueueSummaryFromRoots(
  roots,
  { bridgeId = null, workbenchSessionId = null } = {},
) {
  const records = await readPendingDispatchesFromRoots(roots);
  const visible = records.filter(({ dispatch }) => (
    isDispatchForListener(dispatch, bridgeId, workbenchSessionId)
  ));
  return {
    count: visible.length,
    jobIds: visible.map(({ dispatch }) => dispatch.jobId),
  };
}

export async function claimNextForegroundDispatchFromRoots(roots, {
  bridgeId,
  workbenchSessionId = null,
  claimedAt = new Date().toISOString(),
  leaseMs = 5_000,
} = {}) {
  if (!bridgeId) throw new Error('会话桥接缺少实例标识');
  if (!Array.isArray(roots) || roots.length === 0) throw new TypeError('至少需要一个任务队列目录');
  const normalizedRoots = roots.map((root) => path.resolve(root));
  const allowedOutputRoots = normalizedRoots.map((root) => path.dirname(root));
  return withDirectoryLock(queueLockForRoots(normalizedRoots), async () => {
    const now = Date.parse(claimedAt);
    const records = await readPendingDispatchesFromRoots(normalizedRoots);
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

    const expiredClaimDirectories = new Set(records
      .filter(({ dispatch }) => (
        dispatch.status === 'claimed'
        && (
          !Number.isFinite(Date.parse(dispatch.leaseExpiresAt))
          || Date.parse(dispatch.leaseExpiresAt) <= now
        )
      ))
      .map(({ jobDirectory, dispatch }) => `${jobDirectory}:${dispatch.dispatchId}`));
    if (await hasInFlightConversationJobFromRoots(normalizedRoots, expiredClaimDirectories)) return null;

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
      const current = await readDispatchAt(next.jobDirectory, {
        dispatchId: next.dispatch.dispatchId,
        rootKind: next.rootKind,
      });
      const dispatch = current.dispatch;
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
          current.file,
          JSON.stringify(claimedDispatch, null, 2),
        ),
        updatePlanStatus(next.jobDirectory, claimedDispatch, 'sending_to_codex', {
          codex_message_claimed_at: claimedAt,
        }, allowedOutputRoots),
      ]);
      return toClaimResponse(claimedDispatch, workbenchSessionId);
    });
  });
}

export async function claimNextForegroundDispatch(jobsDirectory, options = {}) {
  return claimNextForegroundDispatchFromRoots([jobsDirectory], options);
}

export async function markForegroundDispatchDelivered(jobDirectory, {
  bridgeId,
  claimToken,
  deliveredAt = new Date().toISOString(),
  dispatchId = null,
  rootKind = null,
} = {}) {
  return withJobDispatchLock(jobDirectory, async () => {
    const record = await readDispatchAt(jobDirectory, { dispatchId, rootKind });
    const dispatch = record.dispatch;
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
      writeFile(record.file, JSON.stringify({
        ...dispatch,
        status: 'delivered',
        deliveredAt,
        leaseExpiresAt: null,
      }, null, 2)),
      updatePlanStatus(jobDirectory, dispatch, 'host_accepted', {
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
  dispatchId = null,
  rootKind = null,
} = {}) {
  return withJobDispatchLock(jobDirectory, async () => {
    const record = await readDispatchAt(jobDirectory, { dispatchId, rootKind });
    const dispatch = record.dispatch;
    if (
      !['claimed', 'delivered'].includes(dispatch.status)
      || dispatch.bridgeId !== bridgeId
      || dispatch.claimToken !== claimToken
    ) {
      return false;
    }
    await Promise.all([
      writeFile(record.file, JSON.stringify({
        ...dispatch,
        status: 'pending',
        bridgeId: null,
        claimToken: null,
        claimedAt: null,
        deliveredAt: null,
        leaseExpiresAt: null,
        releasedAt,
        lastError: error,
      }, null, 2)),
      updatePlanStatus(jobDirectory, dispatch, 'awaiting_codex_message', {
        codex_message_last_error: error,
      }),
    ]);
    return true;
  });
}

export async function acknowledgeForegroundDispatch(jobDirectory, sentAt, {
  confirmationSource = null,
  dispatchId = null,
  rootKind = null,
} = {}) {
  if (confirmationSource !== 'codex_model_tool') {
    throw new Error('拆分消息必须由当前 Codex 任务确认后才能标记为已发送');
  }
  return withJobDispatchLock(jobDirectory, async () => {
    const record = await readDispatchAt(jobDirectory, { dispatchId, rootKind });
    const dispatch = record.dispatch;
    const planPath = resolveDispatchPlanPath(jobDirectory, dispatch, [path.dirname(jobDirectory)]);
    const plan = JSON.parse(await readFile(planPath, 'utf8'));
    if (dispatch.status === 'cancelled' || (record.rootKind === 'ui' && ['cancelled', 'CANCELLED'].includes(plan.status))) {
      throw new Error('拆分任务已取消，不能继续执行');
    }
    if (dispatch.status === 'sent' && (record.rootKind === 'poster' || [
        'sent_to_codex',
        'processing',
        'finalizing',
        'completed',
        'failed',
        'needs_confirmation',
      ].includes(plan.status))) return true;
    if (
      dispatch.status !== 'delivered'
      || (record.rootKind === 'ui' && !['host_accepted', 'submitted_to_conversation'].includes(plan.status))
    ) {
      throw new Error('拆分消息尚未由宿主接收，不能标记为当前任务已接收');
    }
    await Promise.all([
      writeFile(record.file, JSON.stringify({
        ...dispatch,
        status: 'sent',
        sentAt,
      }, null, 2)),
      ...(record.rootKind === 'ui' ? [writeFile(planPath, JSON.stringify({
        ...plan,
        status: 'sent_to_codex',
        codex_message_sent_at: sentAt,
        codex_message_confirmation: confirmationSource,
      }, null, 2))] : []),
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

export async function cancelForegroundDispatch(jobDirectory, cancelledAt, { dispatchId = null, rootKind = null } = {}) {
  return withJobDispatchLock(jobDirectory, async () => {
    const record = await readDispatchAt(jobDirectory, { dispatchId, rootKind });
    const dispatch = record.dispatch;
    const planPath = resolveDispatchPlanPath(jobDirectory, dispatch, [path.dirname(jobDirectory)]);
    const plan = JSON.parse(await readFile(planPath, 'utf8'));
    if (dispatch.status === 'cancelled' || dispatch.status === 'completed') return true;
    if (
      !['pending', 'claimed', 'delivered'].includes(dispatch.status)
      || ![
        'queued',
        'awaiting_codex_message',
        'sending_to_codex',
        'host_accepted',
        'submitted_to_conversation',
      ].includes(plan.status) && record.rootKind !== 'poster'
    ) {
      throw new Error('任务已被 Codex 接收，无法取消');
    }
    await Promise.all([
      writeFile(record.file, JSON.stringify({
        ...dispatch,
        status: 'cancelled',
        cancelledAt,
      }, null, 2)),
      ...(record.rootKind === 'ui' ? [writeFile(planPath, JSON.stringify({
        ...plan,
        status: 'cancelled',
        cancelled_at: cancelledAt,
      }, null, 2))] : []),
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
    if (['cancelled', 'CANCELLED'].includes(plan.status)) return true;
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

export async function abandonForegroundJob(
  jobDirectory,
  abandonedAt = new Date().toISOString(),
  { dispatchId = null, rootKind = null } = {},
) {
  return withJobDispatchLock(jobDirectory, async () => {
    const record = await readDispatchAt(jobDirectory, { dispatchId, rootKind });
    const dispatch = record.dispatch;
    const planPath = resolveDispatchPlanPath(jobDirectory, dispatch, [path.dirname(jobDirectory)]);
    const plan = JSON.parse(await readFile(planPath, 'utf8'));
    if (dispatch.status === 'cancelled' || dispatch.status === 'completed' || (record.rootKind === 'ui' && ['cancelled', 'CANCELLED'].includes(plan.status))) return true;
    if (!isAbandonablePlanStatus(plan.status) && record.rootKind !== 'poster') {
      throw new Error('当前任务不是可放弃的执行中任务');
    }

    let report = null;
    try {
      report = JSON.parse(await readFile(path.join(jobDirectory, reportFileName), 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    if (terminalReportStatuses.has(report?.status)) {
      throw new Error('任务已经结束，不能再放弃');
    }

    const writes = [
      ...(record.rootKind === 'ui' ? [writeFile(planPath, JSON.stringify({
        ...plan,
        status: 'cancelled',
        cancelled_at: abandonedAt,
        cancel_reason: 'user_abandoned_running_job',
        codex_turn_may_continue: true,
      }, null, 2))] : []),
    ];
    if (dispatch) {
      writes.push(writeFile(record.file, JSON.stringify({
        ...dispatch,
        status: 'cancelled',
        cancelledAt: abandonedAt,
        cancelReason: 'user_abandoned_running_job',
      }, null, 2)));
    }
    await Promise.all(writes);
    return true;
  });
}

export async function assertForegroundDispatchPublishable(jobDirectory, { dispatchId, rootKind = 'poster' } = {}) {
  return withJobDispatchLock(jobDirectory, async () => {
    const { dispatch } = await readDispatchAt(jobDirectory, { dispatchId, rootKind });
    if (dispatch.status === 'cancelled' || dispatch.status === 'completed') {
      throw new Error('foreground dispatch 已取消或已结束，禁止发布迟到结果');
    }
    if (!['sent', 'finalizing'].includes(dispatch.status)) throw new Error('foreground dispatch 尚未由当前会话确认');
    return true;
  });
}

export async function assertForegroundDispatchBinding(jobDirectory, {
  dispatchId, rootKind = 'poster', taskKind, layerIndex, candidateNumber, authorizationId, planVersion,
} = {}) {
  return withJobDispatchLock(jobDirectory, async () => {
    const { dispatch } = await readDispatchAt(jobDirectory, { dispatchId, rootKind });
    for (const [key, value] of Object.entries({ taskKind, layerIndex, candidateNumber, authorizationId, planVersion })) {
      if (value !== undefined && dispatch[key] !== value) throw new Error(`foreground dispatch ${key} 不匹配`);
    }
    return dispatch;
  });
}

export async function completeForegroundDispatch(jobDirectory, { dispatchId, rootKind = 'poster', completedAt = new Date().toISOString() } = {}) {
  return withJobDispatchLock(jobDirectory, async () => {
    const record = await readDispatchAt(jobDirectory, { dispatchId, rootKind });
    if (record.dispatch.status === 'completed') return true;
    if (record.dispatch.status === 'cancelled') throw new Error('foreground dispatch 已取消，不能完成');
    if (!['sent', 'finalizing'].includes(record.dispatch.status)) throw new Error('foreground dispatch 尚未确认，不能完成');
    await writeFile(record.file, JSON.stringify({ ...record.dispatch, status: 'completed', completedAt }, null, 2));
    return true;
  });
}

export async function failForegroundDispatch(jobDirectory, {
  dispatchId,
  rootKind = 'poster',
  failedAt = new Date().toISOString(),
  failureCodes = ['GENERATION_FAILED'],
  error,
  binding = {},
  persistFailure,
  allowedStatuses = ['sent', 'finalizing'],
  afterPersistFailure,
  afterDispatchFailure,
} = {}) {
  if (persistFailure !== undefined && typeof persistFailure !== 'function') throw new TypeError('persistFailure must be a function');
  if (!Array.isArray(allowedStatuses) || allowedStatuses.length === 0
    || !allowedStatuses.every((status) => ['delivered', 'sent', 'finalizing'].includes(status))) {
    throw new TypeError('allowedStatuses must contain legal active foreground dispatch states');
  }
  if (afterPersistFailure !== undefined && typeof afterPersistFailure !== 'function') throw new TypeError('afterPersistFailure must be a function');
  if (afterDispatchFailure !== undefined && typeof afterDispatchFailure !== 'function') throw new TypeError('afterDispatchFailure must be a function');
  return withJobDispatchLock(jobDirectory, async () => {
    const record = await readDispatchAt(jobDirectory, { dispatchId, rootKind });
    if (record.dispatch.status === 'failed') return true;
    if (record.dispatch.status === 'cancelled' || record.dispatch.status === 'completed') {
      throw new Error('foreground dispatch 已取消或已结束，禁止发布迟到结果');
    }
    for (const [key, value] of Object.entries(binding)) {
      if (value !== undefined && record.dispatch[key] !== value) throw new Error(`foreground dispatch ${key} 不匹配`);
    }
    if (!allowedStatuses.includes(record.dispatch.status)) throw new Error('foreground dispatch 尚未由当前会话确认');
    await persistFailure?.();
    await afterPersistFailure?.();
    await writeFile(record.file, JSON.stringify({
      ...record.dispatch,
      status: 'failed',
      failedAt,
      failureCodes: Array.isArray(failureCodes) ? [...failureCodes] : ['GENERATION_FAILED'],
      failureMessage: String(error || 'poster candidate generation failed'),
    }, null, 2));
    await afterDispatchFailure?.();
    return true;
  });
}

export async function finalizeForegroundDispatch(jobDirectory, {
  dispatchId,
  rootKind = 'poster',
  completedAt = new Date().toISOString(),
  publish,
  binding = {},
} = {}) {
  if (typeof publish !== 'function') throw new TypeError('publish must be a function');
  return withJobDispatchLock(jobDirectory, async () => {
    const record = await readDispatchAt(jobDirectory, { dispatchId, rootKind });
    if (record.dispatch.status === 'cancelled' || record.dispatch.status === 'completed') {
      throw new Error('foreground dispatch 已取消或已结束，禁止发布迟到结果');
    }
    for (const [key, value] of Object.entries(binding)) {
      if (value !== undefined && record.dispatch[key] !== value) throw new Error(`foreground dispatch ${key} 不匹配`);
    }
    if (!['sent', 'finalizing'].includes(record.dispatch.status)) throw new Error('foreground dispatch 尚未由当前会话确认');
    if (record.dispatch.status === 'sent') {
      await writeFile(record.file, JSON.stringify({ ...record.dispatch, status: 'finalizing', finalizingAt: new Date().toISOString() }, null, 2));
    }
    const result = await publish();
    await writeFile(record.file, JSON.stringify({ ...record.dispatch, status: 'completed', completedAt }, null, 2));
    return result;
  });
}

export async function readForegroundDispatch(jobDirectory, { dispatchId, rootKind = null } = {}) {
  const { dispatch } = await readDispatchAt(jobDirectory, { dispatchId, rootKind });
  return { jobId: dispatch.jobId, dispatchId: dispatch.dispatchId, rootKind: dispatch.rootKind, taskKind: dispatch.taskKind, status: dispatch.status,
    layerIndex: dispatch.layerIndex, candidateNumber: dispatch.candidateNumber, authorizationId: dispatch.authorizationId, planVersion: dispatch.planVersion };
}
