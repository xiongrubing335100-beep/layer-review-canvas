import { randomUUID } from 'node:crypto';
import {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import {
  ABANDONED_JOB_TTL_MS,
  activePageLeases,
  blocksNewSubmission,
  canCleanAbandonedJob,
  isCancelablePlanStatus,
  isStartedPlanStatus,
  isStaleUnconfirmedDelivery,
  isTerminalExecutionReport,
} from './workbench-lifecycle.js';

const runtimeDirectoryName = 'workbench-runtime';
const leasesFileName = 'page-leases.json';
const lifecycleFileName = 'job-lifecycle.json';
const tombstonesFileName = 'discarded-jobs.json';
let storeMutation = Promise.resolve();

function serializeStoreMutation(action) {
  const next = storeMutation.then(action, action);
  storeMutation = next.catch(() => {});
  return next;
}

function runtimeDirectory(outputDirectory) {
  return path.join(outputDirectory, runtimeDirectoryName);
}

async function readJson(filePath, fallback) {
  try {
    return JSON.parse(await readFile(filePath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT' || error instanceof SyntaxError) return fallback;
    throw error;
  }
}

async function writeJson(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, JSON.stringify(value, null, 2));
  await rename(temporaryPath, filePath);
}

export async function heartbeatPageLease(outputDirectory, {
  pageId,
  seenAt = new Date().toISOString(),
}) {
  if (!pageId) throw new Error('页面租约缺少实例标识');
  return serializeStoreMutation(async () => {
    const filePath = path.join(runtimeDirectory(outputDirectory), leasesFileName);
    const state = await readJson(filePath, { leases: {} });
    state.leases[pageId] = {
      pageId,
      lastSeen: seenAt,
      suspectedClosedAt: null,
    };
    await writeJson(filePath, state);
    return state.leases[pageId];
  });
}

export async function suspectPageLeaseClosed(outputDirectory, {
  pageId,
  closedAt = new Date().toISOString(),
}) {
  if (!pageId) return false;
  return serializeStoreMutation(async () => {
    const filePath = path.join(runtimeDirectory(outputDirectory), leasesFileName);
    const state = await readJson(filePath, { leases: {} });
    if (!state.leases[pageId]) return false;
    state.leases[pageId] = {
      ...state.leases[pageId],
      suspectedClosedAt: closedAt,
    };
    await writeJson(filePath, state);
    return true;
  });
}

export async function readLivePageLeases(outputDirectory, now = Date.now()) {
  const filePath = path.join(runtimeDirectory(outputDirectory), leasesFileName);
  const state = await readJson(filePath, { leases: {} });
  return activePageLeases(state.leases, now);
}

export async function writeLifecycleRecord(outputDirectory, jobId, update) {
  if (!jobId) throw new Error('任务缺少标识');
  return serializeStoreMutation(async () => {
    const filePath = path.join(runtimeDirectory(outputDirectory), lifecycleFileName);
    const state = await readJson(filePath, { jobs: {} });
    state.jobs[jobId] = {
      ...(state.jobs[jobId] || {}),
      jobId,
      ...update,
    };
    await writeJson(filePath, state);
    return state.jobs[jobId];
  });
}

export async function readLifecycleRecords(outputDirectory) {
  const filePath = path.join(runtimeDirectory(outputDirectory), lifecycleFileName);
  const state = await readJson(filePath, { jobs: {} });
  return state.jobs || {};
}

export async function readDiscardedJob(outputDirectory, jobId, now = Date.now()) {
  const filePath = path.join(runtimeDirectory(outputDirectory), tombstonesFileName);
  const state = await readJson(filePath, { jobs: {} });
  const record = state.jobs?.[jobId] || null;
  if (!record) return null;
  const expiresAt = Date.parse(record.expiresAt || '');
  return Number.isFinite(expiresAt) && expiresAt > now ? record : null;
}

export async function markJobDiscarded(
  outputDirectory,
  jobId,
  discardedAt = new Date().toISOString(),
) {
  return serializeStoreMutation(async () => {
    const filePath = path.join(runtimeDirectory(outputDirectory), tombstonesFileName);
    const state = await readJson(filePath, { jobs: {} });
    const now = Date.parse(discardedAt);
    const expiresAt = new Date(now + ABANDONED_JOB_TTL_MS).toISOString();
    state.jobs = Object.fromEntries(Object.entries(state.jobs || {}).filter(([, record]) => (
      Date.parse(record.expiresAt || '') > now
    )));
    state.jobs[jobId] = {
      jobId,
      status: 'discarded',
      discardedAt,
      expiresAt,
    };
    await writeJson(filePath, state);
    return state.jobs[jobId];
  });
}

export async function discardJobDirectory(outputDirectory, jobId, discardedAt) {
  const jobsDirectory = path.resolve(outputDirectory, 'jobs');
  const jobDirectory = path.resolve(jobsDirectory, jobId);
  if (path.dirname(jobDirectory) !== jobsDirectory) throw new Error('无效任务目录');
  await rm(jobDirectory, { recursive: true, force: true });
  await markJobDiscarded(outputDirectory, jobId, discardedAt);
}

async function readJobRecord(jobsDirectory, jobId, lifecycle) {
  const jobDirectory = path.join(jobsDirectory, jobId);
  try {
    const reportPath = path.join(jobDirectory, 'execution-report.json');
    const [plan, report, reportStat] = await Promise.all([
      readJson(path.join(jobDirectory, 'layer-review-plan.json'), null),
      readJson(reportPath, null),
      stat(reportPath).catch(() => null),
    ]);
    if (!plan) return null;
    return {
      jobId,
      jobDirectory,
      plan,
      report,
      reportCompletedAt: report?.timing?.completed_at
        || report?.completed_at
        || (reportStat ? reportStat.mtime.toISOString() : null),
      lifecycle: lifecycle[jobId] || null,
    };
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

export async function listJobRecords(outputDirectory) {
  const jobsDirectory = path.join(outputDirectory, 'jobs');
  const lifecycle = await readLifecycleRecords(outputDirectory);
  const entries = await readdir(jobsDirectory, { withFileTypes: true }).catch(() => []);
  const records = await Promise.all(entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => readJobRecord(jobsDirectory, entry.name, lifecycle)));
  return records.filter(Boolean);
}

export async function findBlockingJob(outputDirectory) {
  const records = await listJobRecords(outputDirectory);
  const now = Date.now();
  for (const record of records) {
    if (isStaleUnconfirmedDelivery({
      planStatus: record.plan.status,
      submittedAt: record.plan.submitted_at,
      reportStatus: record.report?.status || null,
      now,
    })) {
      await discardJobDirectory(outputDirectory, record.jobId, new Date(now).toISOString());
      continue;
    }
    if (blocksNewSubmission({
      planStatus: record.plan.status,
      reportStatus: record.report?.status || null,
      lifecycleStatus: record.lifecycle?.status || null,
      lifecycleCreatedAt: record.lifecycle?.createdAt || null,
    })) return record;
  }
  return null;
}

export async function discardBlockingJobsOnStartup(
  outputDirectory,
  discardedAt = new Date().toISOString(),
) {
  const records = await listJobRecords(outputDirectory);
  const discarded = [];
  for (const record of records) {
    if (!isStaleUnconfirmedDelivery({
      planStatus: record.plan.status,
      submittedAt: record.plan.submitted_at,
      reportStatus: record.report?.status || null,
      now: Date.parse(discardedAt),
    })) continue;
    await discardJobDirectory(outputDirectory, record.jobId, discardedAt);
    discarded.push(record.jobId);
  }
  return discarded;
}

export async function resetWorkbenchForOpen(
  outputDirectory,
  reopenedAt = new Date().toISOString(),
) {
  const records = await listJobRecords(outputDirectory);
  const discardedJobIds = [];
  const abandonedJobIds = [];
  for (const record of records) {
    if (isTerminalExecutionReport(record.report?.status)) {
      await rm(path.join(record.jobDirectory, 'foreground-dispatch.json'), { force: true });
      continue;
    }
    if (isCancelablePlanStatus(record.plan.status)) {
      await discardJobDirectory(outputDirectory, record.jobId, reopenedAt);
      discardedJobIds.push(record.jobId);
      continue;
    }
    if (isStartedPlanStatus(record.plan.status)) {
      await writeLifecycleRecord(outputDirectory, record.jobId, {
        status: 'abandoned_running',
        abandonedAt: reopenedAt,
      });
      abandonedJobIds.push(record.jobId);
    }
  }
  return {
    abandonedJobIds: abandonedJobIds.sort(),
    discardedJobIds: discardedJobIds.sort(),
  };
}

export async function cleanTerminalAbandonedJobs(
  outputDirectory,
  now = Date.now(),
) {
  const records = await listJobRecords(outputDirectory);
  const cleaned = [];
  for (const record of records) {
    if (!canCleanAbandonedJob({
      lifecycleStatus: record.lifecycle?.status,
      reportStatus: record.report?.status || null,
      reportCompletedAt: record.reportCompletedAt,
      abandonedAt: record.lifecycle?.abandonedAt,
      now,
    })) continue;
    await discardJobDirectory(
      outputDirectory,
      record.jobId,
      new Date(now).toISOString(),
    );
    cleaned.push(record.jobId);
  }
  return cleaned;
}
