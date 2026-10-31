import assert from 'node:assert/strict';
import test from 'node:test';

import { posterPrompt } from './vite.config.js';

function targetedPrepared() {
  return {
    task_kind: 'poster_candidate', job_id: 'fast-job', plan_version: 7,
    layer_index: 2, candidate_number: 1, authorization_id: 'fast-job:7:2:1',
    reservation_manifest_revision: 19, candidate_id: 'fast-job:layer-2:candidate-01',
    plan_path: '/jobs/fast-job/poster-layer-plan.json',
    authoritative_plan_path: '/jobs/fast-job/poster-layer-plan.json',
    source_path: '/jobs/fast-job/source.png', candidate_path: '/jobs/fast-job/candidates/2.png',
    output_directory: '/jobs/fast-job', planning_mode: 'targeted_fast',
    snapshot_id: 'snapshot-verified', source_fingerprint: 'source-verified', dispatch_id: 'dispatch-verified',
  };
}

test('targeted poster prompt preserves its full prepared envelope and uses Chinese wrapper', () => {
  const prepared = targetedPrepared();
  const prompt = posterPrompt(prepared, {
    processingCategory: 'text', confirmedSnapshotPath: prepared.authoritative_plan_path,
  });
  assert.match(prompt, /imvia-poster-layering-workbench-targeted-v1/);
  assert.match(prompt, /snapshot-verified/);
  assert.match(prompt, /source-verified/);
  assert.match(prompt, /调度信封/);
  assert.doesNotMatch(prompt, /Read and execute|Execute the visible|Use the authoritative plan|Dispatch envelope|Do not start/);
  const serialized = prompt.match(/调度信封（必须将每个字段传入最终归档）：(\{.*\})。不得启动/u)?.[1];
  assert.ok(serialized);
  const envelope = JSON.parse(serialized);
  for (const [key, value] of Object.entries(prepared)) assert.deepEqual(envelope[key], value, key);
  assert.equal(envelope.dispatchId, prepared.dispatch_id);
  assert.equal(envelope.layerIndex, prepared.layer_index);
  assert.equal(envelope.snapshotId, prepared.snapshot_id);
});

test('non-targeted candidate keeps the legacy adapter and wording', () => {
  const prepared = { ...targetedPrepared(), planning_mode: undefined, snapshot_id: undefined, source_fingerprint: undefined };
  const prompt = posterPrompt(prepared);
  assert.match(prompt, /Read and execute the installed \$imvia-poster-layering-workbench-v1 adapter before work/);
  assert.doesNotMatch(prompt, /imvia-poster-layering-workbench-targeted-v1/);
});
