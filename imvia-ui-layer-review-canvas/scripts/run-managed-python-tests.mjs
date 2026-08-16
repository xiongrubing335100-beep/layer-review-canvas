import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCommand } from './python-runtime.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pluginRoot = path.join(os.homedir(), 'plugins', 'imvia-layer');
const runtime = JSON.parse(await readFile(path.join(pluginRoot, 'imvia-layer-runtime.json'), 'utf8'));
const result = await runCommand(runtime.python.command, [
  ...(Array.isArray(runtime.python.args) ? runtime.python.args : []),
  '-m',
  'unittest',
  'discover',
  '-s',
  'scripts',
  '-p',
  'test_*.py',
], { cwd: repositoryRoot });
if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
