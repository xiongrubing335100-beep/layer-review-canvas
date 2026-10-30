import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const files = ['../../scripts/source-guided-matte.py', '../../scripts/v2-region-pixels.py', '../../scripts/semantic-matte.py',
  '../../scripts/matte-registration.py', '../../scripts/matte-correspondence.py', '../../scripts/inspect-v2-matte.py',
  './execution-adapter.js', './native-rgba-review.js', '../../scripts/native-rgba-registration.py',
  './scoped-native-repair.js', '../../scripts/scoped-native-repair.py', '../../scripts/native-local-registration.py',
  '../../scripts/component-rgba-registration.py', '../../scripts/component-rgba-sampling.py',
  '../../scripts/repair-scope-planning.py', '../../scripts/plan-v2-local-repair.mjs'];
const contract = new URL('../../plugin-template/imvia-layer/skills/imvia-layer-batch-v2/references/item-contract.md', import.meta.url);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

// Capture the code/contract actually loaded by this checkout, not a release label.
export async function currentProcessingPolicy() {
  const [processors, itemContract] = await Promise.all([
    Promise.all(files.map(file => readFile(new URL(file, import.meta.url)))), readFile(contract),
  ]);
  return { version: 7, processorSha256: digest(JSON.stringify(processors.map(digest))),
    itemContractPath: fileURLToPath(contract), itemContractSha256: digest(itemContract) };
}

export async function assertProcessingPolicy(manifest) {
  const current = await currentProcessingPolicy();
  // Historical manifests remain readable without rewriting their frozen record.
  if (manifest.processingPolicy && ['version', 'processorSha256', 'itemContractSha256'].some(key => manifest.processingPolicy[key] !== current[key])) {
    throw Object.assign(new Error('PROCESSING_POLICY_CHANGED: the prepared processor/contract changed; keep the original attempt evidence'),
      { code: 'PROCESSING_POLICY_CHANGED', stage: 'preflight' });
  }
  return current;
}
