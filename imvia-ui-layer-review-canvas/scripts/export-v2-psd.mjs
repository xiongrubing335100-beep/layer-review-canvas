import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { composeNormal } from '../src/v2/pixels.js';
import { encodePsd, inspectPsd } from '../src/v2/psd-codec.mjs';
import { validateExportPngBytes } from '../src/v2/export-store.js';
import { runCommand } from './python-runtime.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pixelScript = path.join(repositoryRoot, 'scripts', 'v2-region-pixels.py');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const contained = (root, target) => {
  const absoluteRoot = path.resolve(root); const absoluteTarget = path.resolve(target);
  if (!absoluteTarget.startsWith(`${absoluteRoot}${path.sep}`)) throw new Error('EXPORT_PATH_ESCAPES_ROOT');
  return absoluteTarget;
};

async function readPngInRoot(root, filename, layer, index, python, stagingDirectory) {
  const source = contained(root, filename);
  const info = await lstat(source);
  if (info.isSymbolicLink() || !info.isFile()) throw new Error('EXPORT_PNG_NOT_REGULAR_FILE');
  const [realRoot, realSource] = await Promise.all([realpath(root), realpath(source)]);
  if (!realSource.startsWith(`${realRoot}${path.sep}`)) throw new Error('EXPORT_PNG_SYMLINK_ESCAPE');
  const bytes = await readFile(source);
  const decoded = validateExportPngBytes(bytes, layer);
  const stagedPng = path.join(stagingDirectory, `candidate-${index}.png`);
  const rgbaPath = `${stagedPng}.rgba`;
  await writeFile(stagedPng, bytes, { flag: 'wx' });
  const result = await runCommand(python.command, [...python.args, pixelScript, '--decode-png', stagedPng,
    '--expected-width', String(layer.width), '--expected-height', String(layer.height), '--output', rgbaPath], { cwd: repositoryRoot });
  const audit = JSON.parse(result.stdout.trim());
  if (audit.width !== layer.width || audit.height !== layer.height || audit.channels !== 4 || audit.format !== 'RGBA') throw new Error('EXPORT_RGBA_DECODE_INVALID');
  const data = await readFile(rgbaPath);
  if (data.length !== layer.width * layer.height * 4) throw new Error('EXPORT_RGBA_BYTE_COUNT_MISMATCH');
  return { name: layer.name, blendMode: layer.blendMode, image: { width: layer.width, height: layer.height, data: new Uint8ClampedArray(data) },
    placement: layer.placement };
}

async function main() {
  const snapshotPath = process.argv[process.argv.indexOf('--snapshot') + 1];
  const output = process.argv[process.argv.indexOf('--output') + 1];
  const memoryArgumentIndex = process.argv.indexOf('--available-memory');
  const availableMemory = memoryArgumentIndex >= 0 ? Number(process.argv[memoryArgumentIndex + 1]) : undefined;
  if (availableMemory !== undefined && (!Number.isFinite(availableMemory) || availableMemory <= 0)) throw new Error('INVALID_MEMORY_BUDGET');
  if (!snapshotPath || !output) throw new Error('SNAPSHOT_AND_OUTPUT_REQUIRED');
  const snapshot = JSON.parse(await readFile(snapshotPath, 'utf8'));
  if (snapshot.schemaVersion !== 1 || snapshot.background !== 'transparent' || !snapshot.layers?.length) throw new Error('INVALID_EXPORT_SNAPSHOT');
  const root = path.resolve(snapshot.outputRoot);
  const candidates = snapshot.layers;
  for (const layer of candidates) {
    if (!layer.pngPath || !/^[a-f0-9]{64}$/iu.test(layer.sha256 || '') || layer.blendMode !== 'normal') throw new Error('INVALID_EXPORT_LAYER');
  }
  const runtimePath = path.join(os.homedir(), 'plugins', 'imvia-layer', 'imvia-layer-runtime.json');
  const runtime = JSON.parse(await readFile(runtimePath, 'utf8'));
  if (!runtime.python?.command || !Array.isArray(runtime.python.args)) throw new Error('MANAGED_PYTHON_RUNTIME_MISSING');
  await mkdir(path.dirname(output), { recursive: true });
  const layers = [];
  for (let index = 0; index < candidates.length; index += 1) layers.push(await readPngInRoot(root, candidates[index].pngPath, candidates[index], index, runtime.python, path.dirname(output)));
  const composite = composeNormal({ width: snapshot.width, height: snapshot.height, layers });
  const bytes = encodePsd({ width: snapshot.width, height: snapshot.height, layers, composite, availableMemory });
  const inspected = inspectPsd(bytes, availableMemory === undefined ? undefined : { availableMemory });
  if (inspected.width !== snapshot.width || inspected.height !== snapshot.height || inspected.layers.length !== layers.length) throw new Error('PSD_READBACK_MISMATCH');
  for (let index = 0; index < layers.length; index += 1) {
    const expected = layers[index]; const actual = inspected.layers[index];
    if (actual.name !== expected.name || actual.placement.x !== expected.placement.x || actual.placement.y !== expected.placement.y
      || actual.image.width !== expected.image.width || actual.image.height !== expected.image.height
      || !Buffer.from(actual.image.data).equals(Buffer.from(expected.image.data))) throw new Error('PSD_LAYER_READBACK_MISMATCH');
  }
  if (!Buffer.from(inspected.composite.data).equals(Buffer.from(composite.data))) throw new Error('PSD_COMPOSITE_READBACK_MISMATCH');
  await writeFile(output, bytes, { flag: 'wx' });
  process.stdout.write(JSON.stringify({ exportId: snapshot.exportId, documentId: snapshot.documentId,
    documentRevision: snapshot.documentRevision, width: snapshot.width, height: snapshot.height,
    layerCount: layers.length, sha256: digest(bytes), bytes: bytes.length, background: 'transparent' }));
}

main().catch(error => { process.stderr.write(`${error.code || 'PSD_EXPORT_FAILED'}: ${error.message}\n`); process.exitCode = 1; });
