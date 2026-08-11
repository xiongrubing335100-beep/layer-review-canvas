import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import test from 'node:test';

let ResultVersionGallery = null;
try {
  ({ ResultVersionGallery } = await import('./result-version-gallery.js'));
} catch {
  // RED state: the gallery does not exist yet.
}

test('completed PNG revisions render as separate version areas with the newest marked current', () => {
  const Gallery = ResultVersionGallery || (() => null);
  const markup = renderToStaticMarkup(createElement(Gallery, {
    nodeName: 'KV 元素 1',
    history: [
      {
        job: { id: 'base-job' },
        image: { name: 'image-kv-element.png', url: '/jobs/base/files/base.png' },
      },
      {
        job: { id: 'revision-job' },
        image: { name: 'image-kv-element-v001.png', url: '/jobs/revision/files/v001.png' },
      },
    ],
  }));

  assert.match(markup, /aria-label="KV 元素 1 PNG 版本"/);
  assert.equal((markup.match(/<article class="result-version-card/g) || []).length, 2);
  assert.match(markup, /原始 PNG/);
  assert.match(markup, /精修版本 1/);
  assert.match(markup, /当前版本/);
  assert.match(markup, /base\.png/);
  assert.match(markup, /v001\.png/);
});
