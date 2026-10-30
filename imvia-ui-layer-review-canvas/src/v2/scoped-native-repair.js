import { createHash } from 'node:crypto';
import { readFile, writeFile, realpath, readdir, mkdir } from 'node:fs/promises';
import path from 'node:path';
import lockfile from 'proper-lockfile';
import { digestCanonicalJson } from '../poster-plan.js';
import { assertProcessingPolicy } from './processing-policy.js';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const json = async file => JSON.parse(await readFile(file,'utf8'));
const identity = ['attemptId','batchId','documentId','layerId','layerRevision','dispatchId','authorizationId','snapshotId','sourceFingerprint'];
const error = code => { throw new Error(`REPAIR_${code}`); };
export const scopedRepairRequestPath = manifest => {
  if(!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(manifest.envelope?.attemptId)) error('INVALID_ATTEMPT_ID');
  return path.join(manifest.outputRoot,'attempts',manifest.envelope.attemptId,'local-repair-request.json');
};
export async function withScopedAttemptLock(manifest,work) {
  // Same directory lock used by batch-store cancelAttempt/recordEvent.
  const directory=path.join(manifest.outputRoot,'batches');
  await mkdir(directory,{recursive:true});
  const release=await lockfile.lock(directory,{realpath:false,retries:{retries:20,minTimeout:5,maxTimeout:50}});
  try { return await work(); } finally { await release(); }
}
async function localFile(root,file) {
  const [base,target]=await Promise.all([realpath(root),realpath(file)]);
  if(!target.startsWith(base+path.sep)) error('PATH_ESCAPE');
  return target;
}
function eligible(manifest) {
  if(manifest.maskProvider!=='native_rgba' || manifest.route!=='reconstruct' || manifest.maximumImagegenCalls!==2
    || manifest.snapshot.strategy.fidelityPolicy!=='source_faithful_repair'
    || manifest.snapshot.strategy.localRepairPolicy!=='scoped_once_v1') error('BUDGET_NOT_AUTHORIZED');
}
async function active(manifest) {
  let state;
  try { state=await json(path.join(manifest.outputRoot,'attempts',manifest.envelope.attemptId+'.json')); }
  catch { error('ACTIVE_ATTEMPT_REQUIRED'); }
  if(state.execution!=='running' || identity.some(k=>state[k]!==manifest.envelope[k])) error('ATTEMPT_NOT_ACTIVE');
  for(const kind of ['candidates','failures']) {
    let names=[];
    try { names=await readdir(path.join(manifest.outputRoot,kind,manifest.envelope.attemptId)); }
    catch(e) { if(e.code!=='ENOENT') throw e; }
    if(names.some(name=>name.endsWith('.json'))) error('ATTEMPT_TERMINAL');
  }
}
export function validateRepairDefects(defects,bounds) {
  if(!Array.isArray(defects)||!defects.length||defects.length>16) error('DEFECTS_REQUIRED');
  let area=0;
  for(const d of defects) {
    if(!['false_hole','filled_gap','missing_edge','broken_line','edge_contamination'].includes(d.kind)
      || typeof d.evidence!=='string'||d.evidence.trim().length<12
      || ![d.x,d.y,d.width,d.height].every(Number.isSafeInteger)
      || d.x<0||d.y<0||d.width<1||d.height<1||d.x+d.width>bounds.width||d.y+d.height>bounds.height) error('INVALID_DEFECT_SCOPE');
    area+=d.width*d.height;
  }
  // Repair is local, not another full redraw. Overlaps count conservatively.
  if(area>bounds.width*bounds.height*.25) error('SCOPE_TOO_BROAD');
}
export async function prepareScopedNativeRepair({manifestPath,rawPath,reportPath}) {
  const manifest=await json(manifestPath); eligible(manifest); await assertProcessingPolicy(manifest);
  return withScopedAttemptLock(manifest,async()=>{
  const {rawPath:raw,report}=await inspectScopedNativeRepair({manifestPath,rawPath,reportPath});
  const record={version:1,callOrdinal:2,envelope:manifest.envelope,
    manifestSha256:hash(await readFile(manifestPath)),parentRawPath:raw,parentRawSha256:report.rawSha256,
    referencePath:manifest.referencePath,defects:report.defects,coordinateSpace:'selected_region_pixels',
    createdAt:new Date().toISOString()};
  const request={...record,requestSha256:digestCanonicalJson(record)};
  try { await writeFile(scopedRepairRequestPath(manifest),JSON.stringify(request,null,2)+'\n',{flag:'wx'}); }
  catch(e) { if(e.code==='EEXIST') error('ALREADY_RESERVED'); throw e; }
  return request;
  });
}
export async function inspectScopedNativeRepair({manifestPath,rawPath,reportPath}) {
  const manifest=await json(manifestPath); eligible(manifest); await assertProcessingPolicy(manifest);
  await active(manifest);
  const raw=await localFile(manifest.outputRoot,rawPath);
  const report=await json(await localFile(manifest.outputRoot,reportPath));
  if(identity.some(k=>report[k]!==manifest.envelope[k])||report.rawSha256!==hash(await readFile(raw))) error('PARENT_BINDING_MISMATCH');
  if(report.visualReview?.status!=='rejected') error('REJECTED_INSPECTION_REQUIRED');
  validateRepairDefects(report.defects,manifest.snapshot.bounds);
  return {manifest,rawPath:raw,report};
}
export async function validateScopedNativeRepair({manifestPath,rawPath,report}) {
  const manifest=await json(manifestPath);
  if(!report.scopedRepair) {
    let reserved=false;
    try { await readFile(scopedRepairRequestPath(manifest)); reserved=true; }
    catch(e) { if(e.code!=='ENOENT') throw e; }
    if(reserved) error('REPORT_REQUIRED');
    return null;
  }
  eligible(manifest); await active(manifest);
  const request=await json(scopedRepairRequestPath(manifest));
  const {requestSha256,...record}=request;
  if(requestSha256!==digestCanonicalJson(record)||report.scopedRepair.requestSha256!==requestSha256
    ||record.manifestSha256!==hash(await readFile(manifestPath))||identity.some(k=>record.envelope[k]!==manifest.envelope[k])) error('REQUEST_BINDING_MISMATCH');
  validateRepairDefects(record.defects,manifest.snapshot.bounds);
  const initial=await localFile(manifest.outputRoot,rawPath), repaired=await localFile(manifest.outputRoot,report.scopedRepair.rawPath);
  if(initial!==record.parentRawPath||hash(await readFile(initial))!==record.parentRawSha256) error('PARENT_BINDING_MISMATCH');
  const repairedSha256=hash(await readFile(repaired));
  if(report.scopedRepair.rawSha256!==repairedSha256) error('OUTPUT_BINDING_MISMATCH');
  return {version:1,requestSha256,parentRawSha256:record.parentRawSha256,rawPath:repaired,rawSha256:repairedSha256,defects:record.defects};
}
