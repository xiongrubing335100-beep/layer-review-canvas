import { readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

const allowedStatuses = new Set(['repair_rgb', 'repair_matte', 'alpha_matte', 'finalizing']);

function flagValue(flag) {
  const index = process.argv.indexOf(flag);
  const value = index >= 0 ? process.argv[index + 1] : null;
  if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`);
  return value;
}

async function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(await readFile(filePath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT' && fallback !== null) return fallback;
    throw error;
  }
}

async function writeAtomicJson(filePath, value) {
  const temporaryPath = `${filePath}.tmp-${process.pid}`;
  await writeFile(temporaryPath, JSON.stringify(value, null, 2));
  await rename(temporaryPath, filePath);
}

const jobId = flagValue('--job-id');
const layerId = flagValue('--layer-id');
const status = flagValue('--status');
const jobsRoot = path.resolve(process.argv.includes('--jobs-root')
  ? flagValue('--jobs-root')
  : path.join('output', 'jobs'));

try {
  if (!allowedStatuses.has(status)) throw new Error(`unsupported repair stage: ${status}`);
  const jobDirectory = path.resolve(jobsRoot, jobId);
  if (!jobDirectory.startsWith(`${jobsRoot}${path.sep}`)) throw new Error('job path escapes jobs root');

  const plan = await readJson(path.join(jobDirectory, 'layer-review-plan.json'));
  const layer = plan?.layers?.find((candidate) => candidate.id === layerId);
  if (!layer) throw new Error(`layer not found: ${layerId}`);
  if (layer.execution_route_hint !== 'codex_rgba_repair') {
    throw new Error('repair stages require execution_route_hint codex_rgba_repair');
  }

  const reportPath = path.join(jobDirectory, 'execution-report.json');
  const existing = await readJson(reportPath, {});
  if (['completed', 'failed', 'needs_confirmation'].includes(existing.status)) {
    throw new Error(`cannot replace terminal execution report: ${existing.status}`);
  }
  const timing = { ...(existing.timing || {}) };
  delete timing.completed_at;
  timing.stage_updated_at = new Date().toISOString();
  const report = {
    ...existing,
    status,
    execution_route: 'codex_rgba_repair',
    layer_id: layerId,
    timing,
  };
  await writeAtomicJson(reportPath, report);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} catch (error) {
  console.error(`Targeted stage update failed: ${error.message}`);
  process.exitCode = 1;
}
