import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const rootDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scriptPath = path.join(rootDirectory, 'scripts', 'update-targeted-job-stage.mjs');

function runScript(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [scriptPath, ...args], { cwd: rootDirectory });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (code) => resolve({ code, stderr }));
  });
}

test('atomically advances a transparent repair report without terminal timing', async () => {
  const jobsRoot = await mkdtemp(path.join(os.tmpdir(), 'targeted-stage-'));
  const jobId = 'layer-job-stage-test';
  const jobDirectory = path.join(jobsRoot, jobId);
  await mkdir(jobDirectory);
  await writeFile(path.join(jobDirectory, 'layer-review-plan.json'), JSON.stringify({
    layers: [{ id: 'title-1', execution_route_hint: 'codex_rgba_repair' }],
  }));
  await writeFile(path.join(jobDirectory, 'execution-report.json'), JSON.stringify({
    status: 'repair_rgb',
    timing: { started_at: '2026-08-17T00:00:00.000Z', completed_at: 'stale' },
  }));

  const result = await runScript([
    '--job-id', jobId,
    '--layer-id', 'title-1',
    '--status', 'repair_matte',
    '--jobs-root', jobsRoot,
  ]);

  assert.equal(result.code, 0, result.stderr);
  const report = JSON.parse(await readFile(path.join(jobDirectory, 'execution-report.json'), 'utf8'));
  assert.equal(report.status, 'repair_matte');
  assert.equal(report.execution_route, 'codex_rgba_repair');
  assert.equal(report.layer_id, 'title-1');
  assert.equal(report.timing.started_at, '2026-08-17T00:00:00.000Z');
  assert.equal('completed_at' in report.timing, false);
  assert.match(report.timing.stage_updated_at, /^2026-/);
});

test('does not replace a terminal execution report', async () => {
  const jobsRoot = await mkdtemp(path.join(os.tmpdir(), 'targeted-stage-'));
  const jobId = 'layer-job-terminal-test';
  const jobDirectory = path.join(jobsRoot, jobId);
  await mkdir(jobDirectory);
  await writeFile(path.join(jobDirectory, 'layer-review-plan.json'), JSON.stringify({
    layers: [{ id: 'title-1', execution_route_hint: 'codex_rgba_repair' }],
  }));
  await writeFile(path.join(jobDirectory, 'execution-report.json'), JSON.stringify({ status: 'failed' }));

  const result = await runScript([
    '--job-id', jobId,
    '--layer-id', 'title-1',
    '--status', 'alpha_matte',
    '--jobs-root', jobsRoot,
  ]);

  assert.equal(result.code, 1);
  assert.match(result.stderr, /cannot replace terminal execution report/);
  const report = JSON.parse(await readFile(path.join(jobDirectory, 'execution-report.json'), 'utf8'));
  assert.equal(report.status, 'failed');
});
