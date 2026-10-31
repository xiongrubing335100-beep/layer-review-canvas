// Imvia Layer © 2026 青木. Personal non-commercial use is free; commercial use requires a paid license. See LICENSE and NOTICE.md.
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { verifyInstalledNodeRuntime } from './node-runtime.mjs';
import { verifyInstalledPythonRuntime } from './python-runtime.mjs';

const pluginRoot = path.join(os.homedir(), 'plugins', 'imvia-layer');
const runtimeConfig = JSON.parse(await readFile(path.join(pluginRoot, 'imvia-layer-runtime.json'), 'utf8'));
if (!runtimeConfig.workbenchRoot) throw new Error('installed runtime JSON is missing workbenchRoot');

const python = await verifyInstalledPythonRuntime({
  repositoryRoot: runtimeConfig.workbenchRoot,
  pluginRoot,
});
if (runtimeConfig.python?.command !== python.command) {
  throw new Error(`installed runtime command mismatch: ${runtimeConfig.python?.command || '<missing>'}`);
}
const node = await verifyInstalledNodeRuntime({ pluginRoot });
const mcpConfig = JSON.parse(await readFile(path.join(pluginRoot, '.mcp.json'), 'utf8')).mcpServers?.['imvia-layer'];
if (mcpConfig?.command !== node.command) {
  throw new Error(`installed Node command mismatch: ${mcpConfig?.command || '<missing>'}`);
}

const hash = (contents) => createHash('sha256').update(contents).digest('hex');
const templateRoot = path.join(runtimeConfig.workbenchRoot, 'plugin-template', 'imvia-layer');
for (const relativePath of [
  'LICENSE', 'NOTICE.md', path.join('.codex-plugin', 'plugin.json'),
  'skills/imvia-layer-batch-v2/SKILL.md',
  'skills/imvia-layer-batch-v2/references/item-contract.md',
]) {
  const templateHash = hash(await readFile(path.join(templateRoot, relativePath)));
  const installedHash = hash(await readFile(path.join(pluginRoot, relativePath)));
  if (installedHash !== templateHash) throw new Error(`installed ${relativePath} hash does not match the plugin template`);
}
const canonicalLicenseHash = hash(await readFile(path.resolve(runtimeConfig.workbenchRoot, '..', 'LICENSE')));
const installedLicenseHash = hash(await readFile(path.join(pluginRoot, 'LICENSE')));
if (installedLicenseHash !== canonicalLicenseHash) {
  throw new Error('installed plugin LICENSE hash does not match the canonical repository LICENSE');
}
const nodeMarker = JSON.parse(await readFile(path.join(pluginRoot, '.node-runtime', '.imvia-layer-node.json'), 'utf8'));
const nodeLicenseHash = hash(await readFile(path.join(pluginRoot, '.node-runtime', 'LICENSE')));
if (nodeLicenseHash !== nodeMarker.licenseSha256) throw new Error('installed Node LICENSE hash does not match its marker');

process.stdout.write(
  `managed runtime verified: Python ${python.version}, Node ${node.nodeVersion}, lock ${python.lockSha256}, license/template hashes match\n`,
);
