import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { deriveDurations } from '../src/execution-timing.js';
import { summarizeDurations, reductionPercent } from '../src/performance-metrics.js';

function flagValue(flag) {
  const index = process.argv.indexOf(flag);
  if (index < 0) return null;
  const value = process.argv[index + 1];
  if (!value || value.startsWith('--')) {
    console.error(`Usage: ${flag} requires a value.`);
    process.exit(1);
  }
  return value;
}

function numericFlag(flag, { min = 0 } = {}) {
  const value = flagValue(flag);
  if (value === null) return null;
  const parsed = Number(value);
  if (!value.trim() || !Number.isFinite(parsed) || parsed < min) {
    console.error(`Usage: ${flag} requires a finite number >= ${min}.`);
    process.exit(1);
  }
  return parsed;
}

const jobsRoot = path.resolve('output', 'jobs');
let entries = [];
try {
  entries = await readdir(jobsRoot, { withFileTypes: true });
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}

const samples = [];
const jobIds = flagValue('--job-ids');
const allowedJobIds = jobIds !== null
  ? new Set(jobIds.split(',').map((value) => value.trim()).filter(Boolean))
  : null;
const baselinePath = flagValue('--baseline');
const requiredValue = flagValue('--require-fast-improvement');
const requiredTargetedP50 = numericFlag('--require-targeted-p50-seconds');
const requiredTargetedP90 = numericFlag('--require-targeted-p90-seconds');
const requiredPostprocess = numericFlag('--require-postprocess-seconds');
const hasTargetedGate = [
  requiredTargetedP50,
  requiredTargetedP90,
  requiredPostprocess,
].some((value) => value !== null);
let required = null;
const gateErrors = [];
const foundJobIds = new Set();
const mandatoryValidationKeys = [
  'count',
  'dimensions',
  'alpha',
  'annotation_conformance',
  'obvious_exclusion',
];

if (requiredValue !== null) {
  if (baselinePath === null) {
    console.error('Usage: --require-fast-improvement requires --baseline <json>.');
    process.exit(1);
  }
  required = Number(requiredValue);
  if (!requiredValue.trim() || !Number.isFinite(required)) {
    console.error('Usage: --require-fast-improvement requires a finite number.');
    process.exit(1);
  }
  if (!allowedJobIds?.size) {
    console.error('Usage: --require-fast-improvement requires an explicit --job-ids <id,...> current-job set.');
    process.exit(1);
  }
}

if (hasTargetedGate && !allowedJobIds?.size) {
  console.error('Targeted performance gates require an explicit --job-ids <id,...> current-job set.');
  process.exit(1);
}

for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
  if (!entry.isDirectory() || !entry.name.startsWith('layer-job-')) continue;
  if (allowedJobIds && !allowedJobIds.has(entry.name)) continue;
  foundJobIds.add(entry.name);
  const jobDirectory = path.join(jobsRoot, entry.name);
  const plan = JSON.parse(await readFile(path.join(jobDirectory, 'layer-review-plan.json'), 'utf8'));
  let report = null;
  try {
    report = JSON.parse(await readFile(path.join(jobDirectory, 'execution-report.json'), 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const plannedLayers = Array.isArray(plan.layers) ? plan.layers : [];
  const plannedRoute = plannedLayers[0]?.execution_route_hint;
  const reportTiming = report?.timing || {};
  const reportSubmitted = Date.parse(report?.timing?.submitted_at || '');
  const reportConfirmationAccepted = Date.parse(reportTiming.confirmation_accepted_at || '');
  const reportCompleted = Date.parse(report?.timing?.completed_at || '');
  const submitted = hasTargetedGate
    ? reportConfirmationAccepted
    : required !== null
      ? reportSubmitted
    : Date.parse(report?.timing?.submitted_at || plan.submitted_at || '');
  const completed = hasTargetedGate || required !== null
    ? reportCompleted
    : Date.parse(report?.timing?.completed_at || plan.codex_completed_at || '');
  const seconds = (completed - submitted) / 1000;
  const route = report?.execution_route || plan.layers?.[0]?.execution_route_hint || 'legacy';
  const durations = report?.durations || deriveDurations(reportTiming);
  const postprocessSeconds = Number.isFinite(durations.postprocess_ms)
    ? durations.postprocess_ms / 1000
    : null;

  if (required !== null || hasTargetedGate) {
    if (!report) {
      gateErrors.push(`${entry.name}: execution report is required`);
      continue;
    }
    if (plannedLayers.length !== 1) {
      gateErrors.push(`${entry.name}: benchmark jobs must contain exactly one layer`);
      continue;
    }
    if (!plannedRoute || report.execution_route !== plannedRoute) {
      gateErrors.push(`${entry.name}: report route must match the planned route`);
      continue;
    }
    if (report.status !== 'completed') {
      gateErrors.push(`${entry.name}: report status must be completed, got ${report.status || 'missing'}`);
      continue;
    }
    if (!Number.isFinite(reportCompleted)
      || (hasTargetedGate && !Number.isFinite(reportConfirmationAccepted))
      || (!hasTargetedGate && !Number.isFinite(reportSubmitted))) {
      gateErrors.push(`${entry.name}: executor report timing is incomplete`);
      continue;
    }
    if (seconds <= 0) {
      gateErrors.push(`${entry.name}: benchmark evidence requires a positive duration`);
      continue;
    }
    const failedValidation = mandatoryValidationKeys.find((key) => report.validation_results?.[key] !== true);
    if (failedValidation) {
      gateErrors.push(`${entry.name}: mandatory validation ${failedValidation} did not pass`);
      continue;
    }
    if (hasTargetedGate && route === 'targeted_repair' && requiredPostprocess !== null) {
      if (!Number.isFinite(postprocessSeconds)) {
        gateErrors.push(`${entry.name}: postprocess timing is required for targeted repair`);
      } else if (postprocessSeconds > requiredPostprocess) {
        gateErrors.push(`${entry.name}: postprocess duration ${postprocessSeconds}s exceeds ${requiredPostprocess}s`);
      }
    }
  } else if (!Number.isFinite(submitted) || !Number.isFinite(completed)) {
    continue;
  }
  samples.push({
    jobId: entry.name,
    route,
    seconds,
    postprocessSeconds,
    status: report?.status || plan.status,
  });
}

if (allowedJobIds) {
  for (const jobId of allowedJobIds) {
    if (!foundJobIds.has(jobId)) gateErrors.push(`${jobId}: requested job was not found`);
  }
}

const summary = summarizeDurations(samples);
const simpleRoutes = ['direct_crop', 'alpha_extract'];
let improvements = {};
let baseline = null;

if (baselinePath !== null) {
  try {
    baseline = JSON.parse(await readFile(path.resolve(baselinePath), 'utf8'));
  } catch {
    console.error(`Benchmark evidence error: unable to read baseline ${baselinePath}.`);
    process.exit(1);
  }
  for (const route of simpleRoutes) {
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

if (required !== null) {
  if (gateErrors.length) {
    console.error(`Benchmark evidence invalid: ${gateErrors.join('; ')}.`);
    process.exitCode = 1;
  } else {
    const missingRoutes = simpleRoutes.filter((route) => (
      !Number.isFinite(baseline.summary?.[route]?.medianSeconds)
      || !Number.isFinite(summary[route]?.medianSeconds)
    ));
    if (missingRoutes.length) {
      console.error(`Benchmark evidence incomplete: missing finite medians for ${missingRoutes.join(', ')}.`);
      process.exitCode = 1;
    } else if (Math.min(...simpleRoutes.map((route) => improvements[route])) < required) {
      console.error(`Benchmark evidence insufficient: simple-route improvement is below ${required}%.`);
      process.exitCode = 1;
    }
  }
}

if (hasTargetedGate && !gateErrors.length) {
  const targetedSummary = summary.targeted_repair;
  if (!targetedSummary?.completed) {
    gateErrors.push('targeted_repair: no completed benchmark samples were found');
  } else {
    if (requiredTargetedP50 !== null
      && (!Number.isFinite(targetedSummary.p50Seconds)
        || targetedSummary.p50Seconds > requiredTargetedP50)) {
      gateErrors.push(`targeted_repair: P50 ${targetedSummary.p50Seconds ?? 'missing'}s exceeds ${requiredTargetedP50}s`);
    }
    if (requiredTargetedP90 !== null
      && (!Number.isFinite(targetedSummary.p90Seconds)
        || targetedSummary.p90Seconds > requiredTargetedP90)) {
      gateErrors.push(`targeted_repair: P90 ${targetedSummary.p90Seconds ?? 'missing'}s exceeds ${requiredTargetedP90}s`);
    }
  }
}

if (hasTargetedGate && gateErrors.length) {
  console.error(`Targeted performance evidence invalid: ${gateErrors.join('; ')}.`);
  process.exitCode = 1;
}
