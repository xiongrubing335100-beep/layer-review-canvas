import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../scripts/report-split-performance.mjs', import.meta.url));

async function withFixture(setup, run) {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'split-performance-'));
  try {
    await setup(cwd);
    return run(cwd);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

function report(cwd, ...args) {
  return spawnSync(process.execPath, [script, ...args], { cwd, encoding: 'utf8' });
}

async function writeJson(cwd, relativePath, value) {
  const destination = path.join(cwd, relativePath);
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, JSON.stringify(value));
}

async function writeCompletedJob(cwd, name, route, seconds) {
  await writeJson(cwd, `output/jobs/${name}/layer-review-plan.json`, {
    status: 'completed',
    submitted_at: '2026-01-01T00:00:00.000Z',
    codex_completed_at: new Date(Date.parse('2026-01-01T00:00:00.000Z') + seconds * 1000).toISOString(),
    layers: [{ execution_route_hint: route }],
  });
}

test('normal report exits zero when job history is missing', async () => {
  await withFixture(async () => {}, (cwd) => {
    const result = report(cwd);
    assert.equal(result.status, 0);
    assert.deepEqual(JSON.parse(result.stdout).summary, {});
  });
});

test('gate requires a baseline', async () => {
  await withFixture(async () => {}, (cwd) => {
    const result = report(cwd, '--require-fast-improvement', '40');
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /--baseline/);
  });
});

test('gate rejects an invalid threshold', async () => {
  await withFixture(async (cwd) => {
    await writeJson(cwd, 'baseline.json', { summary: {} });
  }, (cwd) => {
    const result = report(cwd, '--baseline', 'baseline.json', '--require-fast-improvement', 'fast');
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /finite number/);
  });
});

test('gate fails when an expected simple route is missing', async () => {
  await withFixture(async (cwd) => {
    await writeCompletedJob(cwd, 'layer-job-direct', 'direct_crop', 50);
    await writeJson(cwd, 'baseline.json', {
      summary: {
        direct_crop: { medianSeconds: 100 },
        alpha_extract: { medianSeconds: 200 },
      },
    });
  }, (cwd) => {
    const result = report(cwd, '--baseline', 'baseline.json', '--require-fast-improvement', '40');
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /alpha_extract/);
  });
});

test('gate passes when both simple routes improve by at least forty percent', async () => {
  await withFixture(async (cwd) => {
    await writeCompletedJob(cwd, 'layer-job-direct', 'direct_crop', 50);
    await writeCompletedJob(cwd, 'layer-job-alpha', 'alpha_extract', 100);
    await writeJson(cwd, 'baseline.json', {
      summary: {
        direct_crop: { medianSeconds: 100 },
        alpha_extract: { medianSeconds: 200 },
      },
    });
  }, (cwd) => {
    const result = report(cwd, '--baseline', 'baseline.json', '--require-fast-improvement', '40');
    assert.equal(result.status, 0);
    assert.deepEqual(JSON.parse(result.stdout).improvements, {
      direct_crop: 50,
      alpha_extract: 50,
    });
  });
});

test('legacy jobs without reports or timing are skipped without crashing', async () => {
  await withFixture(async (cwd) => {
    await writeJson(cwd, 'output/jobs/layer-job-legacy/layer-review-plan.json', {
      status: 'completed',
      layers: [{ execution_route_hint: 'legacy' }],
    });
  }, (cwd) => {
    const result = report(cwd);
    assert.equal(result.status, 0);
    assert.deepEqual(JSON.parse(result.stdout).samples, []);
  });
});
