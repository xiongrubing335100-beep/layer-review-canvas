import { mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import lockfile from 'proper-lockfile';
import { idSchema, validateDocument, replaceDocumentSource } from './document.js';
import { canonicalJson } from '../poster-plan.js';

function fail(code) { return Object.assign(new Error(code), { code }); }

export function createDocumentStore({ root }) {
  const directory = id => path.join(root, idSchema.parse(id));
  async function read(id) {
    return validateDocument(JSON.parse(await readFile(path.join(directory(id), 'document.json'), 'utf8')));
  }
  async function locked(id, fn) {
    const dir = directory(id);
    await mkdir(dir, { recursive: true });
    const release = await lockfile.lock(dir, { realpath: false, retries: { retries: 20, minTimeout: 5, maxTimeout: 50 } });
    try { return await fn(dir); } finally { await release(); }
  }
  async function archive(dir, document) {
    const target = path.join(dir, `revision-${document.revision}.json`);
    try { await writeFile(target, JSON.stringify(document), { flag: 'wx' }); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (canonicalJson(JSON.parse(await readFile(target, 'utf8'))) !== canonicalJson(document)) throw fail('HISTORY_CONFLICT');
    }
  }
  async function publish(dir, document) {
    const temp = path.join(dir, `${randomUUID()}.tmp`);
    try { await writeFile(temp, JSON.stringify(document)); await rename(temp, path.join(dir, 'document.json')); }
    finally { await rm(temp, { force: true }); }
    return document;
  }
  return {
    read,
    async replaceSource({ documentId, expectedRevision, source }) {
      return locked(documentId, async dir => {
        const current = await read(documentId);
        if (current.revision !== expectedRevision) throw fail('REVISION_CONFLICT');
        const next = replaceDocumentSource(current, source);
        await archive(dir, current);
        return publish(dir, next);
      });
    },
    async create(input) {
      const document = validateDocument(input);
      return locked(document.documentId, async dir => {
        try { await read(document.documentId); throw fail('DOCUMENT_EXISTS'); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
        await archive(dir, document);
        return publish(dir, document);
      });
    },
    async update({ documentId, expectedRevision, document: input }) {
      const next = validateDocument(input);
      return locked(documentId, async dir => {
        const current = await read(documentId);
        if (current.revision !== expectedRevision) throw fail('REVISION_CONFLICT');
        if (next.documentId !== documentId || next.workbenchSessionId !== current.workbenchSessionId || next.mode !== current.mode) throw fail('IDENTITY_IMMUTABLE');
        if (canonicalJson(next.source) !== canonicalJson(current.source)) throw fail('SOURCE_IMMUTABLE');
        if (next.revision !== expectedRevision + 1) throw fail('INVALID_REVISION');
        await archive(dir, current);
        return publish(dir, next);
      });
    },
  };
}
