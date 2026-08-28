import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildPosterCandidateSubmissionPayload,
  createLayerReviewBridgeServer,
} from '../layer-review-mcp-server.mjs';
import * as posterHost from './poster-workbench-host.js';

test('poster analysis uses a dedicated MCP app tool', async () => {
  const calls = [];
  await posterHost.submitPosterAnalysis({ job_id: 'poster-job-1' }, undefined, {
    isMcpHost: () => true,
    callTool: async (...args) => calls.push(args),
  });
  assert.deepEqual(calls[0], ['submit_poster_layer_analysis', {
    plan: { job_id: 'poster-job-1' },
  }]);
});

test('standalone poster host uses its dedicated analysis endpoint', async () => {
  const previousLocation = globalThis.location;
  globalThis.location = new URL('http://127.0.0.1:4175/workbench');
  const requests = [];
  try {
    await posterHost.submitPosterAnalysis({ job_id: 'poster-job-1' }, async (url, options) => {
      requests.push({ url, options });
      return { ok: true, json: async () => ({ job_id: 'poster-job-1', status: 'ANALYZING' }) };
    });
    assert.equal(requests[0].url, 'http://127.0.0.1:4175/api/poster-layer/jobs/analyze');
    assert.equal(requests[0].options.method, 'POST');
    assert.deepEqual(JSON.parse(requests[0].options.body), { plan: { job_id: 'poster-job-1' } });
  } finally {
    if (previousLocation === undefined) delete globalThis.location;
    else globalThis.location = previousLocation;
  }
});

test('fast plan creation is local and does not call the analysis tool', async () => {
  const calls = [];
  const requests = [];
  await posterHost.submitPosterFastJob({ job_id: 'poster-fast-1' }, async (url, options) => {
    requests.push({ url, options });
    return { ok: true, json: async () => ({ job_id: 'poster-fast-1' }) };
  }, {
    isMcpHost: () => true,
    callTool: async (...args) => calls.push(args),
  });
  assert.equal(calls.length, 0);
  assert.equal(requests[0].url, 'http://127.0.0.1:4173/api/poster-layer/jobs/fast');
  assert.deepEqual(JSON.parse(requests[0].options.body), { plan: { job_id: 'poster-fast-1' } });
});

test('targeted candidate payload binds one snapshot to one layer', async () => {
  const requests = [];
  await posterHost.submitPosterTargetedCandidate('poster-fast-1', 3, {
    snapshot: { snapshot_id: 'snap-3', layer_index: 3 },
    authorizationId: 'poster-fast-1:1:3:1', expectedManifestRevision: 2, planVersion: 1,
  }, async (url, options) => { requests.push({ url, options }); return { ok: true, json: async () => ({}) }; });
  const body = JSON.parse(requests[0].options.body);
  assert.equal(body.planning_mode, 'targeted_fast');
  assert.equal(body.layer_snapshot.layer_index, 3);
  assert.equal(body.authorization_id, 'poster-fast-1:1:3:1');
});

test('targeted candidate uses the existing MCP candidate tool with its exact targeted bindings', async () => {
  const calls = [];
  const snapshot = { snapshot_id: 'snap-3', layer_index: 3, user_confirmed: true };
  await posterHost.submitPosterTargetedCandidate('poster-fast-1', 3, {
    snapshot, authorizationId: 'poster-fast-1:1:3:1', expectedManifestRevision: 2, planVersion: 1,
  }, undefined, {
    isMcpHost: () => true,
    callTool: async (...args) => calls.push(args),
  });

  assert.deepEqual(calls, [['submit_poster_layer_candidate', {
    jobId: 'poster-fast-1', layerIndex: 3,
    planningMode: 'targeted_fast', planning_mode: 'targeted_fast',
    layerSnapshot: snapshot, layer_snapshot: snapshot,
    snapshotId: 'snap-3', snapshot_id: 'snap-3',
    authorizationId: 'poster-fast-1:1:3:1', authorization_id: 'poster-fast-1:1:3:1',
    expectedManifestRevision: 2, expected_manifest_revision: 2,
    planVersion: 1, plan_version: 1, explicit_authorization: true,
  }]]);
  assert.equal(calls.some(([toolName]) => toolName === 'submit_poster_layer_analysis'), false);
});

test('candidate MCP payload forwards exact targeted fields and omits them for high quality', () => {
  const snapshot = { snapshot_id: 'snap-3', layer_index: 3, user_confirmed: true };
  assert.deepEqual(buildPosterCandidateSubmissionPayload({
    explicit_authorization: true, expectedManifestRevision: 2, planVersion: 1,
    planningMode: 'targeted_fast', layerSnapshot: snapshot, snapshotId: 'snap-3',
    authorizationId: 'poster-fast-1:1:3:1', processingCategory: 'subject',
  }), {
    explicit_authorization: true, expectedManifestRevision: 2, planVersion: 1,
    planningMode: 'targeted_fast', layerSnapshot: snapshot, snapshotId: 'snap-3',
    authorizationId: 'poster-fast-1:1:3:1', processingCategory: 'subject',
  });
  assert.deepEqual(buildPosterCandidateSubmissionPayload({
    explicitAuthorization: true, expectedManifestRevision: 8, planVersion: 4,
  }), {
    explicitAuthorization: true, expectedManifestRevision: 8, planVersion: 4,
  });
});

test('registered candidate MCP handler posts exact targeted fields and omits them for high quality', async () => {
  const requests = [];
  const server = createLayerReviewBridgeServer({
    environment: { IMVIA_FEATURE_POSTER_LAYERING_MODE: '1' },
    requestWorkbenchJsonImpl: async (pathname, options) => {
      requests.push({ pathname, body: JSON.parse(options.body) });
      return { status: 'queued' };
    },
  });
  server.setToolRequestHandlers();
  const call = server.server._requestHandlers.get('tools/call');
  const snapshot = { snapshot_id: 'snap-3', layer_index: 3, user_confirmed: true };

  await call({ method: 'tools/call', params: { name: 'submit_poster_layer_candidate', arguments: {
    jobId: 'poster-fast-1', layerIndex: 3, explicitAuthorization: true, expectedManifestRevision: 2,
    planVersion: 1, planningMode: 'targeted_fast', layerSnapshot: snapshot, snapshotId: 'snap-3',
    authorizationId: 'poster-fast-1:1:3:1', processingCategory: 'subject',
  } } }, {});
  await call({ method: 'tools/call', params: { name: 'submit_poster_layer_candidate', arguments: {
    jobId: 'poster-quality-1', layerIndex: 2, explicitAuthorization: true, expectedManifestRevision: 8, planVersion: 4,
  } } }, {});

  assert.deepEqual(requests, [
    {
      pathname: '/api/poster-layer/jobs/poster-fast-1/candidates/3',
      body: {
        explicitAuthorization: true, expectedManifestRevision: 2, planVersion: 1,
        planningMode: 'targeted_fast', layerSnapshot: snapshot, snapshotId: 'snap-3',
        authorizationId: 'poster-fast-1:1:3:1', processingCategory: 'subject',
      },
    },
    {
      pathname: '/api/poster-layer/jobs/poster-quality-1/candidates/2',
      body: { explicitAuthorization: true, expectedManifestRevision: 8, planVersion: 4 },
    },
  ]);
});

test('candidate acceptance uses the dedicated MCP tool with exact optimistic binding', async () => {
  const calls = [];
  await posterHost.acceptPosterCandidate('poster-job-1', 3, 'candidate-3', 8, undefined, {
    isMcpHost: () => true,
    callTool: async (...args) => calls.push(args),
  });

  assert.deepEqual(calls, [['accept_poster_layer_candidate', {
    jobId: 'poster-job-1', layerIndex: 3, candidateId: 'candidate-3', expectedManifestRevision: 8,
  }]]);
});

test('standalone acceptance, retry, and raw postprocess call local state-only routes', async () => {
  const requests = [];
  const fetchImpl = async (url, options) => {
    requests.push({ url, options });
    return { ok: true, json: async () => ({ job_id: 'poster-job-1' }) };
  };

  await posterHost.acceptPosterCandidate('poster-job-1', 3, 'candidate-3', 8, fetchImpl);
  await posterHost.authorizePosterRetry('poster-job-1', 3, 9, fetchImpl);
  await posterHost.reprocessPosterFastCandidate('poster-job-1', 3, 10, fetchImpl);

  assert.deepEqual(requests.map((request) => request.url), [
    'http://127.0.0.1:4173/api/poster-layer/jobs/poster-job-1/layers/3/accept',
    'http://127.0.0.1:4173/api/poster-layer/jobs/poster-job-1/layers/3/retry',
    'http://127.0.0.1:4173/api/poster-layer/jobs/poster-job-1/layers/3/reprocess',
  ]);
  assert.deepEqual(JSON.parse(requests[0].options.body), {
    candidate_id: 'candidate-3', expected_manifest_revision: 8,
  });
  assert.deepEqual(JSON.parse(requests[1].options.body), { expected_manifest_revision: 9 });
  assert.deepEqual(JSON.parse(requests[2].options.body), { expected_manifest_revision: 10 });
});

test('retry authorization uses an MCP state mutation and never submits a candidate', async () => {
  const calls = [];
  await posterHost.authorizePosterRetry('poster-job-1', 3, 9, undefined, {
    isMcpHost: () => true,
    callTool: async (...args) => calls.push(args),
  });

  assert.deepEqual(calls, [['authorize_poster_layer_retry', {
    jobId: 'poster-job-1', layerIndex: 3, expectedManifestRevision: 9,
  }]]);
});

test('poster polling preserves the typed dispatch lifecycle beside the authoritative job', async () => {
  const requests = [];
  const fetchImpl = async (url) => {
    requests.push(url);
    const payload = url.includes('/dispatches/')
      ? { dispatch_id: 'dispatch-1', status: 'queued' }
      : { job_id: 'poster-job-1', status: 'ANALYZING', plan: { status: 'ANALYZING' } };
    return { ok: true, json: async () => payload };
  };

  const job = await posterHost.getPosterJobWithDispatch('poster-job-1', 'dispatch-1', fetchImpl);
  assert.equal(job.status, 'ANALYZING');
  assert.equal(job.dispatch.status, 'queued');
  assert.equal(requests.length, 2);
});

test('recomposition audit uses the dedicated MCP tool with the exact manifest revision', async () => {
  const calls = [];
  await posterHost.runPosterAudit('poster-job-1', 12, undefined, {
    isMcpHost: () => true,
    callTool: async (...args) => calls.push(args),
  });

  assert.deepEqual(calls, [['run_poster_recomposition_audit', {
    jobId: 'poster-job-1', expectedManifestRevision: 12,
  }]]);
});

test('standalone audit and export use canonical poster package routes', async () => {
  const requests = [];
  const fetchImpl = async (url, options) => {
    requests.push({ url, options });
    return { ok: true, json: async () => ({ job_id: 'poster-job-1' }) };
  };

  await posterHost.runPosterAudit('poster-job-1', 12, fetchImpl);

  assert.equal(requests[0].url, 'http://127.0.0.1:4173/api/poster-layer/jobs/poster-job-1/audit');
  assert.deepEqual(JSON.parse(requests[0].options.body), { expected_manifest_revision: 12 });
  assert.equal(
    posterHost.posterExportUrl('poster-job-1'),
    'http://127.0.0.1:4173/api/poster-layer/jobs/poster-job-1/export',
  );
});

test('audit remediation uses a dedicated MCP mutation for one implicated layer', async () => {
  const calls = [];
  await posterHost.reauthorizePosterAuditLayer('poster-job-1', 2, 12, undefined, {
    isMcpHost: () => true,
    callTool: async (...args) => calls.push(args),
  });

  assert.deepEqual(calls, [['reauthorize_poster_audit_layer', {
    jobId: 'poster-job-1', layerIndex: 2, expectedManifestRevision: 12,
  }]]);
});

test('standalone audit remediation posts only the selected layer and optimistic revision', async () => {
  const requests = [];
  const fetchImpl = async (url, options) => {
    requests.push({ url, options });
    return { ok: true, json: async () => ({ job_id: 'poster-job-1' }) };
  };

  await posterHost.reauthorizePosterAuditLayer('poster-job-1', 2, 12, fetchImpl);

  assert.equal(requests[0].url, 'http://127.0.0.1:4173/api/poster-layer/jobs/poster-job-1/layers/2/audit-remediation');
  assert.deepEqual(JSON.parse(requests[0].options.body), { expected_manifest_revision: 12 });
});
