import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { acknowledgeForegroundDispatch } from '../src/foreground-dispatch.js';

const jobId = process.argv[2];
if (!/^layer-job-[a-zA-Z0-9._-]+$/.test(jobId || '')) {
  throw new Error('缺少有效的 Layer Review 任务编号');
}

const rootDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
await acknowledgeForegroundDispatch(
  path.join(rootDirectory, 'output', 'jobs', jobId),
  new Date().toISOString(),
  { confirmationSource: 'codex_model_tool' },
);
process.stdout.write(JSON.stringify({ ok: true, jobId }));
