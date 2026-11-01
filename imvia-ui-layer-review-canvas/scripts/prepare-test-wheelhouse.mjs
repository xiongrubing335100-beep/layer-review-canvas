import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCommand } from './python-runtime.mjs';

if (!process.env.RUNNER_TEMP || !process.env.GITHUB_ENV || !process.env.PYTHON) {
  throw new Error('CI wheelhouse requires RUNNER_TEMP, GITHUB_ENV, and verified PYTHON');
}
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const wheelhouse = path.join(process.env.RUNNER_TEMP, 'imvia-locked-test-wheels');
await mkdir(wheelhouse, { recursive: true });
await runCommand(process.env.PYTHON, ['-m', 'pip', 'download', '--only-binary=:all:', '--require-hashes',
  '-r', path.join(root, 'requirements-rmbg.lock'), '--dest', wheelhouse], { cwd: root, stdio: 'inherit' });
await appendFile(process.env.GITHUB_ENV, `IMVIA_TEST_WHEELHOUSE=${wheelhouse}\n`);
