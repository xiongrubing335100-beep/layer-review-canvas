import { isDirectExecution } from './direct-execution.mjs';
import os from 'node:os';
import path from 'node:path';
import { realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { installCodexPluginLocked } from './install-codex-plugin.mjs';
import { ensurePersistentPythonRuntimeLocked, runCommand } from './python-runtime.mjs';
import { withRuntimeInstallLock } from './runtime-install-lock.mjs';

const defaultRepositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function warmModel(python, { repositoryRoot }) {
  await runCommand(python.command, [...python.args, 'scripts/warm-rmbg.py'], {
    cwd: repositoryRoot,
    stdio: 'inherit',
  });
}

export async function setupImviaLayer({
  repositoryRoot = defaultRepositoryRoot,
  pluginRoot = process.env.IMVIA_LAYER_PLUGIN_DIRECTORY || path.join(os.homedir(), 'plugins', 'imvia-layer'),
  marketplacePath = process.env.IMVIA_LAYER_MARKETPLACE_PATH || path.join(os.homedir(), '.agents', 'plugins', 'marketplace.json'),
  ensurePythonLockedImpl = ensurePersistentPythonRuntimeLocked,
  warmModelImpl = warmModel,
  installLockedImpl = installCodexPluginLocked,
  withLockImpl = withRuntimeInstallLock,
  writeOutput = (chunk) => process.stdout.write(chunk),
  runtimeLockOptions,
  skipModelPrewarm = process.env.IMVIA_LAYER_SKIP_MODEL_PREWARM === '1',
} = {}) {
  return withLockImpl({
    pluginRoot,
    lockOptions: runtimeLockOptions,
    task: async () => {
      writeOutput('1/3 创建或更新插件专用 Python 运行时并安装 RMBG 依赖…\n');
      const python = await ensurePythonLockedImpl({ repositoryRoot, pluginRoot });
      writeOutput(`使用持久 Python ${python.version}：${python.command}\n`);
      writeOutput('2/3 下载并校验 BRIA RMBG 2.0（bria-rmbg）模型…\n');
      if (skipModelPrewarm) writeOutput('CI/test 模式：跳过模型预热。\n');
      else await warmModelImpl(python, { repositoryRoot, pluginRoot });
      writeOutput('3/3 注册 Imvia Layer 插件…\n');
      return installLockedImpl({
        repositoryRoot,
        pluginRoot,
        marketplacePath,
        preparedPython: python,
        writeOutput,
      });
    },
  });
}

if (await isDirectExecution(import.meta.url)) {
  setupImviaLayer().catch((error) => {
    process.stderr.write(`Imvia Layer 初始化失败：${error.message}\n`);
    process.exitCode = 1;
  });
}
