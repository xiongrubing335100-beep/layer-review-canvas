import { constants as fsConstants } from 'node:fs';
import { access } from 'node:fs/promises';
import path from 'node:path';

function unavailable(message, cause) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.code = 'RMBG_RUNTIME_UNAVAILABLE';
  return error;
}

export function posterManagedPythonPath(pluginRoot, platform = process.platform) {
  const resolvedPluginRoot = path.resolve(pluginRoot);
  return platform === 'win32'
    ? path.join(resolvedPluginRoot, '.python-runtime', 'Scripts', 'python.exe')
    : path.join(resolvedPluginRoot, '.python-runtime', 'bin', 'python');
}

export async function resolvePluginManagedPython({
  pluginRoot,
  platform = process.platform,
} = {}) {
  if (typeof pluginRoot !== 'string' || pluginRoot.length === 0) {
    throw unavailable('RMBG 插件运行时缺少 pluginRoot');
  }
  const resolvedPluginRoot = path.resolve(pluginRoot);
  const command = posterManagedPythonPath(resolvedPluginRoot, platform);
  try {
    await access(command, platform === 'win32' ? fsConstants.F_OK : fsConstants.X_OK);
  } catch (cause) {
    throw unavailable(`RMBG 插件自带 Python 不可用：${command}`, cause);
  }
  return { command, args: [], pluginRoot: resolvedPluginRoot };
}

export async function resolvePosterManagedPython({
  outputRoot,
  platform = process.platform,
} = {}) {
  if (typeof outputRoot !== 'string' || outputRoot.length === 0) {
    throw unavailable('RMBG 后处理缺少 outputRoot');
  }
  const resolvedOutputRoot = path.resolve(outputRoot);
  const runtimeRoot = path.dirname(resolvedOutputRoot);
  if (path.basename(resolvedOutputRoot) !== 'output' || path.basename(runtimeRoot) !== 'runtime') {
    throw unavailable(`RMBG outputRoot 不属于插件 runtime/output：${resolvedOutputRoot}`);
  }
  return resolvePluginManagedPython({ pluginRoot: path.dirname(runtimeRoot), platform });
}
