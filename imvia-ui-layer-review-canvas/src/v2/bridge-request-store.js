import { mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import lockfile from 'proper-lockfile';
import { idSchema } from './document.js';
import { canonicalJson } from '../poster-plan.js';

export function createBridgeRequestStore({ root }) {
  const target = id => path.join(root, `${idSchema.parse(id)}.json`);
  const read = async id => JSON.parse(await readFile(target(id), 'utf8'));
  async function locked(fn) {
    await mkdir(root, { recursive: true });
    const release = await lockfile.lock(root, { realpath: false, retries: { retries: 20, minTimeout: 5, maxTimeout: 50 } });
    try { return await fn(); } finally { await release(); }
  }
  async function write(record) {
    const temp = path.join(root, `${randomUUID()}.tmp`);
    try { await writeFile(temp, JSON.stringify(record)); await rename(temp, target(record.requestId)); }
    finally { await rm(temp, { force: true }); }
    return record;
  }
  return { read,
    async create({ batchId, envelope }) {
      idSchema.parse(batchId); idSchema.parse(envelope.workbenchSessionId);
      const normalized = JSON.parse(canonicalJson(envelope));
      const envelopeSha256 = createHash('sha256').update(canonicalJson(normalized)).digest('hex');
      return locked(async () => {
        try {
          const existing = await read(batchId);
          if (existing.envelopeSha256 !== envelopeSha256) throw new Error('BINDING_MISMATCH');
          return existing;
        } catch (error) { if (error.code !== 'ENOENT') throw error; }
        return write({ requestId: batchId, batchId, workbenchSessionId: envelope.workbenchSessionId,
          envelopeSha256, envelope: normalized, status: 'pending', deliveredAt: null, confirmedAt: null });
      });
    },
    async transition({ requestId, expectedStatus, nextStatus, receipt }) {
      return locked(async () => {
        const record = await read(requestId);
        if (nextStatus === 'sent') {
          if (!receipt || receipt.workbenchSessionId !== record.workbenchSessionId || receipt.envelopeSha256 !== record.envelopeSha256) throw new Error('RECEIPT_MISMATCH');
          if (record.status === 'sent') return record;
        }
        if (record.status !== expectedStatus) throw new Error('REQUEST_STATE_CONFLICT');
        const allowed = { pending: ['claimed', 'cancelled'], claimed: ['sent', 'cancelled'], sent: [], cancelled: [] };
        if (!allowed[record.status]?.includes(nextStatus)) throw new Error('REQUEST_TERMINAL');
        const now = new Date().toISOString();
        return write({ ...record, status: nextStatus,
          ...(nextStatus === 'sent' ? { deliveredAt: now, confirmedAt: now } : {}) });
      });
    },
  };
}
