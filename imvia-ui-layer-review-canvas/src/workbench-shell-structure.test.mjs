import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { workbenchShellStructure } from './workbench-shell-structure.js';

const mainSource = readFileSync(new URL('./main.jsx', import.meta.url), 'utf8');
const styleSource = readFileSync(new URL('./styles.css', import.meta.url), 'utf8');

for (const documentCount of [0, 1, 3]) {
  test(`workspace stays in shell row 3 with ${documentCount} document${documentCount === 1 ? '' : 's'}`, () => {
    const structure = workbenchShellStructure(documentCount);

    assert.deepEqual(structure.workspace, { gridRow: 3 });
    assert.deepEqual(structure.topbar, { gridRow: 1 });
    assert.equal(structure.switcher, documentCount > 1 ? 2 : null);
  });
}

test('the rendered shell uses the structural switcher condition and explicit row placement', () => {
  assert.match(mainSource, /const shellStructure = workbenchShellStructure\(imageDocuments\.length\);/);
  assert.match(mainSource, /shellStructure\.switcher \? \(/);
  assert.match(mainSource, /data-shell-grid-row=\{shellStructure\.workspace\.gridRow\}/);
  assert.match(styleSource, /\.topbar\s*\{[^}]*grid-row:\s*1;/);
  assert.match(styleSource, /\.document-switcher\s*\{[^}]*grid-row:\s*2;/);
  assert.match(styleSource, /\.workspace\s*\{[^}]*grid-row:\s*3;/);
});
