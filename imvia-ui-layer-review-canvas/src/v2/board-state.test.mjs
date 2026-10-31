import test from 'node:test';
import assert from 'node:assert/strict';
import { buildBoardNodes, moveBoardNodes, boardStorageKey, restoreBoard, saveBoard, zoomBoard, selectBoardRect, fitBoard } from './board-state.js';
import { createDocument, addLayer, freezeLayer } from './document.js';

const fixture = () => addLayer(createDocument({ documentId:'doc',workbenchSessionId:'session',mode:'poster',
  source:{path:'/source.png',width:1000,height:2000,fingerprint:'test',revision:1} }), {
  layerId:'title',name:'标题',displayCategory:'主标题',processingCategory:'text',bounds:{x:100,y:200,width:400,height:100},
});

test('moving board nodes freely never changes extraction bounds, frozen identity, or export source geometry', () => {
  const document = fixture(), before = structuredClone(document), snapshot = freezeLayer(document,'title');
  const nodes = buildBoardNodes(document);
  const positions = moveBoardNodes({},nodes,['source','layer:title'],{x:-600,y:240});
  assert.deepEqual(positions, {source:{x:-520,y:340},'layer:title':{x:-110,y:340}});
  assert.deepEqual(buildBoardNodes(document,{},positions)[1].bounds,{x:100,y:200,width:400,height:100});
  assert.deepEqual(document,before); assert.deepEqual(freezeLayer(document,'title'),snapshot);
});

test('board shows the delivered result, not every diagnostic version', () => {
  const nodes = buildBoardNodes(fixture(),{title:{versions:[{versionId:'good',artifactValid:true},{versionId:'bad',artifactValid:false}],state:{status:'ready',versionIds:['good'],resultVersionId:'good'}}});
  assert.equal(nodes.length,3);
  assert.equal(nodes[2].parent,'layer:title'); assert.equal(nodes[2].versionId,'good');
  assert.equal(nodes[2].adopted,true); assert.equal(nodes[2].current,true);
  assert.deepEqual(buildBoardNodes(null),[]);
});

test('layout survives a same-workspace refresh but never leaks into another opening or source document', () => {
  const values = new Map(), storage = {getItem:key=>values.get(key),setItem:(key,value)=>values.set(key,value)};
  const key = boardStorageKey('workspace','session','doc');
  const board = {viewport:{x:50,y:-60,scale:.5},positions:{source:{x:-100,y:500}},groups:[{id:'g',name:'分组',keys:['source','layer:title']}]};
  saveBoard(storage,key,board);
  assert.deepEqual(restoreBoard(storage,key),board);
  for(const next of [boardStorageKey('fresh','session','doc'),boardStorageKey('workspace','fresh','doc'),boardStorageKey('workspace','session','other')]) {
    assert.deepEqual(restoreBoard(storage,next),{viewport:{x:0,y:0,scale:1},positions:{},groups:[]});
  }
  assert.deepEqual(restoreBoard({getItem:()=>'{broken'},key).positions,{});
});

test('zoom anchors the pointer, marquee selects intersecting nodes, and fit makes the whole board visible', () => {
  assert.deepEqual(zoomBoard({x:100,y:40,scale:1},{x:200,y:100},2),{x:0,y:-20,scale:2});
  const nodes=buildBoardNodes(fixture());
  assert.deepEqual(selectBoardRect(nodes,{x:480,y:90,width:300,height:260}),['layer:title']);
  const view=fitBoard(nodes,{width:1000,height:700});
  for(const n of nodes) {
    assert.ok(n.x*view.scale+view.x>=0); assert.ok(n.y*view.scale+view.y>=0);
    assert.ok((n.x+n.width)*view.scale+view.x<=1000); assert.ok((n.y+n.height)*view.scale+view.y<=700);
  }
});
