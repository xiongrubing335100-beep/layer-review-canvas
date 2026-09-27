import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { createDocumentStore } from './document-store.js';
import { createDocument, validateDocument, idSchema } from './document.js';
import { readPosterPngBytes } from '../poster-png.js';

function error(code, message = code) { return Object.assign(new Error(message), { code }); }

export function createWorkbenchV2Api({ root }) {
  const documentsRoot = path.resolve(root);
  const store = createDocumentStore({ root: documentsRoot });
  return {
    async createDocument({ mode, bytes, workbenchSessionId }) {
      if (!['poster', 'h5'].includes(mode)) throw error('INVALID_MODE');
      idSchema.parse(workbenchSessionId);
      const png = Buffer.from(bytes);
      const decoded = readPosterPngBytes(png, 'source');
      const documentId = randomUUID().replaceAll('-', '');
      const sourcePath = path.join(documentsRoot, documentId, 'source.png');
      await mkdir(path.dirname(sourcePath), { recursive: true });
      await writeFile(sourcePath, png, { flag: 'wx' });
      const source = { path: sourcePath, width: decoded.width, height: decoded.height,
        fingerprint: createHash('sha256').update(png).digest('hex'), revision: 1 };
      try { return await store.create(createDocument({ documentId, workbenchSessionId, mode, source })); }
      catch (cause) { await rm(sourcePath, { force: true }); throw cause; }
    },
    getDocument(id) { return store.read(idSchema.parse(id)); },
    saveDocument(document, expectedRevision) {
      return store.update({ documentId: document.documentId, expectedRevision, document: validateDocument(document) });
    },
    async readSource(id) {
      const document = await store.read(idSchema.parse(id));
      return readFile(document.source.path);
    },
  };
}

async function readBody(request, maximum = 32 * 1024 * 1024) {
  const chunks = []; let size = 0;
  for await (const chunk of request) { size += chunk.length; if (size > maximum) throw error('BODY_TOO_LARGE'); chunks.push(chunk); }
  return Buffer.concat(chunks);
}

export function workbenchV2Middleware({ root }) {
  const api = createWorkbenchV2Api({ root });
  return async (request, response, next) => {
    const url = new URL(request.url || '/', 'http://127.0.0.1');
    if (!url.pathname.startsWith('/api/workbench-v2/')) { next(); return; }
    response.setHeader('Access-Control-Allow-Origin', '*');
    response.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS');
    response.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Workbench-Mode, X-Workbench-Session');
    if (request.method === 'OPTIONS') { response.statusCode = 204; response.end(); return; }
    try {
      let result; let status = 200;
      if (url.pathname === '/api/workbench-v2/documents' && request.method === 'POST') {
        if (String(request.headers['content-type'] || '').split(';')[0] !== 'image/png') throw error('INVALID_IMAGE_TYPE');
        result = await api.createDocument({ mode: request.headers['x-workbench-mode'],
          workbenchSessionId: request.headers['x-workbench-session'], bytes: await readBody(request) }); status = 201;
      } else {
        const source = url.pathname.match(/^\/api\/workbench-v2\/documents\/([A-Za-z0-9_-]+)\/source$/);
        const document = url.pathname.match(/^\/api\/workbench-v2\/documents\/([A-Za-z0-9_-]+)$/);
        if (source && request.method === 'GET') {
          const bytes = await api.readSource(source[1]); response.setHeader('Content-Type', 'image/png'); response.setHeader('Cache-Control', 'private, max-age=3600'); response.end(bytes); return;
        }
        if (!document) throw error('NOT_FOUND');
        if (request.method === 'GET') result = await api.getDocument(document[1]);
        else if (request.method === 'PUT') {
          const payload = JSON.parse((await readBody(request)).toString('utf8'));
          result = await api.saveDocument(payload.document, Number(payload.expectedRevision));
        } else throw error('METHOD_NOT_ALLOWED');
      }
      response.statusCode = status; response.setHeader('Content-Type', 'application/json; charset=utf-8'); response.end(JSON.stringify(result));
    } catch (cause) {
      response.statusCode = cause.code === 'REVISION_CONFLICT' ? 409 : cause.code === 'NOT_FOUND' ? 404 : cause.code === 'METHOD_NOT_ALLOWED' ? 405 : 400;
      response.setHeader('Content-Type', 'application/json; charset=utf-8'); response.end(JSON.stringify({ error: cause.code || 'INVALID_REQUEST', message: cause.message }));
    }
  };
}
