import assert from 'node:assert/strict';
import { cp, mkdtemp, mkdir, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '..');

function run(command, args, options) {
  return new Promise((resolve, reject) => {
    execFile(command, args, options, (error, stdout, stderr) => {
      if (error) reject(Object.assign(error, { stdout, stderr }));
      else resolve({ stdout, stderr });
    });
  });
}

async function copyRepositoryWithInstalledDependencies(destination) {
  await mkdir(destination, { recursive: true });
  await Promise.all([
    ...['src', 'scripts', 'public', 'plugin-template', 'node_modules'].map((name) =>
      cp(path.join(root, name), path.join(destination, name), { recursive: true })),
    ...['package.json', 'vite.config.js', 'index.html', 'codex-thread-bridge.mjs', 'layer-review-mcp-server.mjs'].map((name) =>
      cp(path.join(root, name), path.join(destination, name))),
  ]);
}

test('installer stages a self-contained poster adapter runtime that runs from another cwd', async () => {
  const stage = await mkdtemp(path.join(os.tmpdir(), 'imvia-plugin-runtime-'));
  const pluginRoot = path.join(stage, 'plugin');
  const runtimeRoot = path.join(pluginRoot, 'runtime');
  const outputRoot = path.join(stage, 'output');
  const command = process.execPath;
  await run(command, ['scripts/install-codex-plugin.mjs'], {
    cwd: root,
    env: {
      ...process.env,
      IMVIA_LAYER_PLUGIN_DIRECTORY: pluginRoot,
      IMVIA_LAYER_MARKETPLACE_PATH: path.join(stage, 'marketplace.json'),
    },
  });

  await assert.doesNotReject(run(command, ['scripts/install-codex-plugin.mjs'], {
    cwd: root,
    env: {
      ...process.env,
      IMVIA_LAYER_PLUGIN_DIRECTORY: pluginRoot,
      IMVIA_LAYER_MARKETPLACE_PATH: path.join(stage, 'marketplace.json'),
    },
  }));

  for (const relativePath of [
    'scripts/prepare-poster-job.mjs',
    'scripts/finalize-poster-analysis.mjs',
    'scripts/finalize-poster-candidate.mjs',
    'scripts/finalize-poster-fast-rmbg-candidate.mjs',
    'scripts/finalize-poster-generation-failure.mjs',
    'scripts/finalize-rmbg.py',
    'scripts/prepare-poster-rmbg-candidate.py',
    'scripts/normalize-poster-layer.py',
    'scripts/audit-poster-recomposition.py',
    'src/poster-job-store.js',
    'src/assets/poster-layer-manifest-v3.1.json',
    'node_modules/fflate',
  ]) await stat(path.join(runtimeRoot, relativePath));

  const adapter = await readFile(path.join(pluginRoot, 'skills', 'imvia-poster-layering-workbench-v1', 'SKILL.md'), 'utf8');
  const targeted = await readFile(path.join(pluginRoot, 'skills', 'imvia-poster-layering-workbench-targeted-v1', 'SKILL.md'), 'utf8');
  const categoryBlocks = await readFile(path.join(pluginRoot, 'skills', 'imvia-poster-layering-workbench-targeted-v1', 'references', 'category-blocks.md'), 'utf8');
  assert.match(adapter, /RUNTIME_DIR/);
  assert.match(adapter, /prepare-poster-job\.mjs/);
  assert.match(adapter, /finalize-poster-generation-failure\.mjs/);
  assert.doesNotMatch(adapter, /workbench-supplied/);
  assert.match(targeted, /lovart-poster-layering-v3-1/);
  assert.match(targeted, /恰好一个类别/);
  assert.match(categoryBlocks, /subject[\s\S]*text[\s\S]*brand_ui[\s\S]*decoration_prop[\s\S]*effect[\s\S]*background/);
  assert.equal((categoryBlocks.match(/^## (subject|text|brand_ui|decoration_prop|effect|background)$/gm) || []).length, 6);

  const runtimeScriptUrl = new URL(`file://${path.join(runtimeRoot, 'scripts', 'prepare-poster-job.mjs')}`).href;
  const smokeProgram = [
    `const { preparePosterJob } = await import(${JSON.stringify(runtimeScriptUrl)});`,
    `await preparePosterJob({ outputRoot: ${JSON.stringify(outputRoot)}, jobId: 'missing-job', phase: 'analysis' })`,
    ".then(() => { throw new Error('missing job unexpectedly prepared'); })",
    ".catch((error) => { if (!/outputRoot|poster job does not exist/.test(error.message)) throw error; });",
  ].join('');
  await assert.doesNotReject(run(command, ['--input-type=module', '--eval', smokeProgram], { cwd: stage }));
});

test('installer builds and stages production dist from a fresh clone with installed dependencies', async () => {
  const stage = await mkdtemp(path.join(os.tmpdir(), 'imvia-plugin-clean-clone-'));
  const cloneRoot = path.join(stage, 'clone');
  const pluginRoot = path.join(stage, 'plugin');
  try {
    await copyRepositoryWithInstalledDependencies(cloneRoot);
    await assert.rejects(stat(path.join(cloneRoot, 'dist', 'index.html')), { code: 'ENOENT' });

    await run(process.execPath, ['scripts/install-codex-plugin.mjs'], {
      cwd: cloneRoot,
      env: {
        ...process.env,
        IMVIA_LAYER_PLUGIN_DIRECTORY: pluginRoot,
        IMVIA_LAYER_MARKETPLACE_PATH: path.join(stage, 'marketplace.json'),
      },
    });

    await stat(path.join(cloneRoot, 'dist', 'index.html'));
    await stat(path.join(pluginRoot, 'runtime', 'index.html'));
    await stat(path.join(pluginRoot, 'runtime', 'dist', 'index.html'));
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
});

test('installer refuses to publish a targeted poster adapter without the fast RMBG finalizer', async () => {
  const stage = await mkdtemp(path.join(os.tmpdir(), 'imvia-plugin-missing-fast-finalizer-'));
  const cloneRoot = path.join(stage, 'clone');
  const pluginRoot = path.join(stage, 'plugin');
  try {
    await copyRepositoryWithInstalledDependencies(cloneRoot);
    await rm(path.join(cloneRoot, 'scripts', 'finalize-poster-fast-rmbg-candidate.mjs'));

    await assert.rejects(run(process.execPath, ['scripts/install-codex-plugin.mjs'], {
      cwd: cloneRoot,
      env: {
        ...process.env,
        IMVIA_LAYER_PLUGIN_DIRECTORY: pluginRoot,
        IMVIA_LAYER_MARKETPLACE_PATH: path.join(stage, 'marketplace.json'),
      },
    }), /海报分层适配技能契约不完整/);
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
});
