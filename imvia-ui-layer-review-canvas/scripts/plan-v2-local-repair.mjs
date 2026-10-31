import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectScopedNativeRepair } from '../src/v2/scoped-native-repair.js';
import { runCommand } from './python-runtime.mjs';

const [manifestPath, rawPath, reportPath] = process.argv.slice(2);
try {
  const before = await inspectScopedNativeRepair({manifestPath, rawPath, reportPath});
  const {python} = JSON.parse(await readFile(path.join(os.homedir(),
    'plugins/imvia-layer/imvia-layer-runtime.json')));
  const result = await runCommand(python.command, [...python.args,
    fileURLToPath(new URL('./repair-scope-planning.py', import.meta.url)),
    '--manifest', manifestPath, '--raw', rawPath, '--report', reportPath]);
  // Cancellation and policy changes while rendering invalidate this plan too.
  const current = await inspectScopedNativeRepair({manifestPath, rawPath, reportPath});
  if (JSON.stringify(current) !== JSON.stringify(before)) throw new Error('REPAIR_PLANNING_INPUTS_CHANGED');
  console.log(JSON.stringify({...JSON.parse(result.stdout),
    envelope:current.manifest.envelope, rawSha256:current.report.rawSha256}));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
