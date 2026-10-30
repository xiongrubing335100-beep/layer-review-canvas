import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createDocument, addLayer, applyLayerEdit } from './document.js';
import { createDocumentStore } from './document-store.js';
import * as saving from './document-saving.js';

const initial = () => createDocument({ documentId:'save-doc', workbenchSessionId:'save-session', mode:'poster',
  source:{path:'/source.png',width:200,height:100,fingerprint:'original',revision:1} });
const edited = () => addLayer(initial(), { layerId:'title', name:'标题', displayCategory:'主标题', processingCategory:'text',
  bounds:{x:10,y:20,width:100,height:40}, paths:[], requirements:'保留文字' });

test('refresh recovers all unacknowledged edits in order, without changing their revisions', () => {
  const first=edited(), second=applyLayerEdit(first,'title',{name:'保留此名称'});
  const result=saving.recoverPendingSaves(initial(),[first,second]);
  assert.equal(result.document.layers.title.name,'保留此名称');
  assert.deepEqual(result.queue,[first,second]);
});

test('refresh recognizes a committed response lost on the network and keeps subsequent edits', () => {
  const first=edited(), second=applyLayerEdit(first,'title',{name:'后续修改'});
  assert.deepEqual(saving.recoverPendingSaves(first,[first,second]),{document:second,queue:[second]});
});

test('pending recovery refuses divergent server changes and a different source or document', () => {
  const first=edited(), second=applyLayerEdit(first,'title',{name:'本地'});
  const remote=applyLayerEdit(first,'title',{name:'另一窗口'});
  assert.throws(()=>saving.recoverPendingSaves(remote,[first,second]),/SAVE_CONFLICT/);
  assert.throws(()=>saving.recoverPendingSaves(initial(),[{...first,documentId:'other'}]),/SAVE_CONFLICT/);
  assert.throws(()=>saving.recoverPendingSaves(initial(),[{...first,source:{...first.source,fingerprint:'replacement'}}]),/SAVE_CONFLICT/);
});

test('a lost save response is reconciled against the real store without writing twice', async t => {
  const root=await mkdtemp(path.join(os.tmpdir(),'imvia-save-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  const store=createDocumentStore({root}); await store.create(initial());
  const next=edited();
  const saved=await saving.saveDocumentRevision({
    async saveDocument(document,expectedRevision) { await store.update({documentId:document.documentId,document,expectedRevision}); throw new Error('Network response lost'); },
    getDocument:id=>store.read(id),
  },next);
  assert.deepEqual(saved,next);
  assert.deepEqual(await store.read(next.documentId),next);
});

test('failed persistence never acknowledges uncommitted edits or a different server document', async () => {
  await assert.rejects(saving.saveDocumentRevision({async saveDocument(){throw new Error('offline');},async getDocument(){return initial();}},edited()),/offline/);
  await assert.rejects(saving.saveDocumentRevision({async saveDocument(){return {...edited(),documentId:'other'};},async getDocument(){return initial();}},edited()),/SAVE_RESPONSE_MISMATCH/);
});
