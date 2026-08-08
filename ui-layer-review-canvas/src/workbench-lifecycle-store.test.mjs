import assert from 'node:assert/strict';
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  cleanTerminalAbandonedJobs,
  discardBlockingJobsOnStartup,
  findBlockingJob,
  heartbeatPageLease,
  readDiscardedJob,
  readLivePageLeases,
  suspectPageLeaseClosed,
  writeLifecycleRecord,
} from './workbench-lifecycle-store.js';
import { PAGE_LEASE_TTL_MS } from './workbench-lifecycle.js';

async function withOutputDirectory(run) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'imvia-layer-lifecycle-'));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function writeJob(outputDirectory, jobId, planStatus, reportStatus = null, submittedAt = null) {
  const jobDirectory = path.join(outputDirectory, 'jobs', jobId);
  await mkdir(jobDirectory, { recursive: true });
  await writeFile(
    path.join(jobDirectory, 'layer-review-plan.json'),
    JSON.stringify({ job_id: jobId, status: planStatus, ...(submittedAt ? { submitted_at: submittedAt } : {}) }),
  );
  if (reportStatus) {
    await writeFile(
      path.join(jobDirectory, 'execution-report.json'),
      JSON.stringify({
        status: reportStatus,
        timing: { completed_at: '2026-07-29T11:58:59.000Z' },
      }),
    );
  }
  return jobDirectory;
}

test('a close hint does not end a page lease before the offline grace', async () => {
  await withOutputDirectory(async (outputDirectory) => {
    const seenAt = '2026-07-29T12:00:00.000Z';
    const now = Date.parse(seenAt) + PAGE_LEASE_TTL_MS - 1;
    await heartbeatPageLease(outputDirectory, { pageId: 'page-1', seenAt });
    await suspectPageLeaseClosed(outputDirectory, {
      pageId: 'page-1',
      closedAt: '2026-07-29T12:00:01.000Z',
    });

    assert.deepEqual(Object.keys(await readLivePageLeases(outputDirectory, now)), ['page-1']);
  });
});

test('an active current-conversation job blocks another submission', async () => {
  await withOutputDirectory(async (outputDirectory) => {
    await writeJob(outputDirectory, 'job-1', 'sent_to_codex');
    await writeLifecycleRecord(outputDirectory, 'job-1', {
      status: 'active',
      createdAt: '2026-07-29T12:00:00.000Z',
    });
    const blocking = await findBlockingJob(outputDirectory);
    assert.equal(blocking.jobId, 'job-1');
  });
});

test('legacy jobs without lifecycle ownership do not block a new submission', async () => {
  await withOutputDirectory(async (outputDirectory) => {
    await writeJob(outputDirectory, 'legacy-job', 'sent_to_codex');
    assert.equal(await findBlockingJob(outputDirectory), null);
  });
});

test('startup discards every job that would block a fresh submission', async () => {
  await withOutputDirectory(async (outputDirectory) => {
    const sentJobDirectory = await writeJob(
      outputDirectory,
      'sent-job',
      'sending_to_codex',
      null,
      '2026-07-29T11:00:00.000Z',
    );
    const completedJobDirectory = await writeJob(outputDirectory, 'completed-job', 'completed', 'completed');
    await writeLifecycleRecord(outputDirectory, 'sent-job', {
      status: 'active',
      createdAt: '2026-07-29T12:00:00.000Z',
    });

    assert.deepEqual(
      await discardBlockingJobsOnStartup(outputDirectory, '2026-07-29T12:01:00.000Z'),
      ['sent-job'],
    );
    assert.equal(await findBlockingJob(outputDirectory), null);
    await assert.rejects(readFile(path.join(sentJobDirectory, 'layer-review-plan.json')), {
      code: 'ENOENT',
    });
    assert.equal(
      (await readDiscardedJob(outputDirectory, 'sent-job', Date.parse('2026-07-29T12:01:00.000Z'))).status,
      'discarded',
    );
    assert.equal(
      JSON.parse(await readFile(path.join(completedJobDirectory, 'layer-review-plan.json'), 'utf8')).status,
      'completed',
    );
  });
});

test('an expired unconfirmed delivery is removed before it can block a new submission', async () => {
  await withOutputDirectory(async (outputDirectory) => {
    await writeJob(
      outputDirectory,
      'expired-job',
      'sending_to_codex',
      null,
      '2026-07-29T11:00:00.000Z',
    );
    await writeLifecycleRecord(outputDirectory, 'expired-job', {
      status: 'active',
      createdAt: '2026-07-29T11:00:00.000Z',
    });
    assert.equal(await findBlockingJob(outputDirectory), null);
    assert.equal((await readDiscardedJob(outputDirectory, 'expired-job')).status, 'discarded');
  });
});

test('queued jobs survive a workbench restart and remain available for later dispatch', async () => {
  await withOutputDirectory(async (outputDirectory) => {
    const jobDirectory = await writeJob(
      outputDirectory,
      'queued-job',
      'queued',
      null,
      '2026-07-29T11:00:00.000Z',
    );
    await writeLifecycleRecord(outputDirectory, 'queued-job', {
      status: 'active',
      createdAt: '2026-07-29T11:00:00.000Z',
    });

    assert.deepEqual(
      await discardBlockingJobsOnStartup(outputDirectory, '2026-07-29T12:01:00.000Z'),
      [],
    );
    assert.equal((await findBlockingJob(outputDirectory)).jobId, 'queued-job');
    assert.equal(JSON.parse(await readFile(
      path.join(jobDirectory, 'layer-review-plan.json'),
      'utf8',
    )).status, 'queued');
  });
});

test('terminal abandoned jobs are removed and leave a short tombstone', async () => {
  await withOutputDirectory(async (outputDirectory) => {
    const jobDirectory = await writeJob(outputDirectory, 'job-2', 'sent_to_codex', 'completed');
    const now = Date.parse('2026-07-29T12:00:00.000Z');
    await writeLifecycleRecord(outputDirectory, 'job-2', {
      status: 'abandoned_running',
      abandonedAt: '2026-07-29T11:00:00.000Z',
    });

    assert.deepEqual(await cleanTerminalAbandonedJobs(outputDirectory, now), ['job-2']);
    await assert.rejects(readFile(path.join(jobDirectory, 'layer-review-plan.json')), {
      code: 'ENOENT',
    });
    assert.equal((await readDiscardedJob(outputDirectory, 'job-2', now)).status, 'discarded');
  });
});

test('normal completed jobs are not cleaned', async () => {
  await withOutputDirectory(async (outputDirectory) => {
    const jobDirectory = await writeJob(outputDirectory, 'job-3', 'completed', 'completed');
    assert.deepEqual(await cleanTerminalAbandonedJobs(outputDirectory), []);
    assert.equal(
      JSON.parse(await readFile(path.join(jobDirectory, 'layer-review-plan.json'), 'utf8')).status,
      'completed',
    );
  });
});
