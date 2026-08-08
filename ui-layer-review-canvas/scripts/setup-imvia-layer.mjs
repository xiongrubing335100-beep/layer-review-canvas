import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: repositoryRoot, stdio: 'inherit', shell: process.platform === 'win32' });
    child.once('error', reject);
    child.once('exit', (code) => code === 0
      ? resolve()
      : reject(new Error(`${command} ${args.join(' ')} 退出码 ${code}`)));
  });
}

const python = process.env.PYTHON || 'python';
try {
  await run(python, ['-m', 'pip', 'install', '-r', 'requirements-rmbg.txt']);
  await run(python, ['scripts/warm-rmbg.py']);
  await run(process.execPath, ['scripts/install-codex-plugin.mjs']);
} catch (error) {
  process.stderr.write(`Imvia Layer 初始化失败：${error.message}\n`);
  process.exitCode = 1;
}
