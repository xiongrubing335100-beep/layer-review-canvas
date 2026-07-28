import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const dispatchFileName = 'foreground-dispatch.json';
const planFileName = 'layer-review-plan.json';

export async function enqueueForegroundDispatch(jobDirectory, dispatch) {
  await writeFile(path.join(jobDirectory, dispatchFileName), JSON.stringify({
    ...dispatch,
    status: 'pending',
  }, null, 2));
}

export async function readNextForegroundDispatch(jobsDirectory) {
  const entries = await readdir(jobsDirectory, { withFileTypes: true }).catch(() => []);
  const pending = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      const dispatch = JSON.parse(await readFile(
        path.join(jobsDirectory, entry.name, dispatchFileName),
        'utf8',
      ));
      if (dispatch.status === 'pending') pending.push(dispatch);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  pending.sort((left, right) => left.submittedAt.localeCompare(right.submittedAt));
  const next = pending[0];
  return next ? {
    jobId: next.jobId,
    prompt: next.prompt,
    submittedAt: next.submittedAt,
  } : null;
}

export async function acknowledgeForegroundDispatch(jobDirectory, sentAt) {
  const dispatchPath = path.join(jobDirectory, dispatchFileName);
  const planPath = path.join(jobDirectory, planFileName);
  const dispatch = JSON.parse(await readFile(dispatchPath, 'utf8'));
  const plan = JSON.parse(await readFile(planPath, 'utf8'));
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
    }, null, 2)),
  ]);
}
