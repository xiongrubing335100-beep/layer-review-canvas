import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const helperUrl = new URL('../plugin-template/imvia-layer/scripts/runtime-config.mjs', import.meta.url);

test('plugin startup uses the verified runtime resolver instead of reading unverified JSON directly', async () => {
  const source = await readFile(new URL('../plugin-template/imvia-layer/scripts/start-mcp.mjs', import.meta.url), 'utf8');
  assert.match(source, /resolveVerifiedRuntimeConfig/);
  assert.doesNotMatch(source, /JSON\.parse\(await readFile\(runtimeConfigPath/);
});

async function loadHelper() {
  try {
    return await import(`${helperUrl.href}?test=${Date.now()}-${Math.random()}`);
  } catch {
    return null;
  }
}

test('broken installed Python triggers repo installer repair and reloads verified runtime JSON', async (t) => {
  const helper = await loadHelper();
  assert.ok(helper, 'plugin runtime repair helper must exist');
  assert.equal(typeof helper.resolveVerifiedRuntimeConfig, 'function');

  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'imvia plugin repair-'));
  const pluginRoot = path.join(temporaryRoot, 'plugins', 'imvia-layer');
  const repositoryRoot = path.join(temporaryRoot, 'repo with spaces');
  const runtimePath = path.join(pluginRoot, 'imvia-layer-runtime.json');
  const brokenConfig = {
    workbenchRoot: repositoryRoot,
    python: { command: path.join(pluginRoot, '.python-runtime', 'bin', 'python'), args: [] },
  };
  const repairedConfig = {
    workbenchRoot: repositoryRoot,
    python: { command: path.join(pluginRoot, '.python-runtime-repaired', 'bin', 'python'), args: [] },
  };
  await mkdir(pluginRoot, { recursive: true });
  await mkdir(path.join(repositoryRoot, 'scripts'), { recursive: true });
  await writeFile(runtimePath, `${JSON.stringify(brokenConfig)}\n`);
  t.after(() => import('node:fs/promises').then(({ rm }) => rm(temporaryRoot, { recursive: true, force: true })));

  const calls = [];
  let forwardedDiagnostics = '';
  const runCommandImpl = async (command, args, options) => {
    calls.push({ command, args, options });
    if (command === brokenConfig.python.command) {
      const error = new Error('base command disappeared');
      error.code = 'ENOENT';
      throw error;
    }
    if (command === '/Applications/Codex App/node') {
      await writeFile(runtimePath, `${JSON.stringify(repairedConfig)}\n`);
      return { stdout: 'installer status on stdout\n', stderr: 'installer detail on stderr\n' };
    }
    if (command === repairedConfig.python.command) return { stdout: '2.0.69\n', stderr: '' };
    throw new Error(`unexpected command: ${command}`);
  };

  const resolved = await helper.resolveVerifiedRuntimeConfig({
    pluginRoot,
    processExecPath: '/Applications/Codex App/node',
    runCommandImpl,
    writeStderr: (chunk) => { forwardedDiagnostics += chunk; },
  });
  assert.deepEqual(resolved, repairedConfig);
  assert.deepEqual(calls.map(({ command }) => command), [
    brokenConfig.python.command,
    '/Applications/Codex App/node',
    repairedConfig.python.command,
  ]);
  assert.deepEqual(calls[1].args, [path.join(repositoryRoot, 'scripts', 'install-codex-plugin.mjs')]);
  assert.equal(calls[1].options.cwd, repositoryRoot);
  assert.equal(calls[1].options.stdio, 'pipe');
  assert.equal(calls[0].options.env.NUMBA_DISABLE_JIT, '1');
  assert.equal(calls[2].options.env.NUMBA_DISABLE_JIT, '1');
  assert.equal(forwardedDiagnostics, 'installer status on stdout\ninstaller detail on stderr\n');
});

test('failed automatic repair reports an actionable setup command without rewriting runtime JSON', async (t) => {
  const helper = await loadHelper();
  assert.ok(helper, 'plugin runtime repair helper must exist');

  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'imvia plugin repair failure-'));
  const pluginRoot = path.join(temporaryRoot, 'plugins', 'imvia-layer');
  const repositoryRoot = path.join(temporaryRoot, 'repo');
  const runtimePath = path.join(pluginRoot, 'imvia-layer-runtime.json');
  const original = `${JSON.stringify({
    workbenchRoot: repositoryRoot,
    python: { command: 'missing-python', args: [] },
  }, null, 2)}\n`;
  await mkdir(pluginRoot, { recursive: true });
  await writeFile(runtimePath, original);
  t.after(() => import('node:fs/promises').then(({ rm }) => rm(temporaryRoot, { recursive: true, force: true })));

  await assert.rejects(
    helper.resolveVerifiedRuntimeConfig({
      pluginRoot,
      processExecPath: '/Codex/node',
      runCommandImpl: async (command) => {
        if (command === 'missing-python') throw new Error('runtime probe failed');
        throw new Error('installer repair failed');
      },
    }),
    /Python runtime.*自动修复失败.*installer repair failed.*npm run setup/s,
  );
  assert.equal(await readFile(runtimePath, 'utf8'), original);
});
