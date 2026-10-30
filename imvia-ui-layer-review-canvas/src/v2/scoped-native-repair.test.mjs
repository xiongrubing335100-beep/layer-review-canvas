import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, copyFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { currentProcessingPolicy } from './processing-policy.js';

async function api() {
  const module = await import('./scoped-native-repair.js').catch(() => ({}));
  assert.equal(typeof module.prepareScopedNativeRepair,'function','scoped repair reservation must exist');
  return module;
}
async function fixture(t) {
  const root=await mkdtemp(path.join(os.tmpdir(),'scoped-repair-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const dir=path.join(root,'attempts','a'); await mkdir(dir,{recursive:true});
  const rawPath=path.join(dir,'raw.png'); await writeFile(rawPath,'initial bytes');
  const rawSha256=createHash('sha256').update('initial bytes').digest('hex');
  const envelope={attemptId:'a',batchId:'b',documentId:'d',layerId:'l',layerRevision:1,dispatchId:'dispatch',authorizationId:'auth',snapshotId:'snapshot',sourceFingerprint:'source'};
  const manifest={schemaVersion:2,route:'reconstruct',maskProvider:'native_rgba',maximumImagegenCalls:2,
    nativeRgbaRequirements:{version:3},outputRoot:root,envelope,
    snapshot:{bounds:{x:200,y:300,width:100,height:80},strategy:{fidelityPolicy:'source_faithful_repair',localRepairPolicy:'scoped_once_v1'}},
    referencePath:path.join(dir,'standard-reference.png'),processingPolicy:await currentProcessingPolicy()};
  const report={...envelope,rawSha256,visualReview:{status:'rejected'},defects:[{kind:'false_hole',x:10,y:20,width:8,height:9,evidence:'Source shows continuous solid gold bevel here.'}]};
  const manifestPath=path.join(dir,'manifest.json'),reportPath=path.join(dir,'rejected.json');
  await writeFile(manifestPath,JSON.stringify(manifest)); await writeFile(reportPath,JSON.stringify(report));
  await writeFile(path.join(root,'attempts','a.json'),JSON.stringify({...envelope,execution:'running'}));
  return {root,dir,manifest,manifestPath,report,reportPath,rawPath};
}
test('reserves exactly one second call and keeps source-local defect bounds',async t=>{
  const {prepareScopedNativeRepair}=await api(), f=await fixture(t);
  const request=await prepareScopedNativeRepair(f);
  assert.equal(request.callOrdinal,2); assert.equal(request.parentRawSha256,f.report.rawSha256);
  assert.deepEqual(request.defects,f.report.defects);
  await assert.rejects(prepareScopedNativeRepair(f),/REPAIR_ALREADY_RESERVED/);
});
test('planning validates live inputs without consuming the second call',async t=>{
  const {inspectScopedNativeRepair,prepareScopedNativeRepair}=await api(), f=await fixture(t);
  const original=await readFile(f.reportPath,'utf8');
  const inspection=await inspectScopedNativeRepair(f);
  assert.deepEqual(inspection.report.defects,f.report.defects);
  assert.equal(await readFile(f.reportPath,'utf8'),original);
  await assert.rejects(readFile(path.join(f.dir,'local-repair-request.json')),/ENOENT/);
  assert.equal((await prepareScopedNativeRepair(f)).callOrdinal,2);
});
test('planning rejects cancelled and mismatched inputs before image processing',async t=>{
  const {inspectScopedNativeRepair}=await api();
  const f=await fixture(t);
  await writeFile(f.rawPath,'different bytes');
  await assert.rejects(inspectScopedNativeRepair(f),/PARENT_BINDING_MISMATCH/);
  await writeFile(path.join(f.root,'attempts','a.json'),JSON.stringify({...f.manifest.envelope,execution:'cancelled'}));
  await assert.rejects(inspectScopedNativeRepair(f),/ATTEMPT_NOT_ACTIVE/);
});
test('planning CLI renders the bound source without reserving or changing task files',async t=>{
  const f=await fixture(t);
  const {execFile}=await import('node:child_process');
  const {promisify}=await import('node:util');
  const {fileURLToPath}=await import('node:url');
  const crop=path.join(f.dir,'source.png');
  const {python}=JSON.parse(await readFile(path.join(os.homedir(),'plugins/imvia-layer/imvia-layer-runtime.json')));
  await promisify(execFile)(python.command,[...python.args,'-c',
    'from PIL import Image,ImageDraw; import sys; raw=Image.new("RGBA",(100,80),(0,0,0,0)); ImageDraw.Draw(raw).rectangle((20,20,79,59),fill=(255,255,255,255)); raw.save(sys.argv[1]); raw.putalpha(255); raw.save(sys.argv[2])',
    f.rawPath,crop]);
  Object.assign(f.manifest,{selectedCropPath:crop,rawCoordinateSpace:'selected_region',removeBackground:true});
  f.report.rawSha256=createHash('sha256').update(await readFile(f.rawPath)).digest('hex');
  await writeFile(f.manifestPath,JSON.stringify(f.manifest));
  await writeFile(f.reportPath,JSON.stringify(f.report));
  const {stdout}=await promisify(execFile)(process.execPath,[
    fileURLToPath(new URL('../../scripts/plan-v2-local-repair.mjs',import.meta.url)),
    f.manifestPath,f.rawPath,f.reportPath],{timeout:60000});
  const result=JSON.parse(stdout);
  assert.equal(result.rawSha256,f.report.rawSha256);
  assert.deepEqual(result.envelope,f.manifest.envelope);
  assert.deepEqual(result.suggestedRegions,[]);
  assert.equal(result.requiresSourceInspection,true);
  assert.deepEqual(JSON.parse(await readFile(f.reportPath)),f.report);
  assert.equal(JSON.parse(await readFile(path.join(f.root,'attempts','a.json'))).execution,'running');
  await assert.rejects(readFile(path.join(f.dir,'local-repair-request.json')),/ENOENT/);
});
test('legacy budget, cancelled attempt, altered parent and broad scopes never reserve repair',async t=>{
  const {prepareScopedNativeRepair}=await api();
  for (const scenario of ['legacy','cancelled','parent','scope','passed']) {
    const f=await fixture(t);
    if(scenario==='legacy') f.manifest.maximumImagegenCalls=1;
    if(scenario==='cancelled') await writeFile(path.join(f.root,'attempts','a.json'),JSON.stringify({...f.manifest.envelope,execution:'cancelled'}));
    if(scenario==='parent') f.report.rawSha256='a'.repeat(64);
    if(scenario==='scope') f.report.defects[0]={...f.report.defects[0],width:100,height:80,x:0,y:0};
    if(scenario==='passed') f.report.visualReview.status='passed';
    await writeFile(f.manifestPath,JSON.stringify(f.manifest)); await writeFile(f.reportPath,JSON.stringify(f.report));
    await assert.rejects(prepareScopedNativeRepair(f),/REPAIR_/);
    await assert.rejects(readFile(path.join(f.dir,'local-repair-request.json')),/ENOENT/);
  }
});
test('reserved repair cannot be omitted, swapped or finalized after cancellation',async t=>{
  const {prepareScopedNativeRepair,validateScopedNativeRepair}=await api(), f=await fixture(t);
  const request=await prepareScopedNativeRepair(f);
  await assert.rejects(validateScopedNativeRepair({...f,report:f.report}),/REPAIR_REPORT_REQUIRED/);
  const repairPath=path.join(f.dir,'repair.png'); await writeFile(repairPath,'repaired bytes');
  const report={...f.report,scopedRepair:{requestSha256:request.requestSha256,rawPath:repairPath,
    rawSha256:createHash('sha256').update('repaired bytes').digest('hex')}};
  assert.equal((await validateScopedNativeRepair({...f,report})).parentRawSha256,f.report.rawSha256);
  await writeFile(repairPath,'changed');
  await assert.rejects(validateScopedNativeRepair({...f,report}),/OUTPUT_BINDING/);
  await writeFile(repairPath,'repaired bytes');
  await writeFile(path.join(f.root,'attempts','a.json'),JSON.stringify({...f.manifest.envelope,execution:'cancelled'}));
  await assert.rejects(validateScopedNativeRepair({...f,report}),/ATTEMPT_NOT_ACTIVE/);
});
test('finalized failure cannot reserve repair while its event acknowledgement is pending',async t=>{
  const {prepareScopedNativeRepair}=await api(), f=await fixture(t);
  const dir=path.join(f.root,'failures','a'); await mkdir(dir,{recursive:true});
  await writeFile(path.join(dir,'failure.json'),'{}');
  await assert.rejects(prepareScopedNativeRepair(f),/REPAIR_ATTEMPT_TERMINAL/);
});
test('copying a manifest cannot reserve a third call or omit an existing repair',async t=>{
  const {prepareScopedNativeRepair,validateScopedNativeRepair}=await api(), f=await fixture(t);
  await prepareScopedNativeRepair(f);
  const alternate=path.join(f.root,'alternate'); await mkdir(alternate);
  const manifestPath=path.join(alternate,'manifest.json'); await copyFile(f.manifestPath,manifestPath);
  await assert.rejects(prepareScopedNativeRepair({...f,manifestPath}),/REPAIR_ALREADY_RESERVED/);
  await assert.rejects(validateScopedNativeRepair({...f,manifestPath,report:f.report}),/REPAIR_REPORT_REQUIRED/);
});
test('publication lock serializes with the batch cancellation lock',async t=>{
  const apiModule=await api(), f=await fixture(t);
  assert.equal(typeof apiModule.withScopedAttemptLock,'function');
  const {default:lockfile}=await import('proper-lockfile');
  const dir=path.join(f.root,'batches'); await mkdir(dir,{recursive:true});
  const release=await lockfile.lock(dir,{realpath:false});
  let entered=false;
  const pending=apiModule.withScopedAttemptLock(f.manifest,async()=>{entered=true;});
  await new Promise(resolve=>setTimeout(resolve,30));
  assert.equal(entered,false);
  await release(); await pending; assert.equal(entered,true);
});
