import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { abandonForegroundJob, cancelForegroundDispatch, readForegroundDispatch } from './foreground-dispatch.js';
import { recordPosterGenerationFailure } from './poster-job-store.js';
import { rollbackPreparedPosterCandidate } from '../scripts/prepare-poster-job.mjs';
import { withDirectoryLock } from './file-lock.js';

function outputRootForPosterJob(jobDirectory) {
  const resolved = path.resolve(jobDirectory);
  if (path.basename(path.dirname(resolved)) !== 'poster-jobs') throw new Error('poster job directory is invalid');
  return path.dirname(path.dirname(resolved));
}

export async function controlPosterDispatch(jobDirectory, { dispatchId, action, now = new Date().toISOString() } = {}) {
  if (!['cancel', 'abandon'].includes(action)) throw new Error('poster dispatch action is invalid');
  const outputRoot = outputRootForPosterJob(jobDirectory);
  const jobId = path.basename(path.resolve(jobDirectory));
  return withDirectoryLock(path.join(outputRoot, '.poster-candidate-locks', `${jobId}.lock`), async () => {
    const options = { dispatchId, rootKind: 'poster' };
    const before = await readForegroundDispatch(jobDirectory, options);
    if (action === 'cancel') await cancelForegroundDispatch(jobDirectory, now, options);
    else await abandonForegroundJob(jobDirectory, now, options);
    const dispatch = await readForegroundDispatch(jobDirectory, options);
  // A terminal finalizer may win between the initial read and the control
  // request. Only a dispatch that is actually cancelled may repair a pending
  // reservation; completed work is immutable even though cancel/abandon are
  // intentionally idempotent at the transport layer.
    if (before.taskKind === 'poster_candidate' && dispatch.status === 'cancelled') {
      if (action === 'cancel') {
        await rollbackPreparedPosterCandidate({
          outputRoot, jobId: before.jobId, authorizationId: before.authorizationId, dispatchId: before.dispatchId, idempotent: true,
        });
      } else {
        await recordPosterGenerationFailure({
          outputRoot, jobId: before.jobId, layerIndex: before.layerIndex, authorizationId: before.authorizationId,
          candidateNumber: before.candidateNumber, planVersion: before.planVersion, dispatchId: before.dispatchId, idempotent: true,
          error: 'poster generation was abandoned before a usable candidate was finalized',
          failureCodes: ['GENERATION_FAILED', 'GENERATION_ABANDONED'],
        });
      }
    }
    return { ok: true, status: String(dispatch.status).toUpperCase(), codex_turn_may_continue: action === 'abandon' };
  });
}

export async function resetPosterDispatchesForOpen(
  posterJobsDirectory,
  reopenedAt = new Date().toISOString(),
) {
  const resolvedJobsDirectory = path.resolve(posterJobsDirectory);
  if (path.basename(resolvedJobsDirectory) !== 'poster-jobs') {
    throw new Error('poster jobs directory is invalid');
  }
  const cancelledDispatchIds = [];
  const abandonedDispatchIds = [];
  const jobs = await readdir(resolvedJobsDirectory, { withFileTypes: true }).catch(() => []);
  for (const job of jobs) {
    if (!job.isDirectory()) continue;
    const jobDirectory = path.join(resolvedJobsDirectory, job.name);
    const dispatchDirectory = path.join(jobDirectory, 'foreground-dispatches');
    const files = await readdir(dispatchDirectory).catch(() => []);
    for (const filename of files.sort()) {
      if (!/^[a-zA-Z0-9-]+\.json$/.test(filename)) continue;
      let dispatch;
      try {
        dispatch = JSON.parse(await readFile(path.join(dispatchDirectory, filename), 'utf8'));
      } catch (error) {
        if (error.code === 'ENOENT' || error instanceof SyntaxError) continue;
        throw error;
      }
      if (dispatch.rootKind !== 'poster' || dispatch.jobId !== job.name) continue;
      if (['pending', 'claimed', 'delivered'].includes(dispatch.status)) {
        await controlPosterDispatch(jobDirectory, {
          dispatchId: dispatch.dispatchId,
          action: 'cancel',
          now: reopenedAt,
        });
        cancelledDispatchIds.push(dispatch.dispatchId);
      } else if (['sent', 'finalizing'].includes(dispatch.status)) {
        await controlPosterDispatch(jobDirectory, {
          dispatchId: dispatch.dispatchId,
          action: 'abandon',
          now: reopenedAt,
        });
        abandonedDispatchIds.push(dispatch.dispatchId);
      }
    }
  }
  return {
    abandonedDispatchIds: abandonedDispatchIds.sort(),
    cancelledDispatchIds: cancelledDispatchIds.sort(),
  };
}
