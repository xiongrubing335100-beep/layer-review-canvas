import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { buildTargetedExecutionSpec } from '../src/targeted-preflight.js';

function flagValue(flag) {
  const index = process.argv.indexOf(flag);
  const value = index >= 0 ? process.argv[index + 1] : null;
  if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`);
  return value;
}

function optionalFlagValue(flag) {
  const index = process.argv.indexOf(flag);
  if (index < 0) return null;
  return flagValue(flag);
}

async function writeAtomicJson(filePath, value) {
  const temporaryPath = `${filePath}.tmp-${process.pid}`;
  await writeFile(temporaryPath, JSON.stringify(value, null, 2));
  await rename(temporaryPath, filePath);
}

const jobId = flagValue('--job-id');
const jobsRoot = path.resolve(optionalFlagValue('--jobs-root') || path.join('output', 'jobs'));
const jobDirectory = path.join(jobsRoot, jobId);
const planPath = path.join(jobDirectory, 'layer-review-plan.json');

try {
  const plan = JSON.parse(await readFile(planPath, 'utf8'));
  const spec = await buildTargetedExecutionSpec({ jobId, jobDirectory, plan });
  await mkdir(jobDirectory, { recursive: true });
  await writeAtomicJson(path.join(jobDirectory, 'preflight.json'), spec);
  process.stdout.write(`${JSON.stringify(spec, null, 2)}\n`);
} catch (error) {
  const report = {
    status: 'failed',
    phase: 'preflight',
    error: error.message,
    timing: { preflight_completed_at: new Date().toISOString() },
  };
  await mkdir(jobDirectory, { recursive: true });
  await writeAtomicJson(path.join(jobDirectory, 'execution-report.json'), report);
  console.error(`Targeted preflight failed: ${error.message}`);
  process.exitCode = 1;
}
