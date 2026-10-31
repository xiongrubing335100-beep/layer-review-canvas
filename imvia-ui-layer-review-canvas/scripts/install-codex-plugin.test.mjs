import assert from 'node:assert/strict';
import { cp, mkdtemp, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { installCodexPlugin } from './install-codex-plugin.mjs';
import { ensurePersistentNodeLauncherLocked } from './node-runtime.mjs';

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
    ...['package.json', 'package-lock.json', 'requirements-rmbg.txt', 'requirements-rmbg.lock', 'LICENSE', 'vite.config.js', 'index.html', 'codex-thread-bridge.mjs', 'layer-review-mcp-server.mjs'].map((name) =>
      cp(path.join(root, name), path.join(destination, name))),
  ]);
}

function installFixture(repositoryRoot, pluginRoot, marketplacePath) {
  return installCodexPlugin({
    repositoryRoot, pluginRoot, marketplacePath,
    ensurePythonLockedImpl: async () => ({ command: 'fixture-python', args: [], version: '3.12' }),
    ensureNodeLockedImpl: (options) => ensurePersistentNodeLauncherLocked({
      ...options,
      fetchImpl: async () => new Response('Node.js test distribution license\nCopyright Node.js contributors\n'),
    }),
    writeOutput: () => {},
  });
}

test('installer stages a self-contained poster and V2 runtime that runs without its source checkout', async (t) => {
  const stage = await mkdtemp(path.join(os.tmpdir(), 'imvia-plugin-runtime-'));
  t.after(() => rm(stage, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const cloneRoot = path.join(stage, 'clone');
  const pluginRoot = path.join(stage, 'plugin');
  const runtimeRoot = path.join(pluginRoot, 'runtime');
  const outputRoot = path.join(stage, 'output');
  const command = process.execPath;
  await copyRepositoryWithInstalledDependencies(cloneRoot);
  await mkdir(path.join(cloneRoot, 'output'), { recursive: true });
  await writeFile(path.join(cloneRoot, 'output', 'legacy-project.json'), '{"legacy":true}');
  await mkdir(pluginRoot, { recursive: true });
  await writeFile(path.join(pluginRoot, 'imvia-layer-runtime.json'), JSON.stringify({ workbenchRoot: cloneRoot }));
  await installFixture(cloneRoot, pluginRoot, path.join(stage, 'marketplace.json'));
  assert.equal(await readFile(path.join(runtimeRoot, 'output', 'legacy-project.json'), 'utf8'), '{"legacy":true}');
  assert.equal(await readFile(path.join(cloneRoot, 'output', 'legacy-project.json'), 'utf8'), '{"legacy":true}');
  await mkdir(path.join(runtimeRoot, 'output'), { recursive: true });
  await writeFile(path.join(runtimeRoot, 'output', 'user-project.json'), '{"keep":true}');
  await writeFile(path.join(runtimeRoot, 'src', 'obsolete-module.js'), 'obsolete');
  await installFixture(cloneRoot, pluginRoot, path.join(stage, 'marketplace.json'));
  assert.equal(await readFile(path.join(runtimeRoot, 'output', 'user-project.json'), 'utf8'), '{"keep":true}');
  await assert.rejects(stat(path.join(runtimeRoot, 'src', 'obsolete-module.js')), { code: 'ENOENT' });

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
    'scripts/v2-region-pixels.py',
    'scripts/source-guided-matte.py',
    'scripts/matte-registration.py',
    'scripts/semantic-matte.py',
    'scripts/inspect-v2-matte.py',
    'scripts/finalize-v2-candidate.mjs',
    'scripts/export-v2-psd.mjs',
    'src/v2/psd-codec.mjs',
    'requirements-rmbg.lock',
    'node_modules/ag-psd',
    'node_modules/fflate',
  ]) await stat(path.join(runtimeRoot, relativePath));
  const config = JSON.parse(await readFile(path.join(pluginRoot, 'imvia-layer-runtime.json'), 'utf8'));
  assert.equal(config.workbenchRoot, runtimeRoot);
  const marketplace = JSON.parse(await readFile(path.join(stage, 'marketplace.json'), 'utf8'));
  assert.equal(path.resolve(stage, marketplace.plugins[0].source.path), pluginRoot);

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

  await writeFile(path.join(cloneRoot, 'src', 'main.jsx'), 'this is not valid JavaScript !!!');
  await assert.rejects(installFixture(cloneRoot, pluginRoot, path.join(stage, 'marketplace.json')));
  assert.deepEqual(JSON.parse(await readFile(path.join(pluginRoot, 'imvia-layer-runtime.json'), 'utf8')), config);
  assert.equal(await readFile(path.join(runtimeRoot, 'output', 'user-project.json'), 'utf8'), '{"keep":true}');
  await rename(cloneRoot, `${cloneRoot}-unavailable`);
  const runtimeScriptUrl = pathToFileURL(path.join(runtimeRoot, 'scripts', 'prepare-poster-job.mjs')).href;
  const psdCodecUrl = pathToFileURL(path.join(runtimeRoot, 'src', 'v2', 'psd-codec.mjs')).href;
  const smokeProgram = [
    `const { preparePosterJob } = await import(${JSON.stringify(runtimeScriptUrl)});`,
    `await preparePosterJob({ outputRoot: ${JSON.stringify(outputRoot)}, jobId: 'missing-job', phase: 'analysis' })`,
    ".then(() => { throw new Error('missing job unexpectedly prepared'); })",
    ".catch((error) => { if (!/outputRoot|poster job does not exist/.test(error.message)) throw error; });",
    `const { encodePsd, inspectPsd } = await import(${JSON.stringify(psdCodecUrl)});`,
    'const image = { width: 1, height: 1, data: new Uint8ClampedArray([255, 0, 0, 255]) };',
    "const psd = inspectPsd(encodePsd({ width: 1, height: 1, layers: [{ name: 'fixture', image, placement: { x: 0, y: 0 }, blendMode: 'normal' }], composite: image, availableMemory: 1e9 }));",
    "if (psd.layers[0].name !== 'fixture' || psd.layers[0].image.data[0] !== 255) throw new Error('installed PSD roundtrip failed');",
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

    await installFixture(cloneRoot, pluginRoot, path.join(stage, 'marketplace.json'));

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

    await assert.rejects(installFixture(cloneRoot, pluginRoot, path.join(stage, 'marketplace.json')),
      /海报分层适配技能契约不完整/);
    await assert.rejects(stat(path.join(pluginRoot, '.mcp.json')), { code: 'ENOENT' });
    await assert.rejects(stat(path.join(stage, 'marketplace.json')), { code: 'ENOENT' });
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
});
