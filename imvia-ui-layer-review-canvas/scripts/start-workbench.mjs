import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  mkdir,
  open,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PAGE_LEASE_TTL_MS,
  blocksNewSubmission,
  isCancelablePlanStatus,
  shouldMarkJobAbandoned,
  shouldEnterWarmShutdown,
} from '../src/workbench-lifecycle.js';
import {
  cleanTerminalAbandonedJobs,
  discardJobDirectory,
  listJobRecords,
  readLivePageLeases,
  resetWorkbenchForOpen,
  writeLifecycleRecord,
} from '../src/workbench-lifecycle-store.js';
import {
  cancelDirectConversationJob,
  cancelForegroundDispatch,
} from '../src/foreground-dispatch.js';
import { resetPosterDispatchesForOpen } from '../src/poster-dispatch-control.js';

const managerVersion = 3;
const pollIntervalMs = 5_000;
const rootDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outputDirectory = path.join(rootDirectory, 'output');
const posterJobsDirectory = path.join(outputDirectory, 'poster-jobs');
const runtimeDirectory = path.join(outputDirectory, 'workbench-runtime');
const ownerPath = path.join(runtimeDirectory, 'manager-owner.json');
const sessionPath = path.join(runtimeDirectory, 'workbench-session.json');
const managerStartedAt = new Date().toISOString();
// The browser service and the current-task MCP App share one stable identifier
// for result polling and lifecycle cleanup. It is not a conversation listener.
async function resolveWorkbenchSessionId() {
  if (process.env.IMVIA_WORKBENCH_SESSION_ID) return process.env.IMVIA_WORKBENCH_SESSION_ID;
  try {
    const persisted = JSON.parse(await readFile(sessionPath, 'utf8'));
    if (typeof persisted.workbenchSessionId === 'string' && persisted.workbenchSessionId) {
      return persisted.workbenchSessionId;
    }
  } catch {
    // A missing or partial session file is replaced once ownership is acquired.
  }
  return randomUUID();
}
const workbenchSessionId = await resolveWorkbenchSessionId();
const childEnvironment = {
  ...process.env,
  IMVIA_WORKBENCH_SESSION_ID: workbenchSessionId,
};
const processes = [
  {
    name: 'workbench',
    entry: path.join(rootDirectory, 'node_modules', 'vite', 'bin', 'vite.js'),
    args: process.argv.slice(2),
  },
];

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function hasRequiredRuntime(owner) {
  if (!processIsAlive(owner?.pid)) return false;
  if (!Array.isArray(owner?.childPids) || owner.childPids.length !== 1) return false;
  if (!owner.childPids.every(processIsAlive)) return false;
  return owner.workbench?.mode === 'embedded_app';
}

async function acquireOwnership() {
  await mkdir(runtimeDirectory, { recursive: true });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(ownerPath, 'wx');
      await handle.writeFile(JSON.stringify({
        version: managerVersion,
        pid: process.pid,
        startedAt: managerStartedAt,
        workbenchSessionId,
        childPids: [],
      }, null, 2));
      await handle.close();
      return true;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let owner = null;
      try {
        owner = JSON.parse(await readFile(ownerPath, 'utf8'));
      } catch {
        // A partial stale owner file is safe to replace after its process is gone.
      }
      if (processIsAlive(owner?.pid)) {
        if (owner.version === managerVersion) {
          if (hasRequiredRuntime(owner)) return false;
          throw new Error('已有工作台管理器正在运行，但运行时未通过健康检查，请先关闭旧工作台再重新打开');
        }
        try {
          process.kill(owner.pid, 'SIGTERM');
        } catch {}
        await new Promise((resolve) => setTimeout(resolve, 500));
        if (processIsAlive(owner.pid)) {
          throw new Error('已有旧版本的工作台管理器仍在退出，请稍后重试');
        }
      }
      await rm(ownerPath, { force: true });
    }
  }
  throw new Error('无法取得工作台生命周期管理权');
}

if (!await acquireOwnership()) {
  console.log('Imvia Layer 工作台已在运行；当前任务内 App 可直接发送会话消息。');
  process.exit(0);
}

await writeFile(sessionPath, JSON.stringify({
  workbenchSessionId,
  updatedAt: new Date().toISOString(),
}, null, 2));

async function clearInterruptedJobsOnStartup(now) {
  const reopenedAt = new Date(now).toISOString();
  const ui = await resetWorkbenchForOpen(outputDirectory, reopenedAt);
  const poster = await resetPosterDispatchesForOpen(posterJobsDirectory, reopenedAt);
  return { ui, poster };
}

await clearInterruptedJobsOnStartup(Date.now());

const children = processes.map(({ name, entry, args }) => {
  const child = spawn(process.execPath, [entry, ...args], {
    cwd: rootDirectory,
    env: childEnvironment,
    stdio: 'inherit',
    windowsHide: true,
  });
  child.label = name;
  return child;
});

await writeFile(ownerPath, JSON.stringify({
  version: managerVersion,
  pid: process.pid,
  startedAt: managerStartedAt,
  workbenchSessionId,
  childPids: children.map((child) => child.pid),
  workbench: { mode: 'embedded_app' },
}, null, 2));

let stopping = false;
let offlineSince = null;
let idleSince = null;
let lifecycleTickRunning = false;
let lifecycleInterval = null;

async function stop(exitCode) {
  if (stopping) return;
  stopping = true;
  if (lifecycleInterval) clearInterval(lifecycleInterval);
  for (const child of children) {
    if (child.exitCode === null) child.kill('SIGTERM');
  }
  await rm(ownerPath, { force: true }).catch(() => {});
  process.exitCode = exitCode;
}

async function reconcileClosedWorkbench(now, pageMissingSince) {
  const records = await listJobRecords(outputDirectory);
  for (const record of records) {
    if (isCancelablePlanStatus(record.plan.status) && !record.report?.status) {
      try {
        await cancelForegroundDispatch(record.jobDirectory, new Date(now).toISOString());
      } catch {
        try {
          await cancelDirectConversationJob(record.jobDirectory, new Date(now).toISOString());
        } catch {
          // The Codex confirmation may have won the race; re-read on the next tick.
          continue;
        }
      }
      await discardJobDirectory(outputDirectory, record.jobId, new Date(now).toISOString());
      continue;
    }
    if (
      record.lifecycle?.status !== 'abandoned_running'
      && shouldMarkJobAbandoned({
        lifecycleStatus: record.lifecycle?.status || null,
        lifecycleCreatedAt: record.lifecycle?.createdAt || null,
        planStatus: record.plan.status,
        reportStatus: record.report?.status || null,
        reportCompletedAt: record.reportCompletedAt,
        pageMissingSince,
      })
    ) {
      await writeLifecycleRecord(outputDirectory, record.jobId, {
        status: 'abandoned_running',
        abandonedAt: new Date(now).toISOString(),
      });
    }
  }
}

async function lifecycleTick() {
  if (stopping || lifecycleTickRunning) return;
  lifecycleTickRunning = true;
  try {
    const now = Date.now();
    const leases = await readLivePageLeases(outputDirectory, now);
    const leaseCount = Object.keys(leases).length;
    if (leaseCount > 0) {
      offlineSince = null;
    } else if (offlineSince === null) {
      offlineSince = now;
    } else if (now - offlineSince >= PAGE_LEASE_TTL_MS) {
      await reconcileClosedWorkbench(now, offlineSince);
    }

    await cleanTerminalAbandonedJobs(outputDirectory, now);
    const records = await listJobRecords(outputDirectory);
    const activeJobCount = records.filter(({ plan, report, lifecycle }) => blocksNewSubmission({
      planStatus: plan.status,
      reportStatus: report?.status || null,
      lifecycleStatus: lifecycle?.status || null,
      lifecycleCreatedAt: lifecycle?.createdAt || null,
    })).length;
    if (leaseCount > 0 || activeJobCount > 0) {
      idleSince = null;
    } else if (idleSince === null) {
      idleSince = new Date(now).toISOString();
    }
    if (shouldEnterWarmShutdown({
      leaseCount,
      activeJobCount,
      cleanupInProgress: false,
      idleSince,
      now,
    })) {
      await stop(0);
    }
  } catch (error) {
    console.error(`工作台生命周期检查失败：${error.message}`);
  } finally {
    lifecycleTickRunning = false;
  }
}

for (const child of children) {
  child.on('exit', (code) => {
    if (stopping) return;
    console.error(`${child.label} stopped unexpectedly.`);
    stop(code ?? 1);
  });
}

lifecycleInterval = setInterval(lifecycleTick, pollIntervalMs);
lifecycleTick();

process.on('SIGINT', () => {
  clearInterval(lifecycleInterval);
  stop(0);
});
process.on('SIGTERM', () => {
  clearInterval(lifecycleInterval);
  stop(0);
});
