// Imvia Layer © 2026 青木. Personal non-commercial use is free; commercial use requires a paid license. See LICENSE and NOTICE.md.
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { shell: false, ...options });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk) => { stdout += chunk; });
    child.stderr?.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${command} exited with code ${code}: ${stderr.trim()}`));
    });
  });
}

async function readRuntimeConfig(pluginRoot, environment) {
  const runtimePath = path.join(pluginRoot, 'imvia-layer-runtime.json');
  const config = JSON.parse(await readFile(runtimePath, 'utf8'));
  if (environment.IMVIA_LAYER_WORKBENCH_ROOT) {
    config.workbenchRoot = environment.IMVIA_LAYER_WORKBENCH_ROOT;
  }
  return config;
}

async function probePython(config, environment, runCommandImpl) {
  const command = config.python?.command;
  if (typeof command !== 'string' || !command) throw new Error('runtime JSON 缺少 Python command');
  const args = Array.isArray(config.python.args) ? config.python.args : [];
  await runCommandImpl(command, [...args, '-c', 'import rembg'], {
    cwd: config.workbenchRoot,
    stdio: 'pipe',
    env: { ...environment, NUMBA_DISABLE_JIT: '1' },
  });
}

export async function resolveVerifiedRuntimeConfig({
  pluginRoot,
  processExecPath = process.execPath,
  environment = process.env,
  runCommandImpl = runCommand,
  writeStderr = (chunk) => process.stderr.write(chunk),
} = {}) {
  if (!pluginRoot) throw new Error('Imvia Layer 缺少 pluginRoot');

  let config;
  try {
    config = await readRuntimeConfig(pluginRoot, environment);
  } catch (error) {
    throw new Error(`Imvia Layer runtime JSON 无法读取：${error.message}。请在项目目录运行 npm run setup`, { cause: error });
  }
  if (!config.workbenchRoot) throw new Error('Imvia Layer 缺少工作台路径，请在下载目录运行 npm run setup');

  try {
    await probePython(config, environment, runCommandImpl);
    return config;
  } catch (probeError) {
    const installerPath = path.join(config.workbenchRoot, 'scripts', 'install-codex-plugin.mjs');
    try {
      const repairResult = await runCommandImpl(processExecPath, [installerPath], {
        cwd: config.workbenchRoot,
        stdio: 'pipe',
        env: {
          ...environment,
          IMVIA_LAYER_PLUGIN_DIRECTORY: pluginRoot,
          ...(config.marketplacePath ? { IMVIA_LAYER_MARKETPLACE_PATH: config.marketplacePath } : {}),
        },
      });
      if (repairResult.stdout) writeStderr(repairResult.stdout);
      if (repairResult.stderr) writeStderr(repairResult.stderr);
      const repaired = await readRuntimeConfig(pluginRoot, environment);
      if (!repaired.workbenchRoot) throw new Error('修复后的 runtime JSON 缺少工作台路径');
      await probePython(repaired, environment, runCommandImpl);
      return repaired;
    } catch (repairError) {
      throw new Error(
        `Imvia Layer Python runtime 不可用（${probeError.message}），自动修复失败：${repairError.message}。请在 ${config.workbenchRoot} 运行 npm run setup`,
        { cause: repairError },
      );
    }
  }
}
