import { spawn } from 'node:child_process';
import path from 'node:path';

function runProcess(command, args, options) {
  return new Promise((resolve, reject) => {
    const { onOutput, ...spawnOptions } = options;
    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      ...spawnOptions,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8'); onOutput?.(chunk.toString('utf8')); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); onOutput?.(chunk.toString('utf8')); });
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${command} ${args.join(' ')} exited ${code}: ${stderr || stdout}`));
    });
  });
}

export function runNpmCommand(args, {
  cwd,
  env = process.env,
  platform = process.platform,
  runCommand = runProcess,
  onOutput,
} = {}) {
  const command = platform === 'win32' ? 'npm.cmd' : 'npm';
  return runCommand(command, args, {
    ...(cwd !== undefined ? { cwd } : {}),
    env,
    shell: platform === 'win32',
    ...(onOutput ? { onOutput } : {}),
  });
}

export async function resolveNpmCacheDirectory({
  env = process.env,
  platform = process.platform,
  runCommand = runProcess,
} = {}) {
  const { stdout } = await runNpmCommand(['config', 'get', 'cache'], {
    env,
    platform,
    runCommand,
  });
  const cacheDirectory = String(stdout).trim();
  const pathApi = platform === 'win32' ? path.win32 : path.posix;
  if (!pathApi.isAbsolute(cacheDirectory)) {
    throw new Error(`npm config get cache must return an absolute path, received: ${cacheDirectory || '<empty>'}`);
  }
  return cacheDirectory;
}
