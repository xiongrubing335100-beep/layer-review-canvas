import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import * as authorIdentity from './attribution.js';

const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const packageLock = JSON.parse(await readFile(new URL('../package-lock.json', import.meta.url), 'utf8'));
const bridge = await readFile(new URL('../codex-thread-bridge.mjs', import.meta.url), 'utf8');
const rootReadme = await readFile(new URL('../../README.md', import.meta.url), 'utf8');
const rootLicense = await readFile(new URL('../../LICENSE', import.meta.url), 'utf8');
const packagedLicense = await readFile(new URL('../LICENSE', import.meta.url), 'utf8');
const pluginLicense = await readFile(new URL('../plugin-template/imvia-layer/LICENSE', import.meta.url), 'utf8').catch(() => null);
const notice = await readFile(new URL('../../NOTICE.md', import.meta.url), 'utf8');
const pluginNotice = await readFile(new URL('../plugin-template/imvia-layer/NOTICE.md', import.meta.url), 'utf8');
const appReadme = await readFile(new URL('../README.md', import.meta.url), 'utf8');
const releaseGuide = await readFile(new URL('../docs/GITHUB_RELEASE.md', import.meta.url), 'utf8');
const mainSource = await readFile(new URL('./main.jsx', import.meta.url), 'utf8');
const attributionSource = await readFile(new URL('./attribution.js', import.meta.url), 'utf8');
const viteSource = await readFile(new URL('../vite.config.js', import.meta.url), 'utf8');
const targetedFinalizer = await readFile(new URL('../scripts/finalize-targeted-job.py', import.meta.url), 'utf8');
const rmbgFinalizer = await readFile(new URL('../scripts/finalize-rmbg.py', import.meta.url), 'utf8');
const refinementRoi = await readFile(new URL('../scripts/result_refinement_roi.py', import.meta.url), 'utf8');
const imagegenCanvasPreparer = await readFile(new URL('../scripts/prepare-targeted-imagegen-canvas.py', import.meta.url), 'utf8');
const authorUrl = 'https://www.xiaohongshu.com/user/profile/5cdb80ac000000001601466b';
const attributionModule = new URL('./attribution.js', import.meta.url);
const applicationDirectory = fileURLToPath(new URL('..', import.meta.url));
const viteCli = fileURLToPath(new URL('../node_modules/vite/bin/vite.js', import.meta.url));
const execFileAsync = promisify(execFile);
const attributionTransportPattern = /\b(?:navigator\.sendBeacon|sendBeacon|WebSocket|fetch|XMLHttpRequest|axios|got|undici|https?\.(?:request|get|post))\b/i;
const attributionResourcePattern = /(?:\b(?:new\s+Image|EventSource|sendBeacon|WebSocket|fetch|XMLHttpRequest)\b|createElement\(\s*['"](?:img|iframe|picture|source|video|audio|object|embed|script|link)['"])/i;
const entryBodyAttributionPattern = /(?:青木|xiaohongshu\.com\/user\/profile\/5cdb80ac000000001601466b|Copyright\s*(?:\(c\)|©)\s*2026|开发者\s*·\s*青木|IMVIA_(?:AUTHOR|COPYRIGHT)_)/i;
const pngAttributionPattern = /(?:青木|xiaohongshu\.com\/user\/profile\/5cdb80ac000000001601466b|Copyright\s*(?:\(c\)|©)\s*2026|开发者\s*·\s*青木|IMVIA_(?:AUTHOR|COPYRIGHT)_|DeveloperAttribution|watermark)/i;
const authorTextDrawingPattern = /(?:\b(?:draw|ImageDraw\.Draw\([^\n]*\))\.(?:text|multiline_text)\s*\()/i;
const prohibitedManifestTerm = /(?:attribution|watermark|telemetry|analytics|fingerprint(?:ing)?|remote[-_\s]?disable|\blicen[cs]e\b)/i;
const allowedLicenseMetadata = new Set(['license=SEE LICENSE IN LICENSE']);

function manifestPath(parts) {
  return parts.map((part) => (typeof part === 'number' ? `[${part}]` : part)).join('.');
}

function isAllowedLicenseMetadata(parts, value) {
  return allowedLicenseMetadata.has(`${manifestPath(parts)}=${value}`);
}

function collectProhibitedManifestEntries(value, parts = []) {
  if (Array.isArray(value)) {
    return value.flatMap((entry, index) => collectProhibitedManifestEntries(entry, [...parts, index]));
  }
  if (value && typeof value === 'object') {
    return Object.entries(value).flatMap(([key, entry]) => {
      const entryParts = [...parts, key];
      const violations = prohibitedManifestTerm.test(key) && !isAllowedLicenseMetadata(entryParts, entry)
        ? [`${manifestPath(entryParts)} (key)`]
        : [];
      return [...violations, ...collectProhibitedManifestEntries(entry, entryParts)];
    });
  }
  if (typeof value === 'string' && !isAllowedLicenseMetadata(parts, value) && prohibitedManifestTerm.test(value)) {
    return [`${manifestPath(parts)} (value)`];
  }
  return [];
}

function sourceWithoutAttributionHeader(source) {
  return /^(?:\/\/|#) Imvia Layer © 2026 青木/.test(source)
    ? source.slice(source.indexOf('\n') + 1)
    : source;
}

function sourceSection(source, startMarker, endMarker, label) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  assert.ok(start >= 0 && end > start, `${label} should remain identifiable`);
  return source.slice(start, end);
}

test('the application uses its final Imvia package identity', () => {
  assert.equal(packageJson.name, 'imvia-ui-layer-review-canvas');
  assert.equal(packageLock.name, 'imvia-ui-layer-review-canvas');
  assert.equal(packageLock.packages[''].name, 'imvia-ui-layer-review-canvas');
  assert.match(bridge, /clientInfo:\s*\{ name: 'imvia-ui-layer-review-canvas'/);
  assert.doesNotMatch(bridge, /name: 'ui-layer-review-canvas'/);
});

test('package and plugin metadata credit Qingmu', async () => {
  const plugin = JSON.parse(await readFile(new URL('../plugin-template/imvia-layer/.codex-plugin/plugin.json', import.meta.url), 'utf8'));
  assert.deepEqual(packageJson.author, {
    name: '青木',
    url: authorUrl,
  });
  assert.equal(packageJson.license, 'SEE LICENSE IN LICENSE');
  assert.equal(packageJson.engines.node, '^20.19.0 || >=22.12.0');
  assert.equal(packageLock.packages[''].license, packageJson.license);
  assert.equal(packageLock.packages[''].engines.node, packageJson.engines.node);
  assert.equal(packageJson.repository.type, 'git');
  assert.equal(packageJson.repository.url, 'https://github.com/xiongrubing335100-beep/imvia-layer-review-canvas.git');
  assert.equal(packageJson.homepage, 'https://github.com/xiongrubing335100-beep/imvia-layer-review-canvas#readme');
  assert.equal(plugin.author.name, '青木');
  assert.equal(plugin.author.url, authorUrl);
  assert.equal(plugin.interface.developerName, '青木');
  assert.equal(plugin.license, 'SEE LICENSE IN LICENSE');
  assert.equal(plugin.homepage, 'https://github.com/xiongrubing335100-beep/imvia-layer-review-canvas');
  assert.equal(plugin.repository, 'https://github.com/xiongrubing335100-beep/imvia-layer-review-canvas');
  assert.equal(plugin.interface.websiteURL, 'https://github.com/xiongrubing335100-beep/imvia-layer-review-canvas');
});

const copyrightLine = 'Imvia Layer © 2026 青木';

test('critical source entries and the build preserve attribution', async () => {
  const paths = [
    './main.jsx',
    '../codex-thread-bridge.mjs',
    '../layer-review-mcp-server.mjs',
    '../scripts/start-workbench.mjs',
    '../scripts/install-codex-plugin.mjs',
    '../scripts/node-runtime.mjs',
    '../scripts/uninstall-codex-plugin.mjs',
    '../scripts/verify-installed-runtime.mjs',
    '../scripts/finalize-targeted-job.py',
    '../plugin-template/imvia-layer/scripts/start-mcp.mjs',
  ];
  for (const relativePath of paths) {
    const contents = await readFile(new URL(relativePath, import.meta.url), 'utf8');
    assert.match(contents, new RegExp(copyrightLine));
    assert.match(contents, /LICENSE/);
    assert.match(contents, /NOTICE\.md/);
  }
  const vite = await readFile(new URL('../vite.config.js', import.meta.url), 'utf8');
  assert.match(vite, /const IMVIA_COPYRIGHT_BANNER/);
  assert.match(vite, /rollupOptions:[\s\S]*output:[\s\S]*banner:\s*IMVIA_COPYRIGHT_BANNER/);
});

test('a temporary sourcemapped production build preserves one legal banner per JavaScript bundle', async () => {
  const outputDirectory = await mkdtemp(path.join(os.tmpdir(), 'imvia-release-banner-'));
  try {
    await execFileAsync(process.execPath, [viteCli, 'build', '--outDir', outputDirectory, '--sourcemap'], {
      cwd: applicationDirectory,
    });
    const assetDirectory = path.join(outputDirectory, 'assets');
    const bundleNames = (await readdir(assetDirectory)).filter((name) => name.endsWith('.js'));
    assert.ok(bundleNames.length > 0, 'production build should emit JavaScript bundles');
    for (const bundleName of bundleNames) {
      const bundlePath = path.join(assetDirectory, bundleName);
      const bundle = await readFile(bundlePath, 'utf8');
      assert.equal(bundle.split(copyrightLine).length - 1, 1, `${bundleName} should contain one legal banner`);
      const sourceMapName = `${bundleName}.map`;
      assert.match(bundle, new RegExp(`sourceMappingURL=${sourceMapName.replace('.', '\\.')}`));
      const sourceMap = JSON.parse(await readFile(path.join(assetDirectory, sourceMapName), 'utf8'));
      assert.equal(sourceMap.file, bundleName);
      assert.ok(Array.isArray(sourceMap.sources) && sourceMap.sources.length > 0, `${sourceMapName} should describe its bundle sources`);
    }
  } finally {
    await rm(outputDirectory, { recursive: true, force: true });
  }
});

test('attribution manifests reject recursive hidden-control fields while allowlisting the declared license metadata', async () => {
  const plugin = JSON.parse(await readFile(new URL('../plugin-template/imvia-layer/.codex-plugin/plugin.json', import.meta.url), 'utf8'));
  assert.deepEqual(collectProhibitedManifestEntries(packageJson), []);
  assert.deepEqual(collectProhibitedManifestEntries(plugin), []);
  assert.deepEqual(collectProhibitedManifestEntries({
    license: 'SEE LICENSE IN LICENSE',
    nested: {
      telemetry: { endpoint: 'https://example.invalid' },
      watermark: true,
      fingerprint: 'device-id',
      remoteDisable: true,
      enforcement: 'license enforcement',
      license: 'MIT',
    },
  }), [
    'nested.telemetry (key)',
    'nested.watermark (key)',
    'nested.fingerprint (key)',
    'nested.remoteDisable (key)',
    'nested.enforcement (value)',
    'nested.license (key)',
  ]);
});

test('package scripts retain only their declared workflow and no lifecycle hooks can enforce a remote license', () => {
  assert.deepEqual(packageJson.scripts, {
    dev: 'node scripts/start-workbench.mjs',
    'mcp:bridge': 'node layer-review-mcp-server.mjs',
    build: 'vite build',
    preview: 'vite preview',
    test: 'node --test',
    'benchmark:splits': 'node scripts/report-split-performance.mjs',
    'install:codex-plugin': 'node scripts/install-codex-plugin.mjs',
    'uninstall:codex-plugin': 'node scripts/uninstall-codex-plugin.mjs',
    setup: 'node scripts/node-version-preflight.mjs && npm ci && npm run build && node scripts/setup-imvia-layer.mjs',
    update: 'node scripts/node-version-preflight.mjs && npm ci && npm run build && node scripts/setup-imvia-layer.mjs',
  });
  for (const lifecycleScript of ['preinstall', 'install', 'postinstall', 'preprepare', 'prepare', 'postprepare', 'prepublish', 'prepublishOnly', 'prepack', 'postpack']) {
    assert.equal(Object.hasOwn(packageJson.scripts, lifecycleScript), false, `${lifecycleScript} must not be a package lifecycle hook`);
  }
});

test('public install docs explain the managed hashed Python runtime and its uninstall lifecycle', () => {
  for (const document of [rootReadme, appReadme, releaseGuide]) {
    assert.match(document, /\.python-runtime/);
    assert.match(document, /requirements-rmbg\.lock/);
    assert.match(document, /--require-hashes/);
    assert.match(document, /npm run uninstall:codex-plugin/);
  }
});

test('the attribution-only surfaces contain no tracking, remote-disable, or license-enforcement behavior', async () => {
  const plugin = JSON.parse(await readFile(new URL('../plugin-template/imvia-layer/.codex-plugin/plugin.json', import.meta.url), 'utf8'));
  assert.doesNotMatch(attributionSource, attributionTransportPattern);
  assert.doesNotMatch(attributionSource, /remote[-_\s]?disable|licen[cs]e[-_\s]?(?:enforce(?:ment)?|check|verify|validation|gate|activation|endpoint)/i);
  assert.doesNotMatch(JSON.stringify({
    author: plugin.author,
    developerName: plugin.interface.developerName,
    websiteURL: plugin.interface.websiteURL,
    homepage: plugin.homepage,
    repository: plugin.repository,
  }), attributionTransportPattern);
  const bannerLine = viteSource.split('\n').find((line) => line.includes('IMVIA_COPYRIGHT_BANNER'));
  const outputConfig = viteSource.slice(viteSource.indexOf('output: {'), viteSource.indexOf('server:', viteSource.indexOf('output: {')));
  assert.ok(bannerLine);
  assert.doesNotMatch(bannerLine, attributionTransportPattern);
  assert.doesNotMatch(outputConfig, attributionTransportPattern);
  for (const relativePath of [
    './main.jsx',
    '../codex-thread-bridge.mjs',
    '../layer-review-mcp-server.mjs',
    '../scripts/start-workbench.mjs',
    '../scripts/install-codex-plugin.mjs',
    '../scripts/node-runtime.mjs',
    '../scripts/uninstall-codex-plugin.mjs',
    '../scripts/verify-installed-runtime.mjs',
    '../scripts/finalize-targeted-job.py',
    '../plugin-template/imvia-layer/scripts/start-mcp.mjs',
  ]) {
    const header = (await readFile(new URL(relativePath, import.meta.url), 'utf8')).split('\n')[0];
    assert.match(header, new RegExp(copyrightLine));
    assert.doesNotMatch(header, attributionTransportPattern);
    assert.doesNotMatch(header, /remote[-_\s]?disable|licen[cs]e[-_\s]?(?:enforce(?:ment)?|check|verify|validation|gate|activation|endpoint)/i);
  }
});

test('author identity remains non-visual release metadata', () => {
  assert.deepEqual(Object.keys(authorIdentity).sort(), ['IMVIA_AUTHOR_NAME', 'IMVIA_AUTHOR_URL']);
  assert.equal(authorIdentity.IMVIA_AUTHOR_NAME, '青木');
  assert.equal(authorIdentity.IMVIA_AUTHOR_URL, authorUrl);
  assert.doesNotMatch(attributionSource, /createElement|DeveloperAttribution|className|aria-label/);
  assert.doesNotMatch(attributionSource, attributionResourcePattern);
  assert.doesNotMatch(attributionSource, attributionTransportPattern);
});

test('critical entry bodies retain no attribution beyond their allowed first-line headers', async () => {
  for (const relativePath of [
    './main.jsx',
    '../codex-thread-bridge.mjs',
    '../layer-review-mcp-server.mjs',
    '../scripts/start-workbench.mjs',
    '../scripts/install-codex-plugin.mjs',
    '../scripts/node-runtime.mjs',
    '../scripts/finalize-targeted-job.py',
    '../plugin-template/imvia-layer/scripts/start-mcp.mjs',
  ]) {
    const source = await readFile(new URL(relativePath, import.meta.url), 'utf8');
    assert.doesNotMatch(sourceWithoutAttributionHeader(source), entryBodyAttributionPattern, relativePath);
  }
});

test('author attribution is structurally isolated from PNG finalizers and export composition', () => {
  assert.doesNotMatch(attributionSource, /\b(?:png|watermark|download|zipSync|canvas)\b/i);
  assert.doesNotMatch(sourceWithoutAttributionHeader(mainSource), /DeveloperAttribution|IMVIA_AUTHOR|青木|xiaohongshu/i);
  const exportStart = mainSource.indexOf('  const exportAccepted = () => {');
  const exportEnd = mainSource.indexOf('  const submitLayers = async', exportStart);
  assert.ok(exportStart >= 0 && exportEnd > exportStart, 'export block should remain identifiable');
  const exportAndDownloadSource = mainSource.slice(exportStart, exportEnd);
  assert.doesNotMatch(exportAndDownloadSource, /DeveloperAttribution|IMVIA_AUTHOR|青木|xiaohongshu|IMVIA_COPYRIGHT|watermark/i);
  for (const finalizer of [sourceWithoutAttributionHeader(targetedFinalizer), rmbgFinalizer]) {
    // ImageDraw also constructs the user's repair-region masks. Drawing a mask
    // is not attribution; reject author payloads and text drawing specifically.
    assert.doesNotMatch(finalizer, /attribution(?:\.js)?|IMVIA_AUTHOR|青木|xiaohongshu|IMVIA_COPYRIGHT|watermark/i);
    assert.doesNotMatch(finalizer, authorTextDrawingPattern);
  }
});

test('pixel generation, composition, and direct-download paths contain no author or watermark injection', () => {
  const cropCanvasSource = sourceSection(mainSource, 'async function cropRegionDataUrl', 'function defaultRemoveBackground', 'crop canvas path');
  const exportAndDownloadSource = sourceSection(mainSource, '  const exportAccepted = () => {', '  const submitLayers = async', 'export and download path');
  const mainBody = sourceWithoutAttributionHeader(mainSource);
  assert.deepEqual(mainBody.match(/DeveloperAttribution|IMVIA_(?:AUTHOR|COPYRIGHT)_|青木|xiaohongshu/g) || [], []);
  for (const source of [
    cropCanvasSource,
    exportAndDownloadSource,
    sourceWithoutAttributionHeader(targetedFinalizer),
    rmbgFinalizer,
    refinementRoi,
    imagegenCanvasPreparer,
  ]) {
    assert.doesNotMatch(source, pngAttributionPattern);
    assert.doesNotMatch(source, authorTextDrawingPattern);
  }
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
  assert.equal(pluginLicense, rootLicense);
  assert.match(rootLicense, /Imvia Layer Personal & Commercial License/);
  assert.match(rootLicense, /personal non-commercial use/i);
  assert.match(rootLicense, /paid commercial license/i);
  assert.match(rootLicense, /copyright and attribution notices/i);
  assert.doesNotMatch(rootLicense, /Permission is hereby granted, free of charge/);
  assert.match(notice, /青木/);
  assert.match(notice, new RegExp(authorUrl.replaceAll('.', '\\.')));
  assert.match(notice, /third-party/i);
  for (const required of [/青木/, /Personal & Commercial License/, /third-party/i, /\.node-runtime/, /exact Node\.js version/, /license and third-party notices/i]) {
    assert.match(pluginNotice, required);
  }
});

test('application documentation preserves the final Imvia distribution terms', () => {
  for (const document of [appReadme, releaseGuide]) {
    assert.match(document, /https:\/\/github\.com\/xiongrubing335100-beep\/imvia-layer-review-canvas/);
    assert.match(document, /imvia-ui-layer-review-canvas/);
    assert.doesNotMatch(document, /MIT License|<你的 GitHub 仓库地址>/);
    assert.match(document, new RegExp(`\\[青木\\]\\(${authorUrl.replaceAll('.', '\\.')}\\)`));
    assert.match(document, /prior written paid authorization/i);
    assert.match(document, /BRIA RMBG 2\.0[\s\S]*third-party license/i);
  }
});

test('public install and release docs state the exact Node range and self-contained update command', () => {
  for (const document of [rootReadme, appReadme, releaseGuide]) {
    assert.match(document, /\^20\.19\.0 \|\| >=22\.12\.0/);
    assert.match(document, /推荐[^\n]*Node\.js 22 LTS|Node\.js 22 LTS[^\n]*推荐|Node\.js 22 LTS[^\n]*recommended/i);
    assert.match(document, /npm run update/);
  }
  assert.doesNotMatch(rootReadme, /Node\.js 20\+/);
  assert.doesNotMatch(appReadme, /Node\.js 20\+/);
});

test('the release guide renames the repository only after the release PR merges', () => {
  assert.match(releaseGuide, /合并发布 PR 后[\s\S]*仓库名称切换为 `imvia-layer-review-canvas`/);
  assert.doesNotMatch(releaseGuide, /创建或重命名为空仓库/);
});

test('the workbench owns non-visual author identity in a dedicated attribution module', async () => {
  assert.equal(existsSync(attributionModule), true, 'src/attribution.js should own non-visual author identity');
  const attribution = await readFile(attributionModule, 'utf8');
  assert.match(attribution, /export const IMVIA_AUTHOR_NAME = '青木';/);
  assert.match(attribution, new RegExp(`export const IMVIA_AUTHOR_URL = '${authorUrl}';`));
});
