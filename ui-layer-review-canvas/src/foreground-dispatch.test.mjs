import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  acknowledgeForegroundDispatch,
  enqueueForegroundDispatch,
  readNextForegroundDispatch,
} from './foreground-dispatch.js';

test('the oldest pending split is exposed for a foreground conversation message', async (context) => {
  const jobsDirectory = await mkdtemp(path.join(os.tmpdir(), 'layer-review-dispatch-'));
  context.after(() => rm(jobsDirectory, { recursive: true, force: true }));
  const firstDirectory = path.join(jobsDirectory, 'job-1');
  const secondDirectory = path.join(jobsDirectory, 'job-2');
  await mkdir(firstDirectory);
  await mkdir(secondDirectory);

  await enqueueForegroundDispatch(firstDirectory, {
    jobId: 'job-1',
    prompt: 'first prompt',
    submittedAt: '2026-07-28T10:00:00.000Z',
  });
  await enqueueForegroundDispatch(secondDirectory, {
    jobId: 'job-2',
    prompt: 'second prompt',
    submittedAt: '2026-07-28T10:00:01.000Z',
  });

  assert.deepEqual(await readNextForegroundDispatch(jobsDirectory), {
    jobId: 'job-1',
    prompt: 'first prompt',
    submittedAt: '2026-07-28T10:00:00.000Z',
  });
});

test('acknowledged splits leave the foreground queue and persist their sent time', async (context) => {
  const jobsDirectory = await mkdtemp(path.join(os.tmpdir(), 'layer-review-dispatch-'));
  context.after(() => rm(jobsDirectory, { recursive: true, force: true }));
  const jobDirectory = path.join(jobsDirectory, 'job-1');
  await mkdir(jobDirectory);
  await writeFile(path.join(jobDirectory, 'layer-review-plan.json'), JSON.stringify({
    job_id: 'job-1',
    status: 'awaiting_codex_message',
  }));
  await enqueueForegroundDispatch(jobDirectory, {
    jobId: 'job-1',
    prompt: 'prompt',
    submittedAt: '2026-07-28T10:00:00.000Z',
  });

  await acknowledgeForegroundDispatch(jobDirectory, '2026-07-28T10:00:02.000Z');

  assert.equal(await readNextForegroundDispatch(jobsDirectory), null);
  const plan = JSON.parse(await readFile(path.join(jobDirectory, 'layer-review-plan.json'), 'utf8'));
  assert.equal(plan.status, 'sent_to_codex');
  assert.equal(plan.codex_message_sent_at, '2026-07-28T10:00:02.000Z');
});
