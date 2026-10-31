import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createServer as createHttpServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createWorkbenchV2Api } from './api.mjs';
import { createBridgeRequestStore } from './bridge-request-store.js';
import { createBridgeRecovery } from './bridge-recovery.js';
import { createDocument, addLayer, applyLayerEdit, processingCategories, reorderLayers } from './document.js';
import { workbenchV2Middleware } from './api.mjs';
import { fitViewport } from './coordinates.js';
import { createEditorDraft, reduceEditorDraft } from './editor-state.js';
import { createServer } from 'vite';

let vite;
let WorkbenchV2;
let DocumentCanvas;
let LayerList;
let LayerEditor;
let PenEditor;
let CandidateReview;
let NodeBoard;

test('load V2 React components through Vite JSX transform', async () => {
  vite = await createServer({ configFile: path.resolve('vite.config.js'), server: { middlewareMode: true }, appType: 'custom' });
  ({ WorkbenchV2 } = await vite.ssrLoadModule('/src/v2/WorkbenchV2.jsx'));
  ({ DocumentCanvas } = await vite.ssrLoadModule('/src/v2/DocumentCanvas.jsx'));
  ({ LayerList } = await vite.ssrLoadModule('/src/v2/LayerList.jsx'));
  ({ LayerEditor } = await vite.ssrLoadModule('/src/v2/LayerEditor.jsx'));
  ({ PenEditor } = await vite.ssrLoadModule('/src/v2/PenEditor.jsx'));
  ({ CandidateReview } = await vite.ssrLoadModule('/src/v2/CandidateReview.jsx'));
  ({ NodeBoard } = await vite.ssrLoadModule('/src/v2/NodeBoard.jsx'));
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

test('automatic recovery integrates with document binding, preserves edits, and blocks superseded documents', async t => {
  const root=await mkdtemp(path.join(os.tmpdir(),'imvia-auto-document-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const bridgeStore=createBridgeRequestStore({root:path.join(root,'bridge-requests')});
  const api=createWorkbenchV2Api({root:path.join(root,'documents'),bridgeStore});
  const old=await api.createDocument({mode:'poster',bytes:tinyPng(),workbenchSessionId:'old-session'});
  const current=await api.createDocument({mode:'poster',bytes:tinyPng(),workbenchSessionId:'current-session'});
  await api.registerBridgeWorkspace(old.documentId,'workspace');
  const oldBinding=await bridgeStore.getWorkspace('workspace');
  await bridgeStore.pollRelay({...oldBinding,bridgeId:'card',claim:false});
  await api.registerBridgeWorkspace(current.documentId,'workspace');
  const status=await api.getBridgeStatus(current.documentId,'workspace');
  assert.equal(status.reason,'binding_mismatch');
  const recovery=createBridgeRecovery({api,documentId:current.documentId,workspaceId:'workspace'});
  assert.equal((await recovery.recover(status)).online,false,'a reconnect request alone is not an acknowledgement');
  const receipt=await bridgeStore.pollRelay({...oldBinding,bridgeId:'card',claim:false});
  assert.equal(receipt.request,null);
  assert.equal((await api.getBridgeStatus(current.documentId,'workspace')).online,true);
  assert.deepEqual(await api.getDocument(current.documentId),current);
  assert.deepEqual(await api.getDocument(old.documentId),old);
  assert.deepEqual(await api.listSessionBatches('current-session'),[]);
  const stale=await api.reconnectBridge(old.documentId,'workspace',{automatic:true});
  assert.equal(stale.autoReconnectBlocked,true);
  assert.equal(stale.online,false);
  assert.equal((await bridgeStore.getWorkspace('workspace')).documentId,current.documentId);
});

test('empty workbench provides separate poster and H5 upload entry points', () => {
  const markup = renderToStaticMarkup(React.createElement(WorkbenchV2, { api: {}, onOpenLegacy: noOp, onOpenOverview: noOp }));
  assert.match(markup, /上传海报原图拆分/);
  assert.match(markup, /上传 H5 原图拆分/);
  assert.match(markup, /新建空白任务/);
  assert.match(markup, /aria-label="更多"/);
  assert.doesNotMatch(markup, /导入旧版项目/);
});

test('a fresh workbench allows entering the node board before any source is uploaded', () => {
  const markup = renderToStaticMarkup(React.createElement(WorkbenchV2, { api: {} }));
  const button = markup.match(/<button[^>]*>⌘　画布总览<\/button>/)?.[0];
  assert.ok(button, 'the board entry must be available');
  assert.doesNotMatch(button, /disabled/, 'an empty task still has a usable board');
});

test('the empty node board has upload and navigation tools, not a disabled document preview', () => {
  const markup=renderToStaticMarkup(React.createElement(NodeBoard,{document:null,workspaceId:'fresh',sessionId:'fresh'}));
  assert.match(markup,/aria-label="无限画布/);
  assert.match(markup,/上传海报原图/);assert.match(markup,/上传 H5 原图/);
  assert.match(markup,/aria-label="放大画布"(?! disabled)/);
  assert.doesNotMatch(markup,/data-board-node=/);
});

test('the node board renders independent source and split nodes, linked and clipped to the source region', () => {
  const markup=renderToStaticMarkup(React.createElement(NodeBoard,{document:documentFixture(),sourceUrl:'/source.png',workspaceId:'w',sessionId:'s'}));
  assert.match(markup,/data-board-node="source"/);
  assert.match(markup,/data-board-node="layer:layer-a"/);
  assert.match(markup,/aria-label="原图、拆分项与结果的关系"/);
  assert.match(markup,/viewBox="30 40 250 120"/);
  assert.match(markup,/clip-path="url\(#board-crop-layer-a\)"/);
  assert.match(markup,/aria-label="画板编辑：主标题"/);
});

test('every layer has an individually named split action and submission busy state disables it', () => {
  const doc = addLayer(documentFixture(), { layerId: 'layer-b', name: '背景', displayCategory: '背景', processingCategory: 'background',
    bounds: { x: 0, y: 0, width: 100, height: 100 }, paths: [], requirements: '',
    strategy: { operation: 'extract', removeBackground: false, repairPaths: [] } });
  const render = splitDisabled => renderToStaticMarkup(React.createElement(LayerList, { document: doc, onSplit: noOp, splitDisabled }));
  for (const name of ['主标题', '背景']) {
    assert.match(render(false), new RegExp(`aria-label="单独拆分：${name}"(?! disabled)`));
    assert.match(render(true), new RegExp(`aria-label="单独拆分：${name}" disabled=""`));
  }
});

test('layer summary counts delivered current results, not historical accepted IDs', () => {
  const document = documentFixture(); document.layers['layer-a'].acceptedVersionId = 'old-version';
  const stale = renderToStaticMarkup(React.createElement(LayerList, { document, adoptedCount: 0 }));
  assert.doesNotMatch(stale, /已完成 1/);
  const current = renderToStaticMarkup(React.createElement(LayerList, { document, adoptedCount: 1 }));
  assert.match(current, /已完成 1/);
});

test('a stale eligibility response cannot show an unverified PNG as a delivered result', () => {
  const document = documentFixture();
  const markup = renderToStaticMarkup(React.createElement(CandidateReview, { document, layerId: 'layer-a',
    state: { status: 'ready', versionIds: ['old'], resultVersionId: 'old' }, candidateUrl: () => '/candidate.png',
    versions: [{ versionId: 'old', artifactValid: true, width: 250, height: 120, placement: { x: 30, y: 40 },
      pixelAudit: { maskProvider: 'imagegen_matte' }, createdAt: '2026-10-13T00:00:00Z' }] }));
  assert.doesNotMatch(markup, /src="\/candidate.png"|下载 PNG|确认并采用|type="checkbox"/);
});

test('quality failures do not expose manual waiver controls or pretend to be completed PNGs', () => {
  const document = documentFixture();
  const version = { versionId: 'edge-review', artifactValid: true, sha256: 'a'.repeat(64), snapshotId: 'snap',
    width: 250, height: 120, placement: { x: 30, y: 40 }, createdAt: '2026-10-13T00:00:00Z',
    pixelAudit: { maskProvider: 'imagegen_matte', sourceGeometryAlignment: {
      policyVersion: 7, method: 'source_guided_matte', evidenceMethod: 'bounded_shape', status: 'needs_review',
      contourIntegrity: { status: 'passed', changedByAlphaRecoveryPixels: 0, lostCounterPixels: 0 },
      reviewReasons: ['SOURCE_BOUNDARY_UNCERTAIN'], boundaryMatchRatio: .96, boundaryPixels: 1000, longestUnsupportedRun: 22,
      uncertainRegions: [{ x: 10, y: 15, width: 4, height: 22, boundaryPixels: 22 }] } } };
  const markup = renderToStaticMarkup(React.createElement(CandidateReview, { document, layerId: 'layer-a', versions: [version],
    state: { status: 'quality_failed', versionIds: [] }, candidateUrl: () => '/candidate.png', sourceUrl: '/source.png' }));
  assert.match(markup, /未能完成该项/);
  assert.doesNotMatch(markup, /type="checkbox"|确认并采用|我已检查|src="\/candidate.png"|下载 PNG/);
  assert.match(markup, /<details class="v2-result-history">/, 'diagnostics are optional collapsed history');
});

test('verified result view offers PNG directly and keeps source comparison optional', () => {
  const document = documentFixture();
  const version = { versionId: 'ready', artifactValid: true, width: 250, height: 120,
    alpha: { min: 0, max: 255 }, placement: { x: 30, y: 40 }, createdAt: '2026-10-13T00:00:00Z' };
  const markup = renderToStaticMarkup(React.createElement(CandidateReview, { document, layerId: 'layer-a', versions: [version],
    state: { status: 'ready', versionIds: ['ready'], resultVersionId: 'ready' },
    candidateUrl: () => '/candidate.png', sourceUrl: '/source.png' }));
  assert.match(markup, /v2-review-preview has-result/);
  assert.match(markup, /href="\/candidate.png\?download=1"/);
  assert.match(markup, /已完成，可直接下载|对照原图/);
  assert.doesNotMatch(markup, /确认并采用|采用此版本|type="checkbox"/);
});

test('single-layer editor shows requested controls while pen view keeps the source image and honest tool availability', () => {
  const doc = documentFixture(); const draft = createEditorDraft(doc, 'layer-a');
  const editor = renderToStaticMarkup(React.createElement(LayerEditor, { document: doc, sourceUrl: '/source.png', draft, onChange: noOp, onDone: noOp, onCancel: noOp, onOpenPen: noOp }));
  assert.match(editor, /编辑拆分/); assert.match(editor, /拆分类别/); assert.match(editor, /处理要求/);
  assert.match(editor, /移除背景/); assert.match(editor, /补全被遮挡区域/); assert.match(editor, /完成/); assert.match(editor, /取消/);
  const pen = renderToStaticMarkup(React.createElement(PenEditor, { source: doc.source, sourceUrl: '/source.png', draft, onChange: noOp, onClose: noOp }));
  assert.match(pen, /放大钢笔编辑/); assert.doesNotMatch(pen, /魔棒/); assert.match(pen, /拖动移动画布/);
  const tools = pen.match(/<div class="v2-pen-tools"[\s\S]*?<\/div>/)?.[0];
  assert.equal((tools.match(/aria-pressed="true"/g) || []).length, 1, 'only one mutually exclusive tool is selected');
  assert.equal((tools.match(/aria-pressed="false"/g) || []).length, 2);
  assert.match(tools, /aria-label="删除选中路径或锚点"[^>]*disabled=""/, 'delete is an unavailable action, not a selected mode');
  assert.doesNotMatch(pen, /绘制保留区域|每个选区单独记录|闭合选区后填写要求，拆分时与整体要求一起处理/);
  assert.doesNotMatch(editor, /魔棒|编辑修复区域/);
  assert.equal((editor.match(/aria-label="编辑钢笔路径"/g) || []).length, 1);
});

test('single-layer editing shows only the selected crop at its original coordinates with a zoom entry', () => {
  const doc = addLayer(documentFixture(), { layerId: 'other', name: '不应出现在编辑画布的区域', displayCategory: '角色', processingCategory: 'subject',
    bounds: { x: 800, y: 1200, width: 100, height: 200 }, paths: [], requirements: '', strategy: { operation: 'extract', removeBackground: false, repairPaths: [] } });
  const markup = renderToStaticMarkup(React.createElement(LayerEditor, { document: doc, sourceUrl: '/source.png',
    draft: createEditorDraft(doc, 'layer-a'), onChange: noOp, onDone: noOp, onCancel: noOp, onOpenPen: noOp }));
  assert.match(markup, /viewBox="30 40 250 120"/);
  assert.match(markup, /clip-path="url\(#/);
  assert.match(markup, /aria-label="放大编辑当前选区"/);
  assert.doesNotMatch(markup, /不应出现在编辑画布的区域|data-layer-id="other"/);
});

test('category chooser exposes a labelled closed combobox and preserves custom category names', () => {
  for (const category of ['主标题', '自定义标题']) {
    const doc = applyLayerEdit(documentFixture(), 'layer-a', { displayCategory: category });
    const draft = createEditorDraft(doc, 'layer-a');
    const markup = renderToStaticMarkup(React.createElement(LayerEditor, { document: doc, sourceUrl: '/source.png',
      draft, onChange: noOp, onDone: noOp, onCancel: noOp, onOpenPen: noOp }));
    const chooser = markup.match(/<button[^>]*role="combobox"[^>]*>[\s\S]*?<\/button>/)?.[0];
    assert.ok(chooser, 'category choices must use the themed in-page chooser');
    assert.match(chooser, /aria-label="拆分类别"/);
    assert.match(chooser, /aria-expanded="false"/);
    assert.match(chooser, /aria-haspopup="listbox"/);
    if (category === '主标题') assert.ok(chooser.includes(category));
    else {
      assert.match(chooser, /自定义/);
      assert.match(markup, /value="自定义标题"/, 'the saved custom name remains editable');
      assert.match(markup, /aria-label="处理类别"/);
    }
    assert.match(markup, /aria-label="移除背景"/);
  }
});

test('choosing custom shows editable fields and blocks Done until the category is named', () => {
  const doc = documentFixture();
  let draft = reduceEditorDraft(createEditorDraft(doc, 'layer-a'), { type: 'set-category', value: '__custom__' });
  const render = () => renderToStaticMarkup(React.createElement(LayerEditor, { document: doc, draft, onChange: noOp }));
  assert.match(render(), /自定义类别名称/);
  assert.match(render(), /<button[^>]* disabled=""[^>]*>完成<\/button>/);
  draft = reduceEditorDraft(draft, { type: 'set-field', field: 'displayCategory', value: '活动徽章' });
  assert.doesNotMatch(render(), /<button[^>]* disabled=""[^>]*>完成<\/button>/);
});

test('one stable layer id is shared by canvas selection and list; pending custom categories require a processing route', () => {
  const doc = documentFixture();
  const canvas = renderToStaticMarkup(React.createElement(DocumentCanvas, { document: doc, sourceUrl:'/source.png', transform:{scale:.2,offsetX:0,offsetY:0}, selection: 'layer-a', onSelect: noOp, onBoundsChange: noOp }));
  const list = renderToStaticMarkup(React.createElement(LayerList, { document: doc, statusByLayer: {}, onSelect: noOp, onEdit: noOp, onAdd: noOp, onReorder: noOp }));
  assert.match(canvas, /data-layer-id="layer-a"/);
  assert.match(list, /data-layer-id="layer-a"/);
  assert.match(list, /查看主标题结果/);
  const empty = renderToStaticMarkup(React.createElement(LayerList, { document: createDocument({ documentId:'empty',workbenchSessionId:'s',mode:'h5',source:doc.source }), statusByLayer:{},onSelect:noOp,onEdit:noOp,onAdd:noOp,onReorder:noOp }));
  assert.deepEqual(processingCategories, ['text','subject','brand_ui','decoration_prop','effect','background']);
  assert.throws(() => addLayer(createDocument({ documentId:'bad',workbenchSessionId:'s',mode:'h5',source:doc.source }), {
    layerId:'bad-route',name:'自定义',displayCategory:'自定义',processingCategory:'unknown',bounds:{x:0,y:0,width:1,height:1},paths:[],requirements:'',
    strategy:{operation:'extract',removeBackground:false,repairPaths:[]},
  }));
});

test('canvas paints bottom layers first so list order controls overlap hit priority', () => {
  const doc = addLayer(documentFixture(), { layerId: 'background', name: '背景', displayCategory: '背景', processingCategory: 'background',
    bounds: { x: 0, y: 0, width: 1562, height: 3396 }, paths: [], requirements: '',
    strategy: { operation: 'extract', removeBackground: false, repairPaths: [] } });
  const before = structuredClone(doc);
  const paintOrder = (document, selection) => {
    const markup = renderToStaticMarkup(React.createElement(DocumentCanvas, {
      document, sourceUrl: '/source.png', transform: { scale: .2, offsetX: 0, offsetY: 0 }, selection,
    }));
    return [...markup.matchAll(/data-layer-id="([^"]+)"/g)].map(match => match[1]);
  };
  assert.deepEqual(paintOrder(doc, 'background'), ['background', 'layer-a'], 'selecting the background must not raise it above foreground regions');
  assert.deepEqual(paintOrder(doc, 'layer-a'), ['background', 'layer-a']);
  const reordered = reorderLayers(doc, ['background', 'layer-a']);
  assert.deepEqual(paintOrder(reordered, 'layer-a'), ['layer-a', 'background'], 'moving a layer to the top must raise its hit priority');
  assert.deepEqual(doc, before, 'rendering must not mutate saved layer order or geometry');
});

test('overview and focused editor expose eight resize handles for the active region', () => {
  const doc = documentFixture();
  const canvas = renderToStaticMarkup(React.createElement(DocumentCanvas, { document: doc, sourceUrl: '/source.png',
    transform: { scale: .2, offsetX: 0, offsetY: 0 }, selection: 'layer-a', onRegionResize: noOp }));
  const editor = renderToStaticMarkup(React.createElement(LayerEditor, { document: doc, sourceUrl: '/source.png',
    draft: createEditorDraft(doc, 'layer-a'), onChange: noOp }));
  for (const markup of [canvas, editor]) {
    assert.equal((markup.match(/data-resize-handle=/g) || []).length, 8);
    for (const side of ['nw','n','ne','e','se','s','sw','w']) assert.ok(markup.includes(`data-resize-handle="${side}"`));
  }
});

test('hiding all regions removes outlines, labels and handles without changing the document', () => {
  const doc = documentFixture();
  const before = structuredClone(doc);
  const props = { document: doc, sourceUrl: '/source.png', transform: { scale: .2, offsetX: 0, offsetY: 0 }, selection: 'layer-a', onRegionResize: noOp };
  const hidden = renderToStaticMarkup(React.createElement(DocumentCanvas, { ...props, regionsVisible: false }));
  assert.match(hidden, /上传的原图/);
  assert.doesNotMatch(hidden, /v2-canvas__overlay|data-layer-id=|data-resize-handle=|主标题/);
  const shown = renderToStaticMarkup(React.createElement(DocumentCanvas, { ...props, regionsVisible: true }));
  assert.match(shown, /data-layer-id="layer-a"/);
  assert.equal((shown.match(/data-resize-handle=/g) || []).length, 8);
  assert.deepEqual(doc, before);
});

test('result view provides zoom controls and PNG download without adoption', () => {
  const doc = documentFixture();
  const candidate = { versionId: 'version-a', artifactValid: true, width: 250, height: 120,
    placement: { x: 30, y: 40 }, createdAt: '2026-09-27T00:00:00Z', alpha: { min: 0, max: 255 },
    review: { checks: { png: true, alpha: true } } };
  const markup = renderToStaticMarkup(React.createElement(CandidateReview, { document: doc, layerId: 'layer-a', versions: [candidate],
    state: { status: 'ready', versionIds: ['version-a'], resultVersionId: 'version-a' }, composition: [], candidateUrl: id => `/candidate/${id}.png`,
    onBack: noOp, onAdopt: noOp, onRetry: noOp, onRefresh: noOp }));
  assert.match(markup, /拆分结果预览，可缩放和拖动/);
  assert.match(markup, /aria-label="放大候选"/);
  assert.match(markup, /download="主标题-version-.png"/);
  assert.match(markup, /1562 × 3396/);
  assert.doesNotMatch(markup, /采用此版本/);
  assert.match(markup, /重新拆分当前项/);
  assert.match(markup, /candidate\/version-a.png/);
  assert.match(markup, /candidate\/version-a.png\?download=1/);
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

test('candidate API automatically composes valid results and permits optional explicit version selection', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'imvia-v2-candidate-api-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const exportRecords = [];
  const exportStore = { async exportDocumentPsd({ document, expectedRevision }) {
    assert.equal(document.revision, expectedRevision);
    const record = { exportId: 'a'.repeat(32), documentId: document.documentId, documentRevision: document.revision,
      status: 'complete', sha256: 'b'.repeat(64), layerCount: 1, createdAt: new Date().toISOString() };
    exportRecords.push(record); return record;
  }, async list(documentId, revision) { return exportRecords.filter(value => value.documentId === documentId).map(value => ({ ...value, stale: value.documentRevision !== revision })); },
  async readPsd(documentId, exportId) { return { record: exportRecords.find(value => value.documentId === documentId && value.exportId === exportId), bytes: Buffer.from('8BPS') }; } };
  const documentsRoot = path.join(root, 'documents'); const api = createWorkbenchV2Api({ root: documentsRoot, exportStore });
  const source = tinyPng();
  const created = await api.createDocument({ mode: 'poster', bytes: source, workbenchSessionId: 'review-session' });
  const layered = addLayer(created, { layerId: 'review-layer', name: '主标题', displayCategory: '主标题', processingCategory: 'text',
    bounds: { x: 0, y: 0, width: 1, height: 1 }, paths: [], requirements: '', strategy: { operation: 'extract', removeBackground: false, repairPaths: [] } });
  await api.saveDocument(layered, created.revision);
  const submitted = await api.submitBatch({ documentId: created.documentId, expectedRevision: layered.revision,
    submissionKey: 'review-candidate-attempt', mode: 'retry', layerIds: ['review-layer'] });
  const attempt = submitted.batch.items[0].attempt;
  await api.applyAttemptEvent({ batchId: attempt.batchId, event: { eventId: 'review-candidate-ready', attemptId: attempt.attemptId,
    dispatchId: attempt.dispatchId, type: 'suggested', payload: { versionId: 'version-fixture' } } });
  const pngPath = path.join(root, 'candidates', attempt.attemptId, 'version-fixture.png');
  const metadataPath = path.join(root, 'candidates', attempt.attemptId, 'version-fixture.json');
  await mkdir(path.dirname(pngPath), { recursive: true }); await writeFile(pngPath, source);
  const version = { versionId: 'version-fixture', attemptId: attempt.attemptId, batchId: attempt.batchId,
    documentId: attempt.documentId, layerId: attempt.layerId, layerRevision: attempt.layerRevision, dispatchId: attempt.dispatchId,
    authorizationId: attempt.authorizationId, snapshotId: attempt.snapshotId, sourceFingerprint: attempt.sourceFingerprint,
    pngPath, sha256: createHash('sha256').update(source).digest('hex'), width: 1, height: 1,
    alpha: { min: 255, max: 255 }, placement: { x: 0, y: 0 }, review: { checks: { png: true, authorization: true } },
    pixelAudit: { status: 'NEEDS_USER_REVIEW' }, createdAt: new Date().toISOString() };
  await writeFile(metadataPath, JSON.stringify(version));
  const listed = await api.listLayerVersions({ documentId: created.documentId, layerId: 'review-layer' });
  assert.equal(listed.state.status, 'ready'); assert.equal(listed.versions[0].artifactValid, true);
  assert.equal(listed.versions[0].pngPath, undefined);
  const awaitingAdoption = await api.getComposition(created.documentId);
  assert.equal(awaitingAdoption.layers[0].versionId, 'version-fixture');
  assert.equal(awaitingAdoption.states['review-layer'].status, 'ready');
  assert.deepEqual(awaitingAdoption.states['review-layer'].versionIds, ['version-fixture']);
  const adopted = await api.adoptCandidate({ documentId: created.documentId, expectedRevision: layered.revision,
    layerId: 'review-layer', versionId: version.versionId });
  assert.equal(adopted.layers['review-layer'].acceptedVersionId, version.versionId);
  assert.equal(adopted.layers['review-layer'].layerRevision, layered.layers['review-layer'].layerRevision);
  const composition = await api.getComposition(created.documentId);
  assert.equal(composition.states['review-layer'].status, 'ready');
  assert.equal(composition.documentRevision, adopted.revision);
  assert.deepEqual(composition.layers.map(layer => [layer.layerId, layer.versionId, layer.placement]),
    [['review-layer', version.versionId, { x: 0, y: 0 }]]);
  assert.deepEqual(await api.readCandidatePng({ documentId: created.documentId, layerId: 'review-layer', versionId: version.versionId }), source);
  const middleware = workbenchV2Middleware({ root: documentsRoot });
  const server = createHttpServer((request, response) => middleware(request, response, () => { response.statusCode = 404; response.end(); }));
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const candidateUrl = `http://127.0.0.1:${server.address().port}/api/workbench-v2/documents/${created.documentId}/layers/review-layer/versions/${version.versionId}/png`;
  const previewResponse = await fetch(candidateUrl);
  assert.equal(previewResponse.headers.get('content-disposition'), null);
  const response = await fetch(`${candidateUrl}?download=1`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-disposition'), 'attachment; filename="version-fixture.png"');
  assert.equal(response.headers.get('content-type'), 'image/png');
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
  const exported = await api.exportDocumentPsd({ documentId: created.documentId, expectedRevision: adopted.revision });
  assert.equal(exported.documentRevision, adopted.revision);
  assert.equal(exported.layerCount, 1);
  assert.equal((await api.readExportPsd({ documentId: created.documentId, exportId: exported.exportId })).bytes.subarray(0, 4).toString(), '8BPS');
  const edited = applyLayerEdit(adopted, 'review-layer', { requirements: 'new text pixels' });
  await api.saveDocument(edited, adopted.revision);
  assert.equal((await api.listExports(created.documentId)).exports[0].stale, true);
  await assert.rejects(api.adoptCandidate({ documentId: created.documentId, expectedRevision: edited.revision,
    layerId: 'review-layer', versionId: version.versionId }), /CANDIDATE_NOT_CURRENT/);
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
  assert.deepEqual(await fetch(`${base}/documents/${document.documentId}/exports`).then(response=>response.json()),{exports:[]});
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
