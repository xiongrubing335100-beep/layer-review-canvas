import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runtimeConfigPath = path.join(pluginRoot, 'imvia-layer-runtime.json');

async function resolveRuntimeConfig() {
  if (process.env.IMVIA_LAYER_WORKBENCH_ROOT) {
    return { workbenchRoot: process.env.IMVIA_LAYER_WORKBENCH_ROOT };
  }
  return JSON.parse(await readFile(runtimeConfigPath, 'utf8'));
}

const runtimeConfig = await resolveRuntimeConfig();
if (!runtimeConfig.workbenchRoot) throw new Error('Imvia Layer 缺少工作台路径，请在下载目录运行 npm run setup');
const workbenchRoot = path.resolve(runtimeConfig.workbenchRoot);
if (typeof runtimeConfig.python?.command === 'string' && runtimeConfig.python.command) {
  process.env.IMVIA_LAYER_PYTHON_COMMAND = runtimeConfig.python.command;
  process.env.IMVIA_LAYER_PYTHON_ARGS = JSON.stringify(Array.isArray(runtimeConfig.python.args) ? runtimeConfig.python.args : []);
}
const serverPath = path.join(workbenchRoot, 'layer-review-mcp-server.mjs');
try {
  await access(serverPath);
} catch {
  throw new Error(`Imvia Layer 工作台不存在：${workbenchRoot}。请重新运行 npm run install:codex-plugin`);
}

process.chdir(workbenchRoot);
process.argv.push('--stdio');
await import(pathToFileURL(serverPath).href);
