import test from 'node:test';
import assert from 'node:assert/strict';
import { readPageIdentity, persistPageIdentity } from './page-identity.js';

test('the document in a shared V2 URL wins over unrelated tab storage; restoring updates session too', () => {
  const data = new Map([['imvia-layer-v2-document','old-doc'],['imvia-layer-v2-session','old-session']]);
  const storage = { getItem:key=>data.get(key), setItem:(key,value)=>data.set(key,value), removeItem:key=>data.delete(key) };
  let url = 'http://127.0.0.1:4173/?open=legacy&workbench=v2&documentId=new-doc&workspaceId=workspace-one';
  const identity = readPageIdentity(url, storage);
  assert.equal(identity.documentId, 'new-doc');
  assert.equal(identity.workspaceId, 'workspace-one');
  url = persistPageIdentity(url, storage, { documentId:'new-doc',workbenchSessionId:'new-session' }, identity.workspaceId);
  assert.equal(new URL(url).searchParams.get('documentId'), 'new-doc');
  assert.equal(data.get('imvia-layer-v2-session'), 'new-session');
  const empty = persistPageIdentity(url, storage, null, identity.workspaceId);
  assert.equal(new URL(empty).searchParams.has('documentId'), false);
  assert.equal(data.has('imvia-layer-v2-document'), false);
  assert.equal(new URL(empty).searchParams.get('workspaceId'), 'workspace-one');
});

test('opening without a document never restores the previous document, workspace or session', () => {
  const data = new Map([['imvia-layer-v2-document','existing-doc'], ['imvia-layer-v2-workspace','old-workspace'], ['imvia-layer-v2-session','old-session']]);
  const storage = { getItem:key=>data.get(key),setItem:(key,value)=>data.set(key,value),removeItem:key=>data.delete(key) };
  const first = readPageIdentity('http://127.0.0.1:4173/?open=old', storage);
  assert.equal(first.documentId, null);
  assert.ok(first.workspaceId);
  assert.ok(first.workbenchSessionId);
  assert.notEqual(first.workspaceId, 'old-workspace');
  assert.notEqual(first.workbenchSessionId, 'old-session');
  const second = readPageIdentity('http://127.0.0.1:4173/?workbench=v2&open=next', storage);
  assert.equal(second.documentId, null);
  assert.notEqual(second.workspaceId, first.workspaceId);
  assert.notEqual(second.workbenchSessionId, first.workbenchSessionId);
});

test('a fresh bridge and empty page keep the URL session through upload and reload', () => {
  const data = new Map([['imvia-layer-v2-document','old-doc'], ['imvia-layer-v2-session','old-session']]);
  const storage = { getItem:key=>data.get(key),setItem:(key,value)=>data.set(key,value),removeItem:key=>data.delete(key) };
  const url = 'http://127.0.0.1:4173/?workbench=v2&workspaceId=fresh-workspace&workbenchSessionId=fresh-session';
  const identity = readPageIdentity(url, storage);
  assert.deepEqual(identity, { documentId:null, workspaceId:'fresh-workspace', workbenchSessionId:'fresh-session' });
  const empty = persistPageIdentity(url, storage, null, identity.workspaceId, identity.workbenchSessionId);
  assert.deepEqual(readPageIdentity(empty, storage), identity);
  const saved = persistPageIdentity(empty, storage, { documentId:'uploaded', workbenchSessionId:'fresh-session' }, identity.workspaceId);
  assert.equal(readPageIdentity(saved, storage).documentId, 'uploaded');
  assert.equal(readPageIdentity(saved, storage).workbenchSessionId, 'fresh-session');
});
