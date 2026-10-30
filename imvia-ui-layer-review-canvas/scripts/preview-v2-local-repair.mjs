import { readFile, writeFile, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateScopedNativeRepair } from '../src/v2/scoped-native-repair.js';
import { assertProcessingPolicy } from '../src/v2/processing-policy.js';
import { runCommand } from './python-runtime.mjs';
const [manifestPath,rawPath,reportPath]=process.argv.slice(2);
const folder=path.dirname(path.resolve(manifestPath));
const temporary=path.join(folder,`.repair-preview-${randomUUID()}.json`);
try {
  const manifest=JSON.parse(await readFile(manifestPath)); await assertProcessingPolicy(manifest);
  const report=JSON.parse(await readFile(reportPath));
  const scopedNativeRepair=await validateScopedNativeRepair({manifestPath,rawPath,report});
  if(!scopedNativeRepair) throw new Error('REPAIR_REPORT_REQUIRED');
  await writeFile(temporary,JSON.stringify({...manifest,scopedNativeRepair}),{flag:'wx'});
  const {python}=JSON.parse(await readFile(path.join(os.homedir(),'plugins/imvia-layer/imvia-layer-runtime.json')));
  const result=await runCommand(python.command,[...python.args,fileURLToPath(new URL('./preview-native-rgba.py',import.meta.url)),
    '--manifest',temporary,'--raw',rawPath,'--output-dir',path.join(folder,'repair-preview')]);
  console.log(result.stdout.trim());
} finally { await rm(temporary,{force:true}); }
