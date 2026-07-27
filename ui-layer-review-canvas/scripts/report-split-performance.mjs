import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { summarizeDurations, reductionPercent } from '../src/performance-metrics.js';

const jobsRoot = path.resolve('output', 'jobs');
let entries = [];
try {
  entries = await readdir(jobsRoot, { withFileTypes: true });
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}

const samples = [];
const idsFlag = process.argv.indexOf('--job-ids');
const allowedJobIds = idsFlag >= 0
  ? new Set(process.argv[idsFlag + 1].split(',').map((value) => value.trim()).filter(Boolean))
  : null;

for (const entry of entries) {
  if (!entry.isDirectory() || !entry.name.startsWith('layer-job-')) continue;
  if (allowedJobIds && !allowedJobIds.has(entry.name)) continue;
  const jobDirectory = path.join(jobsRoot, entry.name);
  const plan = JSON.parse(await readFile(path.join(jobDirectory, 'layer-review-plan.json'), 'utf8'));
  let report = null;
  try {
    report = JSON.parse(await readFile(path.join(jobDirectory, 'execution-report.json'), 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const submitted = Date.parse(report?.timing?.submitted_at || plan.submitted_at || '');
  const completed = Date.parse(report?.timing?.completed_at || plan.codex_completed_at || '');
  if (!Number.isFinite(submitted) || !Number.isFinite(completed)) continue;
  samples.push({
    jobId: entry.name,
    route: report?.execution_route || plan.layers?.[0]?.execution_route_hint || 'legacy',
    seconds: (completed - submitted) / 1000,
    status: report?.status || plan.status,
  });
}

const summary = summarizeDurations(samples);
const baselineFlag = process.argv.indexOf('--baseline');
const requiredFlag = process.argv.indexOf('--require-fast-improvement');
let improvements = {};

if (baselineFlag >= 0) {
  const baseline = JSON.parse(await readFile(path.resolve(process.argv[baselineFlag + 1]), 'utf8'));
  for (const route of ['direct_crop', 'alpha_extract']) {
    const before = baseline.summary?.[route]?.medianSeconds;
    const after = summary[route]?.medianSeconds;
    if (Number.isFinite(before) && Number.isFinite(after)) {
      improvements[route] = reductionPercent(before, after);
    }
  }
}

console.log(JSON.stringify({
  generatedAt: new Date().toISOString(),
  samples,
  summary,
  improvements,
}, null, 2));

if (baselineFlag >= 0 && requiredFlag >= 0) {
  const required = Number(process.argv[requiredFlag + 1]);
  const values = Object.values(improvements);
  if (!values.length || Math.min(...values) < required) process.exitCode = 1;
}
