import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

async function runNpm(command, args, options) {
  return execFileAsync(command, args, {
    ...options,
    shell: process.platform === 'win32',
  });
}

export async function resolveNpmCacheDirectory({
  env = process.env,
  platform = process.platform,
  runCommand = runNpm,
} = {}) {
  const command = platform === 'win32' ? 'npm.cmd' : 'npm';
  const { stdout } = await runCommand(command, ['config', 'get', 'cache'], { env });
  const cacheDirectory = String(stdout).trim();
  const pathApi = platform === 'win32' ? path.win32 : path.posix;
  if (!pathApi.isAbsolute(cacheDirectory)) {
    throw new Error(`npm config get cache must return an absolute path, received: ${cacheDirectory || '<empty>'}`);
  }
  return cacheDirectory;
}
