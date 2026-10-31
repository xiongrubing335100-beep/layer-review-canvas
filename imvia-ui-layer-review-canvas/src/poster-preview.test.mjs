import assert from 'node:assert/strict';
import test from 'node:test';

import { derivePosterPreview } from './poster-preview.js';

test('a green-key candidate gets a display-only simulated transparency preview', () => {
  assert.deepEqual(derivePosterPreview({
    candidateUrl: '/candidate.png',
    fillColor: '#00FF00',
  }), {
    candidateUrl: '/candidate.png',
    fillColor: '#00FF00',
    kind: 'simulated-transparency',
    className: 'poster-preview--green-key',
    label: '透明模拟预览（仅预览）',
    cacheOnly: true,
    downloadable: false,
  });
});

test('a black-key Screen/Add candidate keeps its canonical URL and uses the black-key preview mode', () => {
  const preview = derivePosterPreview({ candidateUrl: '/effect.png', fillColor: '#000000' });

  assert.equal(preview.candidateUrl, '/effect.png');
  assert.equal(preview.className, 'poster-preview--black-key');
  assert.equal(preview.downloadable, false);
});
