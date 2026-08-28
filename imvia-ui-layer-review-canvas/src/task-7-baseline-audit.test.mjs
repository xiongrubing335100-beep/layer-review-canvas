import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const auditedFiles = Object.freeze({
  '../layer-review-mcp-server.mjs': '76ad0c59ef5190332dd18af6723ee0d60b351af4b456d295f5e1f662a26b9e67',
  './PosterCandidateReview.jsx': 'fd334f2cff25d58ce338b64a6efb622c56febaeced6aa067118f69afd3b83f66',
  './poster-candidate-review-model.js': '381e4f0ba5e2bead3dfb477b60c4a0a4c435a0419a7b93de2cc49d3defb0ae7c',
  './job-state.js': '1f20a1f97b639dbeb34ad05d2b5a415143259e83d1d9374a0b33b2613fa3e6ba',
  './job-state.test.mjs': 'bc2561553f5c1e3afdfc67dd6e4c6b1cb45456a385aee4b5854c664ff6ee0ee3',
});

async function source(relativePath) {
  return readFile(new URL(relativePath, import.meta.url), 'utf8');
}

test('Task 7 baseline audit records the current untracked implementation and retained markers', async () => {
  for (const [relativePath, expectedHash] of Object.entries(auditedFiles)) {
    const content = await source(relativePath);
    assert.equal(createHash('sha256').update(content).digest('hex'), expectedHash, relativePath);
  }

  const server = await source('../layer-review-mcp-server.mjs');
  assert.match(server, /submit_layer_review_job/);
  assert.match(server, /submit_poster_layer_analysis/);
  assert.match(server, /submit_poster_layer_candidate/);
  assert.match(server, /connect_layer_review_workbench/);
  assert.match(server, /resourceUri: bridgeWidgetUri/);

  const review = await source('./PosterCandidateReview.jsx');
  assert.match(review, /canAccept/);
  assert.match(review, /PosterCandidateReview/);

  const jobState = await source('./job-state.js');
  assert.match(jobState, /reconcileTurnStatus/);
  assert.match(jobState, /posterCandidateViewModel/);
  assert.match(jobState, /resolveExecutionReportStatus/);

  const jobStateTest = await source('./job-state.test.mjs');
  assert.match(jobStateTest, /jobs from another uploaded image/);
  assert.match(jobStateTest, /execution report/);
});
