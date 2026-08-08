import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runtimeConfigPath = path.join(pluginRoot, 'imvia-layer-runtime.json');

async function resolveWorkbenchRoot() {
  if (process.env.IMVIA_LAYER_WORKBENCH_ROOT) {
    return path.resolve(process.env.IMVIA_LAYER_WORKBENCH_ROOT);
  }
  const runtimeConfig = JSON.parse(await readFile(runtimeConfigPath, 'utf8'));
  if (!runtimeConfig.workbenchRoot) throw new Error('Imvia Layer 缺少工作台路径，请在下载目录运行 npm run install:codex-plugin');
  return path.resolve(runtimeConfig.workbenchRoot);
}

const workbenchRoot = await resolveWorkbenchRoot();
const serverPath = path.join(workbenchRoot, 'layer-review-mcp-server.mjs');
try {
  await access(serverPath);
} catch {
  throw new Error(`Imvia Layer 工作台不存在：${workbenchRoot}。请重新运行 npm run install:codex-plugin`);
}

process.chdir(workbenchRoot);
process.argv.push('--stdio');
await import(pathToFileURL(serverPath).href);
