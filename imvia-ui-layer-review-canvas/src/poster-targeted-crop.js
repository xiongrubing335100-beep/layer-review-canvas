import { spawn } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import { access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_PATH = fileURLToPath(new URL('../scripts/prepare-poster-targeted-crop.py', import.meta.url));

function integer(value, label, { allowZero = false } = {}) {
  if (!Number.isInteger(value) || value < (allowZero ? 0 : 1)) throw new TypeError(`${label} is invalid`);
  return value;
}

async function configuredPython(environment = process.env) {
  if (environment.IMVIA_LAYER_PYTHON_COMMAND || environment.PYTHON) {
    let args = [];
    try {
      const parsed = JSON.parse(environment.IMVIA_LAYER_PYTHON_ARGS || '[]');
      if (Array.isArray(parsed) && parsed.every((entry) => typeof entry === 'string')) args = parsed;
    } catch {
      args = [];
    }
    return { command: environment.IMVIA_LAYER_PYTHON_COMMAND || environment.PYTHON, args };
  }
  const pluginRoot = path.resolve(path.dirname(SCRIPT_PATH), '..', '..');
  const localPython = process.platform === 'win32'
    ? path.join(pluginRoot, '.python-runtime', 'Scripts', 'python.exe')
    : path.join(pluginRoot, '.python-runtime', 'bin', 'python3');
  try {
    await access(localPython, fsConstants.X_OK);
    return { command: localPython, args: [] };
  } catch {
    return { command: process.platform === 'win32' ? 'python' : 'python3', args: [] };
  }
}

function runJson(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code !== 0) return reject(new Error(stderr.trim() || `poster crop exited with code ${code}`));
      try { resolve(JSON.parse(stdout.trim())); } catch { reject(new Error('poster crop did not return JSON')); }
    });
  });
}

export async function preparePosterTargetedCrop({ sourcePath, outputPath, bounds, environment } = {}) {
  if (typeof sourcePath !== 'string' || !sourcePath || typeof outputPath !== 'string' || !outputPath) {
    throw new TypeError('sourcePath and outputPath are required');
  }
  const x = integer(bounds?.x, 'bounds.x', { allowZero: true });
  const y = integer(bounds?.y, 'bounds.y', { allowZero: true });
  const width = integer(bounds?.width, 'bounds.width');
  const height = integer(bounds?.height, 'bounds.height');
  const python = await configuredPython(environment);
  return runJson(python.command, [
    ...python.args, SCRIPT_PATH,
    '--source', sourcePath,
    '--output', outputPath,
    '--x', String(x), '--y', String(y), '--width', String(width), '--height', String(height),
  ]);
}
