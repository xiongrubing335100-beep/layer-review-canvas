import assert from 'node:assert/strict';
import test from 'node:test';
import { finishPosterBusy, isPosterBusy, startPosterBusy } from './poster-busy-state.js';

test('A and B retain independent pending poster mutations across document switches', () => {
  const aPending = startPosterBusy(new Set(), 'A');
  const bothPending = startPosterBusy(aPending, 'B');

  assert.equal(isPosterBusy(bothPending, 'A'), true, 'switching back to A keeps its actions disabled');
  assert.equal(isPosterBusy(bothPending, 'B'), true, 'B can begin without clearing A');

  const bFinished = finishPosterBusy(bothPending, 'B');
  assert.equal(isPosterBusy(bFinished, 'A'), true, 'B completion leaves A pending');
  assert.equal(isPosterBusy(bFinished, 'B'), false, 'B completion clears only B');

  const allFinished = finishPosterBusy(bFinished, 'A');
  assert.equal(isPosterBusy(allFinished, 'A'), false, 'A completion clears A');
  assert.equal(allFinished.size, 0);
});
