import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';

const applicationDirectory = fileURLToPath(new URL('..', import.meta.url));
const protectedPath = /(?:^|\/)(?:apps\/(?:bridge-server|photoshop-[^/]+)(?:\/|$)|_codex\/collab\/shared(?:\/|$)|poster-layer-manifest-v3\.1\.json$|lovart-poster-layering-v3-1(?:\/|$))/i;

test('Task 5 historical diff excludes protected paths when its original Git evidence is available', t => {
  // These are historical references, not a baseline for all future product
  // changes. Imported release archives may not include their commit objects.
  const missing = ['3eb88db^', '73c1c96'].filter(revision => spawnSync(
    'git', ['rev-parse', '--verify', `${revision}^{commit}`],
    { cwd: applicationDirectory, encoding: 'utf8' },
  ).status !== 0);
  if (missing.length) {
    t.skip(`Historical Git evidence unavailable: ${missing.join(', ')}; current UI/dependency checks still run`);
    return;
  }
  const changed = execFileSync('git', ['diff', '--name-only', '3eb88db^..73c1c96', '--'], {
    cwd: applicationDirectory, encoding: 'utf8',
  });
  assert.deepEqual(changed.split('\n').filter(file => protectedPath.test(file)), []);
});

test('retained high-quality review and fast workbench render independently without protected runtime dependencies', async t => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'imvia-task5-contract-'));
  let vite;
  t.after(async () => { await vite?.close(); await rm(temporaryRoot, { recursive: true, force: true }); });
  vite = await createServer({
    root: applicationDirectory, configFile: false, plugins: [react()],
    cacheDir: path.join(temporaryRoot, 'vite-cache'),
    optimizeDeps: { noDiscovery: true, include: [] },
    server: { middlewareMode: true, watch: null, ws: false }, appType: 'custom',
  });
  const { PosterPlanReview } = await vite.ssrLoadModule('/src/PosterPlanReview.jsx');
  const { PosterCandidateReview } = await vite.ssrLoadModule('/src/PosterCandidateReview.jsx');
  const { PosterFastWorkbench } = await vite.ssrLoadModule('/src/PosterFastWorkbench.jsx');
  const plan = {
    plan_version: 2, status: 'PLAN_CONFIRMED', source: { width: 1200, height: 1800 },
    layers: [{ layer_index: 1, layer_name: '花束', processing_category: 'subject',
      bounds: { percentage: { x: 10, y: 20, width: 30, height: 40 } }, status: 'PENDING' }],
  };
  const original = structuredClone(plan);
  const planMarkup = renderToStaticMarkup(createElement(PosterPlanReview, {
    plan, validation: { valid: true, errors: [] },
  }));
  assert.match(planMarkup, /aria-label="海报图层计划复核"/);
  assert.match(planMarkup, /确认海报计划/);
  const reviewMarkup = renderToStaticMarkup(createElement(PosterCandidateReview, {
    sourceUrl: '/original.png', candidateUrl: '/candidate.png', layer: plan.layers[0],
    review: { status: 'NEEDS_USER_REVIEW', canAccept: true, canRetry: true },
  }));
  assert.match(reviewMarkup, /接受候选/);
  assert.match(reviewMarkup, /src="\/original\.png"/);
  assert.match(reviewMarkup, /src="\/candidate\.png"/);
  const fastMarkup = renderToStaticMarkup(createElement(PosterFastWorkbench, {
    plan, selectedLayerIndex: 1, sourceUrl: '/original.png', sourceSize: plan.source,
  }));
  assert.match(fastMarkup, /aria-label="海报快速分层工作台"/);
  assert.match(fastMarkup, /可拖动的当前项目框选/);
  assert.match(fastMarkup, /PNG 回传展示区/);
  assert.doesNotMatch(fastMarkup, /class="poster-candidate-review|class="poster-plan-review|class="poster-completion/);
  assert.deepEqual(plan, original, 'rendering either workbench must preserve the input plan');

  const dependencyPaths = [...vite.moduleGraph.idToModuleMap.keys()].map(id => id.replaceAll('\\', '/'));
  assert.ok(dependencyPaths.some(id => id.endsWith('/src/PosterFastWorkbench.jsx')));
  assert.deepEqual(dependencyPaths.filter(id => protectedPath.test(id)), []);

  const styles = await readFile(new URL('./styles.css', import.meta.url), 'utf8');
  for (const className of ['poster-plan-review', 'poster-candidate-review', 'poster-fast-workbench__']) {
    assert.ok(styles.includes(`.${className}`), `retained rendered UI requires ${className} styles`);
  }
});
