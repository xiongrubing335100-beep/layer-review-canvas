import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, cp, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';

test('a changed registration implementation invalidates a frozen processor binding', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'imvia-policy-'));
  t.after(() => rm(root, { recursive:true, force:true }));
  const contract = 'plugin-template/imvia-layer/skills/imvia-layer-batch-v2/references';
  for (const dir of ['src/v2','scripts',contract]) await mkdir(path.join(root,dir), {recursive:true});
  await cp(new URL('./processing-policy.js',import.meta.url), path.join(root,'src/v2/processing-policy.mjs'));
  await writeFile(path.join(root,contract,'item-contract.md'),'fixture contract');
  for (const file of ['source-guided-matte.py','v2-region-pixels.py','semantic-matte.py','matte-registration.py','matte-correspondence.py','inspect-v2-matte.py','native-rgba-registration.py','scoped-native-repair.py','native-local-registration.py',
    'component-rgba-registration.py','component-rgba-sampling.py','repair-scope-planning.py','plan-v2-local-repair.mjs'])
    await writeFile(path.join(root,'scripts',file), '# fixture processor');
  for (const file of ['execution-adapter.js','native-rgba-review.js','scoped-native-repair.js']) await writeFile(path.join(root,'src/v2',file), '// fixture');
  const policy = await import(pathToFileURL(path.join(root,'src/v2/processing-policy.mjs')).href);
  const before = await policy.currentProcessingPolicy();
  await writeFile(path.join(root,'scripts/matte-registration.py'),'# changed alignment behavior');
  await assert.rejects(policy.assertProcessingPolicy({processingPolicy:before}), {code:'PROCESSING_POLICY_CHANGED'});
  const next = await policy.currentProcessingPolicy();
  await writeFile(path.join(root,'scripts/inspect-v2-matte.py'),'# changed coordinate inspection');
  await assert.rejects(policy.assertProcessingPolicy({processingPolicy:next}), {code:'PROCESSING_POLICY_CHANGED'});
  const joint = await policy.currentProcessingPolicy();
  await writeFile(path.join(root,'scripts/matte-correspondence.py'),'# changed joint source matching');
  await assert.rejects(policy.assertProcessingPolicy({processingPolicy:joint}), {code:'PROCESSING_POLICY_CHANGED'});
  for (const file of ['component-rgba-registration.py','component-rgba-sampling.py','repair-scope-planning.py','plan-v2-local-repair.mjs']) {
    const frozen = await policy.currentProcessingPolicy();
    await writeFile(path.join(root,'scripts',file),'# changed component coordinates or shared RGBA sampling');
    await assert.rejects(policy.assertProcessingPolicy({processingPolicy:frozen}), {code:'PROCESSING_POLICY_CHANGED'});
  }
});
