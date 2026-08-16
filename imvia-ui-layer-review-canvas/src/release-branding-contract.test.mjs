import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const packageLock = JSON.parse(await readFile(new URL('../package-lock.json', import.meta.url), 'utf8'));
const bridge = await readFile(new URL('../codex-thread-bridge.mjs', import.meta.url), 'utf8');
const rootReadme = await readFile(new URL('../../README.md', import.meta.url), 'utf8');
const rootLicense = await readFile(new URL('../../LICENSE', import.meta.url), 'utf8');
const packagedLicense = await readFile(new URL('../LICENSE', import.meta.url), 'utf8');
const notice = await readFile(new URL('../../NOTICE.md', import.meta.url), 'utf8');
const authorUrl = 'https://www.xiaohongshu.com/user/profile/5cdb80ac000000001601466b';

test('the application uses its final Imvia package identity', () => {
  assert.equal(packageJson.name, 'imvia-ui-layer-review-canvas');
  assert.equal(packageLock.name, 'imvia-ui-layer-review-canvas');
  assert.equal(packageLock.packages[''].name, 'imvia-ui-layer-review-canvas');
  assert.match(bridge, /clientInfo:\s*\{ name: 'imvia-ui-layer-review-canvas'/);
  assert.doesNotMatch(bridge, /name: 'ui-layer-review-canvas'/);
});

test('public docs expose the final install path and author license', () => {
  assert.match(rootReadme, /git clone https:\/\/github\.com\/xiongrubing335100-beep\/imvia-layer-review-canvas\.git/);
  assert.match(rootReadme, /cd imvia-layer-review-canvas\/imvia-ui-layer-review-canvas/);
  assert.match(rootReadme, /npm run setup/);
  assert.match(rootReadme, /个人非商业使用免费/);
  assert.match(rootReadme, /商业使用需事先取得付费授权/);
  assert.match(rootReadme, new RegExp(`\\[青木\\]\\(${authorUrl.replaceAll('.', '\\.')}\\)`));
  assert.doesNotMatch(rootReadme, /MIT License/);
});

test('the distributed license and notice preserve the author terms', () => {
  assert.equal(rootLicense, packagedLicense);
  assert.match(rootLicense, /Imvia Layer Personal & Commercial License/);
  assert.match(rootLicense, /personal non-commercial use/i);
  assert.match(rootLicense, /paid commercial license/i);
  assert.match(rootLicense, /copyright and attribution notices/i);
  assert.doesNotMatch(rootLicense, /Permission is hereby granted, free of charge/);
  assert.match(notice, /青木/);
  assert.match(notice, new RegExp(authorUrl.replaceAll('.', '\\.')));
  assert.match(notice, /third-party/i);
});
