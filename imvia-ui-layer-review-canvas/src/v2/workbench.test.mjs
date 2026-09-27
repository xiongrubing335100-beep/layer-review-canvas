import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer as createHttpServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createWorkbenchV2Api } from './api.mjs';
import { createBridgeRequestStore } from './bridge-request-store.js';
import { createDocument, addLayer, processingCategories, reorderLayers } from './document.js';
import { workbenchV2Middleware } from './api.mjs';
import { fitViewport } from './coordinates.js';
import { createEditorDraft } from './editor-state.js';
import { createServer } from 'vite';

let vite;
let WorkbenchV2;
let DocumentCanvas;
let LayerList;
let LayerEditor;
let PenEditor;

test('load V2 React components through Vite JSX transform', async () => {
  vite = await createServer({ configFile: path.resolve('vite.config.js'), server: { middlewareMode: true }, appType: 'custom' });
  ({ WorkbenchV2 } = await vite.ssrLoadModule('/src/v2/WorkbenchV2.jsx'));
  ({ DocumentCanvas } = await vite.ssrLoadModule('/src/v2/DocumentCanvas.jsx'));
  ({ LayerList } = await vite.ssrLoadModule('/src/v2/LayerList.jsx'));
  ({ LayerEditor } = await vite.ssrLoadModule('/src/v2/LayerEditor.jsx'));
  ({ PenEditor } = await vite.ssrLoadModule('/src/v2/PenEditor.jsx'));
});
after(async () => { await vite?.close(); });

const noOp = () => {};
const pngChunk = (type, data) => {
  const typeBytes = Buffer.from(type); const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
  const crcInput = Buffer.concat([typeBytes, data]); let crc = 0xffffffff;
  for (const byte of crcInput) { crc ^= byte; for (let bit=0; bit<8; bit+=1) crc=(crc>>>1)^(0xedb88320&-(crc&1)); }
  const checksum=Buffer.alloc(4); checksum.writeUInt32BE((crc^0xffffffff)>>>0);
  return Buffer.concat([length,typeBytes,data,checksum]);
};
const tinyPng = () => {
  const signature=Buffer.from([137,80,78,71,13,10,26,10]); const header=Buffer.alloc(13);
  header.writeUInt32BE(1,0);header.writeUInt32BE(1,4);header[8]=8;header[9]=6;
  return Buffer.concat([signature,pngChunk('IHDR',header),pngChunk('IDAT',Buffer.from([120,156,99,248,207,192,240,31,0,5,0,1,255])),pngChunk('IEND',Buffer.alloc(0))]);
};
const documentFixture = (mode = 'poster') => addLayer(createDocument({ documentId: 'doc-ui', workbenchSessionId: 'session-ui', mode,
  source: { path: '/fixture/source.png', width: 1562, height: 3396, fingerprint: 'fixture', revision: 1 } }), {
  layerId: 'layer-a', name: '主标题', displayCategory: '主标题', processingCategory: 'text',
  bounds: { x: 30, y: 40, width: 250, height: 120 }, paths: [], requirements: '',
  strategy: { operation: 'extract', removeBackground: false, repairPaths: [] },
});

test('empty workbench provides separate poster and H5 upload entry points', () => {
  const markup = renderToStaticMarkup(React.createElement(WorkbenchV2, { api: {}, onOpenLegacy: noOp, onOpenOverview: noOp }));
  assert.match(markup, /上传海报原图拆分/);
  assert.match(markup, /上传 H5 原图拆分/);
  assert.match(markup, /重新开始/);
});

test('single-layer editor shows requested controls while pen view keeps the source image and honest tool availability', () => {
  const doc = documentFixture(); const draft = createEditorDraft(doc, 'layer-a');
  const editor = renderToStaticMarkup(React.createElement(LayerEditor, { document: doc, sourceUrl: '/source.png', draft, onChange: noOp, onDone: noOp, onCancel: noOp, onOpenPen: noOp }));
  assert.match(editor, /编辑拆分/); assert.match(editor, /拆分类别/); assert.match(editor, /处理要求/);
  assert.match(editor, /移除背景/); assert.match(editor, /补全被遮挡区域/); assert.match(editor, /完成/); assert.match(editor, /取消/);
  const pen = renderToStaticMarkup(React.createElement(PenEditor, { source: doc.source, sourceUrl: '/source.png', draft, onChange: noOp, onClose: noOp }));
  assert.match(pen, /放大钢笔编辑/); assert.match(pen, /魔棒不可用/); assert.match(pen, /拖动移动画布/);
});

test('one stable layer id is shared by canvas selection and list; pending custom categories require a processing route', () => {
  const doc = documentFixture();
  const canvas = renderToStaticMarkup(React.createElement(DocumentCanvas, { document: doc, sourceUrl:'/source.png', transform:{scale:.2,offsetX:0,offsetY:0}, selection: 'layer-a', onSelect: noOp, onBoundsChange: noOp }));
  const list = renderToStaticMarkup(React.createElement(LayerList, { document: doc, statusByLayer: {}, onSelect: noOp, onEdit: noOp, onAdd: noOp, onReorder: noOp }));
  assert.match(canvas, /data-layer-id="layer-a"/);
  assert.match(list, /data-layer-id="layer-a"/);
  const empty = renderToStaticMarkup(React.createElement(LayerList, { document: createDocument({ documentId:'empty',workbenchSessionId:'s',mode:'h5',source:doc.source }), statusByLayer:{},onSelect:noOp,onEdit:noOp,onAdd:noOp,onReorder:noOp }));
  assert.deepEqual(processingCategories, ['text','subject','brand_ui','decoration_prop','effect','background']);
  assert.throws(() => addLayer(createDocument({ documentId:'bad',workbenchSessionId:'s',mode:'h5',source:doc.source }), {
    layerId:'bad-route',name:'自定义',displayCategory:'自定义',processingCategory:'unknown',bounds:{x:0,y:0,width:1,height:1},paths:[],requirements:'',
    strategy:{operation:'extract',removeBackground:false,repairPaths:[]},
  }));
});

test('reordering changes only layer order and keeps layer identities and geometry stable', () => {
  let doc = documentFixture();
  doc = addLayer(doc, { layerId:'layer-b',name:'角色',displayCategory:'角色',processingCategory:'subject',bounds:{x:400,y:600,width:200,height:300},paths:[],requirements:'',strategy:{operation:'extract',removeBackground:false,repairPaths:[]} });
  const before = structuredClone(doc.layers);
  const reordered = reorderLayers(doc, ['layer-b','layer-a']);
  assert.deepEqual(reordered.layerOrder, ['layer-b','layer-a']);
  assert.deepEqual(reordered.layers, before);
});

test('portrait, landscape, and tiny transparent sources fit without cropping at desktop and mobile viewport ratios', () => {
  for (const source of [{width:3200,height:1000},{width:1562,height:3396},{width:1,height:1}]) {
    for (const viewport of [{width:1200,height:700},{width:396,height:700}]) {
      const fit=fitViewport({x:0,y:0,...source},viewport,0);
      const width=source.width*fit.scale; const height=source.height*fit.scale;
      assert.ok(width<=viewport.width+1e-6); assert.ok(height<=viewport.height+1e-6);
      assert.ok(fit.offsetX>=-1e-6&&fit.offsetY>=-1e-6);
    }
  }
});

test('empty workbench and unsplit layers never show a generation timer', () => {
  const empty = renderToStaticMarkup(React.createElement(WorkbenchV2, { api: {}, onOpenLegacy: noOp, onOpenOverview: noOp }));
  const list = renderToStaticMarkup(React.createElement(LayerList, { document: documentFixture(),statusByLayer:{},onSelect:noOp,onEdit:noOp,onAdd:noOp,onReorder:noOp }));
  assert.doesNotMatch(empty + list, /00:\d\d|生成中|处理中/);
});

test('V2 API stores PNG source and document, then rejects stale save without overwriting current revision', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'imvia-v2-api-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const api = createWorkbenchV2Api({ root });
  const png = tinyPng();
  const original = await api.createDocument({ mode: 'h5', bytes: png, workbenchSessionId: 'test-session' });
  assert.equal(original.source.width, 1);
  assert.deepEqual(await api.readSource(original.documentId), png);
  assert.deepEqual(await api.getDocument(original.documentId), original);
  const edited = { ...original, revision: 2 };
  await api.saveDocument(edited, 1);
  await assert.rejects(api.saveDocument({ ...original, revision: 2 }, 1), error => error.code === 'REVISION_CONFLICT');
  assert.equal((await api.getDocument(original.documentId)).revision, 2);
});

test('batch API freezes the saved document, requires a matching bridge receipt, and restart cancels only its session', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'imvia-v2-batches-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const documentsRoot = path.join(root, 'documents');
  const api = createWorkbenchV2Api({ root: documentsRoot });
  const document = await api.createDocument({ mode: 'poster', bytes: tinyPng(), workbenchSessionId: 'batch-session' });
  const layered = addLayer(document, { layerId: 'batch-layer', name: '主标题', displayCategory: '主标题', processingCategory: 'text',
    bounds: { x: 0, y: 0, width: 1, height: 1 }, paths: [], requirements: '', strategy: { operation: 'extract', removeBackground: false, repairPaths: [] } });
  await api.saveDocument(layered, document.revision);
  const submitted = await api.submitBatch({ documentId: document.documentId, expectedRevision: layered.revision, submissionKey: 'batch-submit' });
  assert.equal(submitted.batch.items.length, 1);
  assert.match(submitted.prompt, /confirm_workbench_v2_batch/);
  const abandoned = await api.submitBatch({ documentId: document.documentId, expectedRevision: layered.revision,
    submissionKey: 'cancel-before-send', mode: 'retry', layerIds: ['batch-layer'] });
  await api.cancelBatch(abandoned.batch.batchId);
  assert.equal((await api.getConfirmation(abandoned.batch.batchId)).status, 'cancelled');
  await assert.rejects(api.claimNextBatchItem({ batchId: submitted.batch.batchId, receipt: null }), /BATCH_CONFIRMATION_REQUIRED/);
  const bridgeStore = createBridgeRequestStore({ root: path.join(root, 'bridge-requests') });
  const claimed = await bridgeStore.read(submitted.batch.batchId);
  assert.equal(claimed.status, 'claimed');
  const receipt = { workbenchSessionId: claimed.workbenchSessionId, envelopeSha256: claimed.envelopeSha256 };
  await bridgeStore.transition({ requestId: submitted.batch.batchId, expectedStatus: 'claimed', nextStatus: 'sent', receipt });
  const work = await api.claimNextBatchItem({ batchId: submitted.batch.batchId, receipt });
  assert.equal(work.manifest.maximumImagegenCalls, 0);
  assert.deepEqual(work.manifest.snapshot.bounds, { x: 0, y: 0, width: 1, height: 1 });
  await api.restartSession({ workbenchSessionId: 'batch-session' });
  const cancelled = await api.getAttempt(work.attempt.attemptId);
  assert.equal(cancelled.execution, 'cancelled');
  const late = await api.applyAttemptEvent({ batchId: submitted.batch.batchId, event: { eventId: 'late-after-restart',
    attemptId: work.attempt.attemptId, dispatchId: work.attempt.dispatchId, type: 'suggested', payload: { versionId: 'late' } } });
  assert.equal(late.execution, 'cancelled');
});

test('V2 HTTP endpoints return a saved document, raw source PNG, and a 409 for stale updates', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'imvia-v2-http-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const middleware = workbenchV2Middleware({ root: path.join(root, 'documents') });
  const server = createHttpServer((request,response)=>middleware(request,response,()=>{response.statusCode=404;response.end();}));
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const address=server.address(); const base=`http://127.0.0.1:${address.port}/api/workbench-v2`;
  const png=tinyPng();
  const create=await fetch(`${base}/documents`,{method:'POST',headers:{'Content-Type':'image/png','X-Workbench-Mode':'poster','X-Workbench-Session':'http-session'},body:png});
  assert.equal(create.status,201); const document=await create.json();
  assert.equal((await fetch(`${base}/documents/${document.documentId}`)).status,200);
  const source=await fetch(`${base}/documents/${document.documentId}/source`);
  assert.deepEqual(Buffer.from(await source.arrayBuffer()),png);
  const stale=await fetch(`${base}/documents/${document.documentId}`,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({document:{...document,revision:2},expectedRevision:0})});
  assert.equal(stale.status,409);
  const layered=addLayer(document,{layerId:'http-layer',name:'主体',displayCategory:'主体',processingCategory:'subject',bounds:{x:0,y:0,width:1,height:1},paths:[],requirements:'',strategy:{operation:'extract',removeBackground:false,repairPaths:[]}});
  const saved=await fetch(`${base}/documents/${document.documentId}`,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({document:layered,expectedRevision:1})});
  assert.equal(saved.status,200);
  const submitted=await fetch(`${base}/documents/${document.documentId}/batches`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({expectedRevision:2,submissionKey:'http-submit'})});
  assert.equal(submitted.status,202);const submission=await submitted.json();
  const bridgeStore=createBridgeRequestStore({root:path.join(root,'bridge-requests')});
  const pending=await bridgeStore.read(submission.batch.batchId);
  const claimedReceipt={workbenchSessionId:pending.workbenchSessionId,envelopeSha256:pending.envelopeSha256};
  assert.equal(pending.status,'claimed');
  await bridgeStore.transition({requestId:pending.requestId,expectedStatus:'claimed',nextStatus:'sent',receipt:claimedReceipt});
  const claimed=await fetch(`${base}/batches/${submission.batch.batchId}/claim-next`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({receipt:claimedReceipt})});
  assert.equal(claimed.status,200);const item=await claimed.json();assert.equal(item.manifest.maximumImagegenCalls,0);
  const restarted=await fetch(`${base}/sessions/http-session/restart`,{method:'POST'});
  assert.equal(restarted.status,200);
  const cancelled=await fetch(`${base}/attempts/${item.attempt.attemptId}`);
  assert.equal((await cancelled.json()).execution,'cancelled');
});
