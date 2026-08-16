import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensurePersistentPythonRuntime, runCommand } from './python-runtime.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pluginRoot = path.join(os.homedir(), 'plugins', 'imvia-layer');

try {
  process.stdout.write('1/3 创建或更新插件专用 Python 运行时并安装 RMBG 依赖…\n');
  const python = await ensurePersistentPythonRuntime({ repositoryRoot, pluginRoot });
  process.stdout.write(`使用持久 Python ${python.version}：${python.command}\n`);
  process.stdout.write('2/3 下载并校验 BRIA RMBG 2.0（bria-rmbg）模型…\n');
  await runCommand(python.command, [...python.args, 'scripts/warm-rmbg.py'], {
    cwd: repositoryRoot,
    stdio: 'inherit',
  });
  process.stdout.write('3/3 注册 Imvia Layer 插件…\n');
  await runCommand(process.execPath, ['scripts/install-codex-plugin.mjs'], {
    cwd: repositoryRoot,
    stdio: 'inherit',
  });
} catch (error) {
  process.stderr.write(`Imvia Layer 初始化失败：${error.message}\n`);
  process.exitCode = 1;
}
