// Imvia Layer © 2026 青木. Personal non-commercial use is free; commercial use requires a paid license. See LICENSE and NOTICE.md.
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ensurePersistentPythonRuntime } from './python-runtime.mjs';

const pluginRoot = path.join(os.homedir(), 'plugins', 'imvia-layer');
const runtimeConfig = JSON.parse(await readFile(path.join(pluginRoot, 'imvia-layer-runtime.json'), 'utf8'));
if (!runtimeConfig.workbenchRoot) throw new Error('installed runtime JSON is missing workbenchRoot');

const verified = await ensurePersistentPythonRuntime({
  repositoryRoot: runtimeConfig.workbenchRoot,
  pluginRoot,
});
if (runtimeConfig.python?.command !== verified.command) {
  throw new Error(`installed runtime command mismatch: ${runtimeConfig.python?.command || '<missing>'}`);
}
process.stdout.write(`managed runtime verified: Python ${verified.version}, lock ${verified.lockSha256}\n`);
