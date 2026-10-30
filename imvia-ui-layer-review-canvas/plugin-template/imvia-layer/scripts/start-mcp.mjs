// Imvia Layer © 2026 青木. Personal non-commercial use is free; commercial use requires a paid license. See LICENSE and NOTICE.md.
import { access, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolveVerifiedRuntimeConfig } from './runtime-config.mjs';

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runtimeConfig = await resolveVerifiedRuntimeConfig({ pluginRoot });
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
// The server guards its startup with the executable entrypoint. Delegate that
// entrypoint to the installed server before importing it in this process.
process.argv[1] = await realpath(serverPath);
process.argv.push('--stdio');
await import(pathToFileURL(serverPath).href);
