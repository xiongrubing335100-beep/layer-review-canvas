import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import lockfile from 'proper-lockfile';
import { currentProcessingPolicy } from './processing-policy.js';
import { candidateMatches, geometryReview } from './candidate-review.js';
import { freezeLayer } from './document.js';
import { listV2CandidateVersions, reprocessArchivedV2Candidate } from './candidate-store.js';

function keyFor(version, policy) {
  return createHash('sha256').update(JSON.stringify([version.versionId, version.sha256, version.snapshotId,
    policy.version, policy.processorSha256, policy.itemContractSha256])).digest('hex');
}
async function receiptAt(file) {
  try { return JSON.parse(await readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
const failureMessage = code => code === 'ENOENT' ? '补验所需的原始蒙版或证据文件缺失。恢复文件后可重试本地补验。'
  : /BINDING|MAPPING|FINGERPRINT|CHANGED/.test(code) ? '原图、选区或证据与历史记录不一致，已停止补验，原文件保留。'
    : `本地补验未完成（${code}），可重试；不会重新调用图像模型。`;

function requiresRevalidation(layer, version, policy) {
  const status = geometryReview(layer, version).status;
  if (['validation_pending', 'validation_failed'].includes(status)) return true;
  // A code fix need not change the public policy version. Reuse immutable
  // evidence once for the new processor, not the same failed algorithm on
  // every refresh. Already delivered results remain stable and downloadable.
  return status === 'quality_failed' && Boolean(version.processingPolicy?.processorSha256)
    && version.pixelAudit?.maskProvider === 'imagegen_matte'
    && layer.strategy?.operation === 'extract'
    && version.processingPolicy.processorSha256 !== policy.processorSha256;
}

export function createCandidateRevalidation({ root }) {
  const receiptPath = (documentId, key) => path.join(root, 'revalidations', documentId, key, 'result.json');
  return {
    async decorate(document, versions) {
      const policy = await currentProcessingPolicy();
      return Promise.all(versions.map(async version => {
        if (!document.layers[version.layerId] || !requiresRevalidation(document.layers[version.layerId], version, policy)) return version;
        const receipt = await receiptAt(receiptPath(document.documentId, keyFor(version, policy)));
        return receipt?.status === 'failed' ? { ...version, validationRecovery: receipt } : version;
      }));
    },
    async run({ document, attempts, versions, layerId = null, retry = false }) {
      const policy = await currentProcessingPolicy(); const results = [];
      for (const id of document.layerOrder.filter(id => !layerId || id === layerId)) {
        const layer = document.layers[id], snapshotId = freezeLayer(document, id).snapshotId;
        const matching = versions.filter(v => candidateMatches(document, layer, v, snapshotId, false))
          .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
        const version = matching[0];
        if (!version || !requiresRevalidation(layer, version, policy)) continue;
        const key = keyFor(version, policy), file = receiptPath(document.documentId, key), directory = path.dirname(file);
        await mkdir(directory, { recursive: true });
        const release = await lockfile.lock(directory, { realpath: false, retries: { retries: 100, minTimeout: 50, maxTimeout: 250 } });
        try {
          // Re-read after the cross-process lock: another request may have completed already.
          const saved = await receiptAt(file);
          const latest = await listV2CandidateVersions({ root, attempts, documentId: document.documentId, layerId: id });
          const existing = latest.find(v => v.revalidation?.key === key && v.artifactValid);
          if (existing) { results.push({ layerId: id, status: 'completed', versionId: existing.versionId, reused: true }); continue; }
          if (saved?.status === 'failed' && !retry) { results.push(saved); continue; }
          let result;
          try {
            const candidate = await reprocessArchivedV2Candidate({ root, document,
              attempt: attempts.find(a => a.attemptId === version.attemptId), version, key });
            result = { layerId: id, status: 'completed', versionId: candidate.versionId, checkedAt: new Date().toISOString() };
          } catch (error) {
            const code = error.code || error.message.split(':')[0];
            result = { layerId: id, status: 'failed', code, message: failureMessage(code), checkedAt: new Date().toISOString() };
          }
          const temporary = path.join(directory, `${randomUUID()}.tmp`);
          try { await writeFile(temporary, JSON.stringify(result)); await rename(temporary, file); }
          finally { await rm(temporary, { force: true }); }
          results.push(result);
        } finally { await release(); }
      }
      return { documentId: document.documentId, results };
    },
  };
}
