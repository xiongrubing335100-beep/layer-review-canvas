import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createLayerReviewBridgeServer } from '../layer-review-mcp-server.mjs';
import { jobMatchesSource, posterCandidateViewModel, reconcileTurnStatus, resolveExecutionReportStatus } from './job-state.js';
import { posterCandidateReviewModel } from './poster-candidate-review-model.js';

function rejectedJob() {
  return {
    plan: { status: 'PLAN_CONFIRMED', plan_version: 2, layers: [{ layer_index: 1, layer_name: '花束' }] },
    manifest: {
      layers: [{ layer_index: 1, status: 'HARD_REJECTED', visual_inspection: { candidate_id: 'current' } }],
      candidates: [
        { candidate_id: 'stale', layer_index: 1, plan_version: 1, status: 'NEEDS_USER_REVIEW', path: '/stale.png' },
        { candidate_id: 'current', layer_index: 1, plan_version: 2, status: 'HARD_REJECTED', path: '/candidate.png',
          failure_codes: ['CANVAS_OR_GREEN_FIELD_INVALID'],
          dimensions: { width: 852, height: 1846, expected_width: 1848, expected_height: 4000 } },
      ],
    },
  };
}

test('retained Task 7 MCP candidate contract forwards exact fast bindings and preserves the legacy high-quality payload', async t => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'imvia-task7-contract-'));
  let server;
  let client;
  t.after(async () => {
    await client?.close(); await server?.close();
    await rm(temporaryRoot, { recursive: true, force: true });
  });
  const requests = [];
  server = createLayerReviewBridgeServer({
    environment: { IMVIA_FEATURE_POSTER_LAYERING_MODE: '1' },
    v2BridgeRoot: path.join(temporaryRoot, 'bridge-requests'),
    requestWorkbenchJsonImpl: async (pathname, options) => {
      requests.push({ pathname, method: options.method, body: JSON.parse(options.body) });
      return rejectedJob();
    },
  });
  client = new Client({ name: 'task7-contract-test', version: '1' });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const { tools } = await client.listTools();
  for (const name of ['submit_layer_review_job', 'submit_poster_layer_analysis', 'submit_poster_layer_candidate', 'connect_layer_review_workbench']) {
    assert.ok(tools.some(tool => tool.name === name), `${name} remains callable`);
  }
  const common = { explicitAuthorization: true, expectedManifestRevision: 3, planVersion: 2 };
  const targeted = { ...common, planningMode: 'targeted_fast',
    layerSnapshot: { snapshot_id: 'snapshot-1', layer_index: 1, user_confirmed: true },
    snapshotId: 'snapshot-1', authorizationId: 'authorization-1', processingCategory: 'subject' };
  for (const payload of [targeted, common]) {
    const result = await client.callTool({ name: 'submit_poster_layer_candidate',
      arguments: { jobId: 'poster-job-1', layerIndex: 1, ...payload } });
    assert.equal(result.isError, undefined, JSON.stringify(result.content));
    assert.deepEqual(result.structuredContent, rejectedJob());
  }
  assert.deepEqual(requests, [targeted, common].map(body => ({
    pathname: '/api/poster-layer/jobs/poster-job-1/candidates/1', method: 'POST', body,
  })));
});

test('retained Task 7 rejected candidate facts reach the Chinese review model without enabling acceptance', () => {
  const view = posterCandidateViewModel(rejectedJob(), 1);
  assert.equal(view.candidateId, 'current');
  assert.equal(view.canAccept, false);
  assert.deepEqual(view.diagnosticCandidates.map(candidate => candidate.candidateId), ['stale']);
  const review = posterCandidateReviewModel({ ...view.review, canAccept: view.canAccept, canRetry: view.canRetry });
  assert.deepEqual(review.actions.map(action => action.id), ['retry']);
  assert.equal(review.preview.downloadable, false);
  assert.equal(review.failures[0].technicalCode, 'CANVAS_OR_GREEN_FIELD_INVALID');
  assert.match(review.failures[0].message, /候选画布/);
  assert.deepEqual(review.failures[0].facts, ['实际画布：852 × 1846 px', '要求画布：1848 × 4000 px']);
});

test('retained Task 7 job reconciliation separates source identity and requires validated PNGs for completion', () => {
  const source = { imageId: 'current', sourceFingerprint: 'current-source', sourceRevision: 1 };
  assert.equal(jobMatchesSource({ ...source }, source), true);
  assert.equal(jobMatchesSource({ ...source, imageId: 'other', sourceFingerprint: 'other-source' }, source), false);
  const report = { status: 'completed', validation_results: {
    count: true, dimensions: true, alpha: true, annotation_conformance: true, obvious_exclusion: true,
  } };
  const reportStatus = resolveExecutionReportStatus(report, { expectedCount: 1, resultReady: true });
  assert.equal(reportStatus, 'completed');
  assert.equal(resolveExecutionReportStatus(report, { expectedCount: 1, resultReady: false }), null);
  assert.equal(reconcileTurnStatus({ planStatus: 'sent_to_codex', reportStatus, turnStatus: 'completed',
    resultReady: true, imageCount: 1 }).status, 'completed');
  assert.equal(reconcileTurnStatus({ planStatus: 'sent_to_codex', turnStatus: 'completed',
    resultReady: false, imageCount: 0 }).status, 'failed');
});
