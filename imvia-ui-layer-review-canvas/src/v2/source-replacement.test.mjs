import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { deflateSync } from 'node:zlib';
import os from 'node:os';
import path from 'node:path';
import * as model from './document.js';
import { createWorkbenchV2Api, workbenchV2Middleware } from './api.mjs';
import { createWorkbenchV2Client } from './api-client.js';
import { candidateState, getCompositionLayers } from './candidate-review.js';

function png(width, height, value = 200) {
  const chunk = (type, data) => {
    const content = Buffer.concat([Buffer.from(type), data]); let crc = 0xffffffff;
    for (const byte of content) { crc ^= byte; for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1)); }
    const size = Buffer.alloc(4); size.writeUInt32BE(data.length);
    const checksum = Buffer.alloc(4); checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([size, content, checksum]);
  };
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6;
  const pixels = Buffer.alloc((width * 4 + 1) * height, value);
  for (let y = 0; y < height; y++) pixels[y * (width * 4 + 1)] = 0;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', header), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]);
}
function addDefinitions(document) {
  const anchors = [[10,20], [90,20], [90,180]].map(([x,y]) => ({ x,y,in:{x:x-2,y},out:{x:x+2,y},handlesLinked:true }));
  const region = { id:'pen-a',kind:'include',shape:'bezier_path',closed:true,order:0,requirements:'保留脸部',anchors };
  return model.addLayer(document, { layerId:'custom-a',name:'人物区域',displayCategory:'自定义人物',processingCategory:'subject',
    bounds:{x:10,y:20,width:80,height:160},paths:[region],requirements:'保持原图人物',
    strategy:{operation:'reconstruct',removeBackground:true,repairPaths:[{...region,id:'repair-a',requirements:'补全背景'}]} });
}
function fixture() {
  return addDefinitions(model.createDocument({documentId:'replace-doc',workbenchSessionId:'replace-session',mode:'poster',
    source:{path:'/old.png',width:100,height:200,fingerprint:'old',revision:1}}));
}
const nextSource = {path:'/new.png',width:200,height:100,fingerprint:'new',revision:2};

test('source replacement keeps identity, categories, order, requirements and maps both pen path types', () => {
  const before = fixture(); const original = structuredClone(before);
  const next = model.replaceDocumentSource(before, nextSource);
  for (const key of ['documentId','workbenchSessionId','mode','layerOrder','activeLayerId']) assert.deepEqual(next[key], before[key]);
  const a = next.layers['custom-a']; const old = before.layers['custom-a'];
  for (const key of ['layerId','name','displayCategory','processingCategory','requirements','acceptedVersionId']) assert.deepEqual(a[key],old[key]);
  assert.equal(a.layerRevision,old.layerRevision+1);
  assert.deepEqual(a.bounds,{x:20,y:10,width:160,height:80});
  assert.deepEqual(a.paths[0].anchors[0],{x:20,y:10,in:{x:16,y:10},out:{x:24,y:10},handlesLinked:true});
  assert.equal(a.paths[0].requirements,'保留脸部');
  assert.deepEqual(a.strategy.repairPaths[0].anchors,a.paths[0].anchors);
  assert.equal(a.strategy.repairPaths[0].requirements,'补全背景');
  assert.equal(a.strategy.operation,'reconstruct'); assert.equal(a.strategy.removeBackground,true);
  assert.equal(next.revision,before.revision+1); assert.deepEqual(before,original);
  const sameSize = model.replaceDocumentSource(before,{...nextSource,width:100,height:200});
  assert.deepEqual(sameSize.layers['custom-a'].bounds,old.bounds);
  assert.deepEqual(sameSize.layers['custom-a'].paths,old.paths);
});

test('rounding to a tiny source preserves valid paths and does not restore removed layers', () => {
  let before = model.addLayer(fixture(),{...fixture().layers['custom-a'],layerId:'inactive'});
  before = model.removeLayer(before,'inactive');
  const next = model.replaceDocumentSource(before,{...nextSource,width:1,height:1});
  assert.deepEqual(next.layerOrder,['custom-a']);
  assert.deepEqual(next.layers['custom-a'].bounds,{x:0,y:0,width:1,height:1});
  assert.doesNotThrow(()=>model.validateDocument(next));
});

test('old adopted candidates remain historical and cannot enter the new source composition', () => {
  const before = fixture(); const layer = before.layers['custom-a'];
  const candidate = {versionId:'old-result',execution:'suggested',documentId:before.documentId,layerId:layer.layerId,
    layerRevision:layer.layerRevision,sourceFingerprint:before.source.fingerprint,snapshotId:model.freezeLayer(before,layer.layerId).snapshotId,
    width:80,height:160,placement:{x:10,y:20},alpha:{max:255},review:{checks:{png:true}}};
  layer.acceptedVersionId = candidate.versionId;
  // Explicit historical adoption and automatic delivery share the ready state.
  assert.equal(candidateState(before,layer.layerId,[candidate]).status,'ready');
  const next = model.replaceDocumentSource(before,nextSource);
  assert.equal(next.layers[layer.layerId].acceptedVersionId,'old-result');
  assert.equal(candidateState(next,layer.layerId,[candidate]).status,'stale');
  assert.deepEqual(getCompositionLayers(next,[candidate]),[]);
});

test('HTTP replacement persists the same document and bridge binding; invalid uploads and conflicts keep data intact', async t => {
  const runtime = await mkdtemp(path.join(os.tmpdir(),'imvia-replace-source-'));
  t.after(()=>rm(runtime,{recursive:true,force:true}));
  const root = path.join(runtime,'documents');
  const api = createWorkbenchV2Api({root});
  const middleware = workbenchV2Middleware({root});
  const server = createServer((req,res)=>middleware(req,res,()=>{res.statusCode=404;res.end();}));
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const client = createWorkbenchV2Client((url,options)=>fetch(base+url,options));
  const oldBytes = png(100,200); const newBytes = png(200,100,100);
  const created = await client.createDocument({mode:'poster',file:oldBytes,workbenchSessionId:'same-session'});
  const before = await client.saveDocument(addDefinitions(created),created.revision);
  await api.registerBridgeWorkspace(before.documentId,'same-workspace');
  const next = await client.replaceSource(before.documentId,newBytes,before.revision);
  assert.equal(next.documentId,before.documentId); assert.equal(next.workbenchSessionId,before.workbenchSessionId);
  assert.deepEqual(next.layerOrder,before.layerOrder); assert.equal(next.source.revision,2);
  assert.equal(next.layers['custom-a'].displayCategory,'自定义人物');
  assert.deepEqual(await client.getDocument(before.documentId),next,'reload must retain the replacement and definitions');
  assert.deepEqual(await readdir(root),[before.documentId],'replace must not create another document');
  assert.equal((await api.getBridgeStatus(before.documentId,'same-workspace')).workspaceDocumentId,before.documentId);
  assert.notEqual(client.sourceUrl(next.documentId,next.source.revision),client.sourceUrl(before.documentId,before.source.revision));
  const response = await fetch(base+client.sourceUrl(next.documentId,next.source.revision));
  assert.match(response.headers.get('cache-control'),/no-store/);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()),newBytes);
  assert.deepEqual(await readFile(before.source.path),oldBytes,'historical snapshots still refer to intact source bytes');
  const archived = JSON.parse(await readFile(path.join(root,before.documentId,`revision-${before.revision}.json`),'utf8'));
  assert.deepEqual(archived,before);
  const files = (await readdir(path.dirname(next.source.path))).sort();
  await assert.rejects(client.replaceSource(before.documentId,png(5,5),before.revision),{code:'REVISION_CONFLICT'});
  await assert.rejects(client.replaceSource(before.documentId,Buffer.from('not a PNG'),next.revision));
  assert.deepEqual(await client.getDocument(before.documentId),next);
  assert.deepEqual((await readdir(path.dirname(next.source.path))).sort(),files,'failed replacements must not leave orphan image files');
  assert.deepEqual(await api.listSessionBatches(before.workbenchSessionId),[],'replacement must never submit a split');
});
