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

const passingValidation = {
  count: true,
  dimensions: true,
  alpha: true,
  annotation_conformance: true,
  obvious_exclusion: true,
};

async function writeCompletedJob(cwd, name, route, seconds, {
  layerCount = 1,
  report = true,
  reportRoute = route,
  reportTiming = true,
  machineTiming = false,
  postprocessSeconds = null,
  status = 'completed',
  validationResults = passingValidation,
} = {}) {
  const submittedAt = Date.parse('2026-01-01T00:00:00.000Z');
  const machineStart = machineTiming ? submittedAt + 10_000 : submittedAt;
  const completedAt = machineStart + seconds * 1000;
  const completedIso = new Date(completedAt).toISOString();
  const timing = reportTiming ? {
    submitted_at: new Date(submittedAt).toISOString(),
    ...(machineTiming ? {
      confirmation_accepted_at: new Date(machineStart).toISOString(),
      ...(postprocessSeconds === null ? {} : {
        postprocess_started_at: new Date(completedAt - (postprocessSeconds * 1000) - 1000).toISOString(),
        rmbg_started_at: new Date(completedAt - 1000).toISOString(),
      }),
    } : {}),
    completed_at: completedIso,
  } : undefined;
  await writeJson(cwd, `output/jobs/${name}/layer-review-plan.json`, {
    status: 'completed',
    submitted_at: new Date(submittedAt).toISOString(),
    codex_completed_at: completedIso,
    layers: Array.from({ length: layerCount }, () => ({ execution_route_hint: route })),
  });
  if (report) {
    await writeJson(cwd, `output/jobs/${name}/execution-report.json`, {
      status,
      execution_route: reportRoute,
      timing,
      validation_results: validationResults,
    });
  }
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

test('gate requires an explicit current-job id set', async () => {
  await withFixture(async (cwd) => {
    await writeJson(cwd, 'baseline.json', { summary: {} });
  }, (cwd) => {
    const result = report(cwd, '--baseline', 'baseline.json', '--require-fast-improvement', '40');
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /--job-ids/);
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
    const result = report(cwd, '--job-ids', 'layer-job-direct', '--baseline', 'baseline.json', '--require-fast-improvement', '40');
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
    const result = report(cwd, '--job-ids', 'layer-job-direct,layer-job-alpha', '--baseline', 'baseline.json', '--require-fast-improvement', '40');
    assert.equal(result.status, 0);
    assert.deepEqual(JSON.parse(result.stdout).improvements, {
      direct_crop: 50,
      alpha_extract: 50,
    });
  });
});

test('gate uses exactly the requested current jobs', async () => {
  await withFixture(async (cwd) => {
    await writeCompletedJob(cwd, 'layer-job-direct', 'direct_crop', 50);
    await writeCompletedJob(cwd, 'layer-job-alpha', 'alpha_extract', 100);
    await writeCompletedJob(cwd, 'layer-job-unrelated', 'direct_crop', 1);
    await writeJson(cwd, 'baseline.json', {
      summary: {
        direct_crop: { medianSeconds: 100 },
        alpha_extract: { medianSeconds: 200 },
      },
    });
  }, (cwd) => {
    const result = report(cwd, '--job-ids', 'layer-job-direct,layer-job-alpha', '--baseline', 'baseline.json', '--require-fast-improvement', '40');
    assert.equal(result.status, 0);
    assert.deepEqual(JSON.parse(result.stdout).samples.map((sample) => sample.jobId), [
      'layer-job-alpha',
      'layer-job-direct',
    ]);
  });
});

test('gate rejects a requested job id that is missing', async () => {
  await withFixture(async (cwd) => {
    await writeCompletedJob(cwd, 'layer-job-direct', 'direct_crop', 50);
    await writeJson(cwd, 'baseline.json', { summary: {} });
  }, (cwd) => {
    const result = report(cwd, '--job-ids', 'layer-job-direct,layer-job-missing', '--baseline', 'baseline.json', '--require-fast-improvement', '40');
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /layer-job-missing/);
  });
});

test('gate rejects failed jobs', async () => {
  await withFixture(async (cwd) => {
    await writeCompletedJob(cwd, 'layer-job-failed', 'direct_crop', 50, { status: 'failed' });
    await writeJson(cwd, 'baseline.json', { summary: {} });
  }, (cwd) => {
    const result = report(cwd, '--job-ids', 'layer-job-failed', '--baseline', 'baseline.json', '--require-fast-improvement', '40');
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /failed|completed/);
  });
});

test('gate rejects skipped jobs with non-positive duration', async () => {
  await withFixture(async (cwd) => {
    await writeCompletedJob(cwd, 'layer-job-zero', 'direct_crop', 0);
    await writeJson(cwd, 'baseline.json', { summary: {} });
  }, (cwd) => {
    const result = report(cwd, '--job-ids', 'layer-job-zero', '--baseline', 'baseline.json', '--require-fast-improvement', '40');
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /positive duration/);
  });
});

test('gate rejects multi-layer jobs', async () => {
  await withFixture(async (cwd) => {
    await writeCompletedJob(cwd, 'layer-job-multiple', 'direct_crop', 50, { layerCount: 2 });
    await writeJson(cwd, 'baseline.json', { summary: {} });
  }, (cwd) => {
    const result = report(cwd, '--job-ids', 'layer-job-multiple', '--baseline', 'baseline.json', '--require-fast-improvement', '40');
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /exactly one layer/);
  });
});

test('gate rejects a report route that differs from the planned route', async () => {
  await withFixture(async (cwd) => {
    await writeCompletedJob(cwd, 'layer-job-mixed', 'direct_crop', 50, { reportRoute: 'alpha_extract' });
    await writeJson(cwd, 'baseline.json', { summary: {} });
  }, (cwd) => {
    const result = report(cwd, '--job-ids', 'layer-job-mixed', '--baseline', 'baseline.json', '--require-fast-improvement', '40');
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /route/);
  });
});

test('gate rejects current jobs without execution reports', async () => {
  await withFixture(async (cwd) => {
    await writeCompletedJob(cwd, 'layer-job-no-report', 'direct_crop', 50, { report: false });
    await writeJson(cwd, 'baseline.json', { summary: {} });
  }, (cwd) => {
    const result = report(cwd, '--job-ids', 'layer-job-no-report', '--baseline', 'baseline.json', '--require-fast-improvement', '40');
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /execution report/);
  });
});

test('gate rejects current jobs without executor report timing', async () => {
  await withFixture(async (cwd) => {
    await writeCompletedJob(cwd, 'layer-job-no-report-timing', 'direct_crop', 50, { reportTiming: false });
    await writeJson(cwd, 'baseline.json', { summary: {} });
  }, (cwd) => {
    const result = report(cwd, '--job-ids', 'layer-job-no-report-timing', '--baseline', 'baseline.json', '--require-fast-improvement', '40');
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /report timing/);
  });
});

test('gate rejects current jobs without passing mandatory validation results', async () => {
  await withFixture(async (cwd) => {
    await writeCompletedJob(cwd, 'layer-job-invalid', 'direct_crop', 50, {
      validationResults: { ...passingValidation, alpha: false },
    });
    await writeJson(cwd, 'baseline.json', { summary: {} });
  }, (cwd) => {
    const result = report(cwd, '--job-ids', 'layer-job-invalid', '--baseline', 'baseline.json', '--require-fast-improvement', '40');
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /validation/);
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

test('targeted gates use confirmation acceptance time and enforce P50, P90, and postprocess limits', async () => {
  await withFixture(async (cwd) => {
    await writeCompletedJob(cwd, 'layer-job-targeted-a', 'targeted_repair', 100, {
      machineTiming: true,
      postprocessSeconds: 10,
    });
    await writeCompletedJob(cwd, 'layer-job-targeted-b', 'targeted_repair', 120, {
      machineTiming: true,
      postprocessSeconds: 12,
    });
    await writeCompletedJob(cwd, 'layer-job-targeted-c', 'targeted_repair', 140, {
      machineTiming: true,
      postprocessSeconds: 15,
    });
  }, (cwd) => {
    const result = report(cwd,
      '--job-ids', 'layer-job-targeted-a,layer-job-targeted-b,layer-job-targeted-c',
      '--require-targeted-p50-seconds', '120',
      '--require-targeted-p90-seconds', '136',
      '--require-postprocess-seconds', '15',
    );
    assert.equal(result.status, 0);
    const output = JSON.parse(result.stdout);
    assert.equal(output.summary.targeted_repair.p50Seconds, 120);
    assert.equal(output.summary.targeted_repair.p90Seconds, 136);
    assert.equal(output.summary.targeted_repair.maxPostprocessSeconds, 15);
    assert.equal(output.samples[0].seconds, 100);
  });
});

test('targeted gates reject missing confirmation timing', async () => {
  await withFixture(async (cwd) => {
    await writeCompletedJob(cwd, 'layer-job-targeted-legacy', 'targeted_repair', 100);
  }, (cwd) => {
    const result = report(cwd,
      '--job-ids', 'layer-job-targeted-legacy',
      '--require-targeted-p50-seconds', '120',
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /timing is incomplete/);
  });
});

test('targeted gates reject slow postprocess', async () => {
  await withFixture(async (cwd) => {
    await writeCompletedJob(cwd, 'layer-job-targeted-slow', 'targeted_repair', 100, {
      machineTiming: true,
      postprocessSeconds: 31,
    });
  }, (cwd) => {
    const result = report(cwd,
      '--job-ids', 'layer-job-targeted-slow',
      '--require-postprocess-seconds', '30',
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /postprocess duration/);
  });
});
