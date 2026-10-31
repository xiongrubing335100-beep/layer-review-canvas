// Explicitly invoked acceptance harness. Never submits a bridge message or
// mutates a production document. Real model artifacts are supplied by the caller.
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import { createServer } from 'node:http';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createDocument, addLayer } from '../src/v2/document.js';
import { createBatch, applyAttemptEvent } from '../src/v2/batch.js';
import { prepareV2Item } from '../src/v2/execution-adapter.js';
import { assertProcessingPolicy } from '../src/v2/processing-policy.js';
import { createWorkbenchV2Api, workbenchV2Middleware } from '../src/v2/api.mjs';
import { inspectPsd } from '../src/v2/psd-codec.mjs';
import { readPosterPngBytes } from '../src/poster-png.js';

const id = () => randomUUID().replaceAll('-', '');
const hash = b => createHash('sha256').update(b).digest('hex');
const json = p => readFile(p, 'utf8').then(JSON.parse);
const save = (p, v) => writeFile(p, JSON.stringify(v, null, 2)+'\n', {flag:'wx'});
const [mode, input, destination] = process.argv.slice(2);
if (['prepare', 'prepare-native', 'prepare-default'].includes(mode)) {
  const original = await json(input), root = path.resolve(destination);
  const documentId = id(), directory = path.join(root, 'documents', documentId);
  await mkdir(directory, {recursive:true});
  const source = await readFile(original.source.path);
  assert.equal(hash(source), original.source.fingerprint);
  const sourcePath = path.join(directory, 'source.png');
  await writeFile(sourcePath, source, {flag:'wx'});
  let document = createDocument({documentId, workbenchSessionId:id(), mode:original.mode,
    source:{...original.source, path:sourcePath}});
  for (const layerId of original.layerOrder) {
    const {layerRevision, acceptedVersionId, acceptedQualityReview, ...definition} = original.layers[layerId];
    if (mode === 'prepare-native') definition.strategy = { ...definition.strategy, fidelityPolicy: 'source_faithful_repair' };
    if (mode === 'prepare-default') delete definition.strategy;
    document = addLayer(document, {...definition, layerId:id()});
  }
  await save(path.join(directory, 'document.json'), document);
  const batch = createBatch({document, submissionKey:id()});
  await save(path.join(root, 'acceptance.json'), {origin:'explicit_user_requested_real_acceptance',
    bridgeDeliveryTest:false, originalDocumentId:original.documentId, originalDocumentSha256:hash(await readFile(input)),
    document, batch, purpose:'Independent real split and PNG/PSD readback; no production retry or synthetic provider output.'});
  for (const {snapshot,attempt} of batch.items) {
    const manifest = await prepareV2Item({document,snapshot,attempt,outputRoot:root});
    await assertProcessingPolicy(manifest);
    console.log(JSON.stringify({attemptId:attempt.attemptId,layer:document.layers[attempt.layerId].name,
      manifestPath:path.join(root,'attempts',attempt.attemptId,'manifest.json'),referencePath:manifest.referencePath}));
  }
} else if (mode === 'start') {
  const root = path.resolve(input), acceptance = await json(path.join(root,'acceptance.json'));
  assert.equal(acceptance.origin, 'explicit_user_requested_real_acceptance');
  assert.equal(acceptance.bridgeDeliveryTest, false);
  for (const {attempt} of acceptance.batch.items) {
    const state = applyAttemptEvent(attempt, {eventId:id(), attemptId:attempt.attemptId,
      dispatchId:attempt.dispatchId, type:'running'});
    await save(path.join(root,'attempts',attempt.attemptId+'.json'), state);
  }
  console.log('Isolated acceptance attempts started; no bridge message submitted.');
} else if (mode === 'check') {
  const root = path.resolve(input), {document,batch} = await json(path.join(root,'acceptance.json'));
  const audits = new Map();
  for (const {attempt} of batch.items) {
    const directory = path.join(root,'candidates',attempt.attemptId);
    const records = (await readdir(directory)).filter(n=>n.endsWith('.json'));
    assert.equal(records.length,1,'exactly one finalization per acceptance item');
    const candidate = await json(path.join(directory,records[0]));
    audits.set(candidate.layerId, candidate.pixelAudit);
    const statePath = path.join(root,'attempts',attempt.attemptId+'.json');
    let previous;
    try { previous = await json(statePath); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (previous) {
      for (const key of ['attemptId','dispatchId','documentId','layerId','snapshotId','authorizationId'])
        assert.equal(previous[key], attempt[key]);
      assert.equal(previous.execution, 'running');
    }
    const state = applyAttemptEvent(previous || attempt,{eventId:id(),attemptId:attempt.attemptId,dispatchId:attempt.dispatchId,
      type:'suggested',payload:{versionId:candidate.versionId}});
    if (previous) await writeFile(statePath, JSON.stringify(state,null,2)+'\n');
    else await save(statePath,state);
  }
  const api = createWorkbenchV2Api({root:path.join(root,'documents')});
  const composition = await api.getComposition(document.documentId);
  assert.equal(composition.layers.length,document.layerOrder.length,JSON.stringify(composition.states));
  const sourceBytes = await readFile(document.source.path);
  assert.equal(hash(sourceBytes), document.source.fingerprint, 'frozen original source must not change');
  const source = readPosterPngBytes(sourceBytes);
  const pngs = [];
  for (const layerId of document.layerOrder) {
    const versions = await api.listLayerVersions({documentId:document.documentId,layerId});
    assert.equal(versions.state.status,'ready');
    const versionId = versions.state.resultVersionId;
    const bytes = await api.readCandidatePng({documentId:document.documentId,layerId,versionId});
    const decoded = readPosterPngBytes(bytes);
    const layer = document.layers[layerId];
    assert.deepEqual([decoded.width,decoded.height],[layer.bounds.width,layer.bounds.height]);
    let opaquePixels = 0, foregroundPixels = 0, unchangedForegroundRgbPixels = 0;
    for (let y=0;y<decoded.height;y++) for(let x=0;x<decoded.width;x++) {
      const p=(y*decoded.width+x)*4;
      const q=((y+layer.bounds.y)*source.width+x+layer.bounds.x)*4;
      if (decoded.pixels[p+3]>=128) {
        foregroundPixels++;
        if (decoded.pixels[p]===source.pixels[q] && decoded.pixels[p+1]===source.pixels[q+1]
          && decoded.pixels[p+2]===source.pixels[q+2]) unchangedForegroundRgbPixels++;
      }
      if (decoded.pixels[p+3]!==255) continue;
      if (layer.strategy.fidelityPolicy !== 'source_faithful_repair') assert.ok(decoded.pixels[p]===source.pixels[q]
        && decoded.pixels[p+1]===source.pixels[q+1]
        && decoded.pixels[p+2]===source.pixels[q+2], 'opaque RGB must remain at its exact source coordinate');
      opaquePixels++;
    }
    if (layer.strategy.fidelityPolicy !== 'source_faithful_repair') assert.ok(opaquePixels>0,'real material result must contain opaque source pixels');
    else assert.ok(decoded.pixels.some((value, index) => index % 4 === 3 && value > 200), 'native result must contain substantive foreground');
    const local = audits.get(layerId)?.localRepair;
    if (local?.version === 3) {
      assert.equal(local.outsideRepairRgbIdentical, true);
      assert.equal(foregroundPixels,local.foregroundPixels);
      assert.equal(unchangedForegroundRgbPixels,local.unchangedForegroundRgbPixels);
    }
    pngs.push({layerId,versionId,sha256:hash(bytes),bytes:bytes.length,opaquePixels,
      foregroundPixels,unchangedForegroundRgbPixels,pixels:decoded.pixels});
  }
  const exported = await api.exportDocumentPsd({documentId:document.documentId,expectedRevision:document.revision});
  const downloaded = await api.readExportPsd({documentId:document.documentId,exportId:exported.exportId});
  const psd = inspectPsd(downloaded.bytes,{availableMemory:8*1024**3});
  assert.deepEqual([psd.width,psd.height],[document.source.width,document.source.height]);
  for(const p of pngs) {
    const layer = document.layers[p.layerId], found=psd.layers.find(v=>v.name===layer.name);
    assert.ok(found,layer.name);
    assert.deepEqual(found.placement,{x:layer.bounds.x,y:layer.bounds.y});
    assert.ok(Buffer.from(found.image.data).equals(Buffer.from(p.pixels)), 'PSD alpha/RGB must equal PNG');
  }
  // Exercise the actual download routes and attachment headers, not only an
  // encoder or a direct file read. This local server uses the same middleware
  // as the existing V2 workbench, pointed at this isolated acceptance document.
  const middleware=workbenchV2Middleware({root:path.join(root,'documents')});
  const server=createServer((request,response)=>middleware(request,response,()=>{
    response.writeHead(404);response.end();
  }));
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  try {
    const base='http://127.0.0.1:'+server.address().port+'/api/workbench-v2/documents/'+document.documentId;
    for(const p of pngs) {
      const response=await fetch(base+'/layers/'+p.layerId+'/versions/'+p.versionId+'/png?download=1');
      assert.equal(response.status,200);
      assert.equal(response.headers.get('content-type'),'image/png');
      assert.match(response.headers.get('content-disposition'),/^attachment;/);
      assert.equal(hash(Buffer.from(await response.arrayBuffer())),p.sha256);
    }
    const response=await fetch(base+'/exports/'+exported.exportId+'/download');
    assert.equal(response.status,200);
    assert.equal(response.headers.get('content-type'),'image/vnd.adobe.photoshop');
    assert.match(response.headers.get('content-disposition'),/^attachment;/);
    assert.equal(hash(Buffer.from(await response.arrayBuffer())),hash(downloaded.bytes));
  } finally {await new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}
  const report={documentId:document.documentId,sourceSize:[psd.width,psd.height],
    pngs:pngs.map(({pixels,...p})=>p),psd:exported,layerCount:psd.layers.length,
    checks:{automaticResults:true,pngReadback:true,psdReadback:true,exactPlacement:true,pixelIdentity:true,
      frozenSourceUnchanged:true,opaqueSourceRgbIdentity:document.layerOrder.every(id => document.layers[id].strategy.fidelityPolicy !== 'source_faithful_repair') ? true : 'not_applicable_source_faithful_repair',httpPngDownloads:true,httpPsdDownload:true}};
  await save(path.join(root,'delivery-verification.json'),report);
  console.log(JSON.stringify(report,null,2));
} else throw new Error('Use prepare <source-document.json> <new-output-root> or check <output-root>');
