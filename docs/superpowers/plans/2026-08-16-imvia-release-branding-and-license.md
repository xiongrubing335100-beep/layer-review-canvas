# Imvia Release Branding and License Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish the verified Imvia Layer workbench under its final Imvia names with cross-platform installation documentation, a personal-free/commercial-paid license, visible and source-level attribution to 青木, and a preserved production-build copyright banner.

**Architecture:** Keep the existing workbench behavior unchanged while treating branding and attribution as a small cross-cutting contract. A focused `src/attribution.js` module owns the UI-facing author identity, repository metadata and license files own distribution terms, and Vite owns the preserved build banner. The release branch remains the merge boundary; the GitHub repository is renamed only after the ready PR merges into `main`.

**Tech Stack:** React 19, Vite 8/Rollup, Node.js test runner, JSON plugin manifests, Python finalizer scripts, GitHub CLI.

## Global Constraints

- Final GitHub repository name: `imvia-layer-review-canvas`.
- Final application directory name: `imvia-ui-layer-review-canvas`.
- Author display name: `青木`.
- Author URL: `https://www.xiaohongshu.com/user/profile/5cdb80ac000000001601466b`.
- Personal non-commercial use is free; commercial use requires prior written paid authorization.
- Third-party components and BRIA RMBG 2.0 remain subject to their own licenses.
- Do not watermark user-uploaded images or generated PNG results.
- Do not add telemetry, device fingerprints, remote disablement, or hidden license checks.
- Attribution must remain low-interference, searchable, accessible, and transparent.
- Existing split, queue, PNG refinement, RMBG, and cross-platform runtime behavior must remain unchanged.
- Use the bundled Node and Python runtimes when system `node`, `npm`, or `python3` are unavailable.

---

## File Structure

### Files and directories renamed

- Rename: `ui-layer-review-canvas/` → `imvia-ui-layer-review-canvas/`

### Files created

- `README.md`: GitHub landing page and universal installation guide.
- `LICENSE`: canonical Imvia Layer Personal & Commercial License.
- `NOTICE.md`: author, attribution, third-party, and commercial-contact notice.
- `imvia-ui-layer-review-canvas/src/attribution.js`: UI-facing author constants.
- `imvia-ui-layer-review-canvas/src/release-branding-contract.test.mjs`: repository naming, documentation, license, metadata, source-header, and build-banner contracts.

### Files modified

- `imvia-ui-layer-review-canvas/README.md`: detailed guide aligned with final repository name and custom license.
- `imvia-ui-layer-review-canvas/LICENSE`: byte-identical packaged copy of the root license.
- `imvia-ui-layer-review-canvas/package.json`: final package name, author, repository, homepage, and custom-license marker.
- `imvia-ui-layer-review-canvas/package-lock.json`: root package metadata regenerated from `package.json`; dependency licenses remain untouched.
- `imvia-ui-layer-review-canvas/src/main.jsx`: render the developer attribution link and add the source copyright header.
- `imvia-ui-layer-review-canvas/src/styles.css`: low-interference sticky sidebar attribution styling, focus state, responsive behavior, and light-theme colors.
- `imvia-ui-layer-review-canvas/src/workbench-toolbar.test.mjs`: UI attribution rendering and accessibility contract.
- `imvia-ui-layer-review-canvas/vite.config.js`: preserved production JavaScript banner.
- `imvia-ui-layer-review-canvas/codex-thread-bridge.mjs`: final client name and source copyright header.
- `imvia-ui-layer-review-canvas/layer-review-mcp-server.mjs`: source copyright header.
- `imvia-ui-layer-review-canvas/scripts/start-workbench.mjs`: source copyright header.
- `imvia-ui-layer-review-canvas/scripts/install-codex-plugin.mjs`: source copyright header.
- `imvia-ui-layer-review-canvas/scripts/finalize-targeted-job.py`: source copyright header.
- `imvia-ui-layer-review-canvas/plugin-template/imvia-layer/scripts/start-mcp.mjs`: source copyright header.
- `imvia-ui-layer-review-canvas/plugin-template/imvia-layer/.codex-plugin/plugin.json`: 青木 developer metadata and final project URL.
- `imvia-ui-layer-review-canvas/docs/GITHUB_RELEASE.md`: final clone path, application directory, license, merge, and rename instructions.
- Current operational documentation containing executable old directory paths; historical specifications and plans may retain the old name only when explicitly describing history.

---

### Task 1: Rename the application directory and operational package identity

**Files:**
- Rename: `ui-layer-review-canvas/` → `imvia-ui-layer-review-canvas/`
- Create: `imvia-ui-layer-review-canvas/src/release-branding-contract.test.mjs`
- Modify: `imvia-ui-layer-review-canvas/package.json`
- Modify: `imvia-ui-layer-review-canvas/package-lock.json`
- Modify: `imvia-ui-layer-review-canvas/codex-thread-bridge.mjs`
- Modify: current operational docs and scripts that contain executable `ui-layer-review-canvas` paths

**Interfaces:**
- Consumes: the existing dynamically resolved `repositoryRoot` used by setup, MCP, and workbench scripts.
- Produces: package name `imvia-ui-layer-review-canvas` and a repository tree whose live paths no longer depend on the old directory name.

- [ ] **Step 1: Mechanically rename the tracked directory**

Run:

```bash
git mv ui-layer-review-canvas imvia-ui-layer-review-canvas
```

Expected: `git status --short` reports a tracked directory rename without deleting application content.

- [ ] **Step 2: Write the failing operational-name contract test**

Create `imvia-ui-layer-review-canvas/src/release-branding-contract.test.mjs` with the initial contract:

```js
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const packageLock = JSON.parse(await readFile(new URL('../package-lock.json', import.meta.url), 'utf8'));
const bridge = await readFile(new URL('../codex-thread-bridge.mjs', import.meta.url), 'utf8');

test('the application uses its final Imvia package identity', () => {
  assert.equal(packageJson.name, 'imvia-ui-layer-review-canvas');
  assert.equal(packageLock.name, 'imvia-ui-layer-review-canvas');
  assert.equal(packageLock.packages[''].name, 'imvia-ui-layer-review-canvas');
  assert.match(bridge, /clientInfo:\s*\{ name: 'imvia-ui-layer-review-canvas'/);
  assert.doesNotMatch(bridge, /name: 'ui-layer-review-canvas'/);
});
```

- [ ] **Step 3: Run the new test and verify RED**

Run from `imvia-ui-layer-review-canvas/`:

```bash
node --test src/release-branding-contract.test.mjs
```

Expected: FAIL because package and bridge identities still use `ui-layer-review-canvas`.

- [ ] **Step 4: Apply the final package identity**

Set the application package name to:

```json
{
  "name": "imvia-ui-layer-review-canvas"
}
```

Update only the root project entries in `package-lock.json`; do not rewrite dependency license fields. Change the `codex-thread-bridge.mjs` MCP client name to `imvia-ui-layer-review-canvas`.

- [ ] **Step 5: Update live executable path references**

Run from the repository root:

```bash
rg -n "ui-layer-review-canvas" --glob '!docs/superpowers/**' --glob '!HANDOFF.md' --glob '!node_modules/**' --glob '!dist/**' --glob '!output/**'
```

Replace every live installation, startup, test-fixture, and release-command occurrence with `imvia-ui-layer-review-canvas`. Retain old-name occurrences only where a historical document explicitly describes the migration from the old name.

- [ ] **Step 6: Run the focused test and path scan**

Run:

```bash
node --test src/release-branding-contract.test.mjs
```

Expected: PASS.

Run from the repository root:

```bash
rg -n "ui-layer-review-canvas" --glob '!docs/superpowers/**' --glob '!HANDOFF.md' --glob '!node_modules/**' --glob '!dist/**' --glob '!output/**'
```

Expected: no live operational matches.

- [ ] **Step 7: Commit the rename boundary**

```bash
git add -A -- ui-layer-review-canvas imvia-ui-layer-review-canvas
git commit -m "refactor: rename Imvia workbench directory"
```

---

### Task 2: Publish the root README, custom license, and author notice

**Files:**
- Create: `README.md`
- Create: `LICENSE`
- Create: `NOTICE.md`
- Modify: `imvia-ui-layer-review-canvas/README.md`
- Modify: `imvia-ui-layer-review-canvas/LICENSE`
- Modify: `imvia-ui-layer-review-canvas/src/release-branding-contract.test.mjs`
- Modify: `imvia-ui-layer-review-canvas/docs/GITHUB_RELEASE.md`

**Interfaces:**
- Consumes: final repository name `imvia-layer-review-canvas` and final application directory `imvia-ui-layer-review-canvas`.
- Produces: one public installation contract, byte-identical root/package licenses, and a durable author/contact notice.

- [ ] **Step 1: Extend the contract test for public documentation and licensing**

Add:

```js
const rootReadme = await readFile(new URL('../../README.md', import.meta.url), 'utf8');
const rootLicense = await readFile(new URL('../../LICENSE', import.meta.url), 'utf8');
const packagedLicense = await readFile(new URL('../LICENSE', import.meta.url), 'utf8');
const notice = await readFile(new URL('../../NOTICE.md', import.meta.url), 'utf8');
const authorUrl = 'https://www.xiaohongshu.com/user/profile/5cdb80ac000000001601466b';

test('public docs expose the final install path and author license', () => {
  assert.match(rootReadme, /git clone https:\/\/github\.com\/xiongrubing335100-beep\/imvia-layer-review-canvas\.git/);
  assert.match(rootReadme, /cd imvia-layer-review-canvas\/imvia-ui-layer-review-canvas/);
  assert.match(rootReadme, /npm run setup/);
  assert.match(rootReadme, /个人非商业使用免费/);
  assert.match(rootReadme, /商业使用需事先取得付费授权/);
  assert.match(rootReadme, new RegExp(`\\[青木\\]\\(${authorUrl.replaceAll('.', '\\\\.')}\\)`));
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
  assert.match(notice, new RegExp(authorUrl.replaceAll('.', '\\\\.')));
  assert.match(notice, /third-party/i);
});
```

- [ ] **Step 2: Run the focused test and verify RED**

```bash
node --test src/release-branding-contract.test.mjs
```

Expected: FAIL because the root README, root license, and notice do not exist and the packaged license is still MIT.

- [ ] **Step 3: Create the canonical license**

Create `LICENSE` with these exact titled sections:

```text
Imvia Layer Personal & Commercial License 1.0
Copyright (c) 2026 青木. All rights reserved.

1. Personal Non-Commercial License
2. Commercial Use Requires a Paid License
3. Modification and Non-Commercial Redistribution
4. Attribution and Notices
5. Third-Party Components
6. No Trademark Grant
7. Termination
8. Disclaimer of Warranty
9. Limitation of Liability
10. Commercial Licensing Contact
```

The body must implement the approved definitions from the design spec. Copy the completed canonical text byte-for-byte to `imvia-ui-layer-review-canvas/LICENSE`.

- [ ] **Step 4: Create the GitHub landing README**

Create `README.md` with:

1. Imvia Layer description and feature summary.
2. Requirements: Codex Desktop, Node.js 20+, Python 3.10+, network for first-time dependency/model download.
3. Git clone installation:

```sh
git clone https://github.com/xiongrubing335100-beep/imvia-layer-review-canvas.git
cd imvia-layer-review-canvas/imvia-ui-layer-review-canvas
npm run setup
```

4. ZIP installation: extract, enter `imvia-ui-layer-review-canvas`, run `npm run setup`.
5. Codex invocation:

```text
[@imvia-layer](plugin://imvia-layer@personal) 打开工作台
```

6. Plugin update command `npm run install:codex-plugin`.
7. Personal/commercial license summary and third-party license warning.
8. Footer:

```markdown
© 2026 [青木](https://www.xiaohongshu.com/user/profile/5cdb80ac000000001601466b)。个人非商业使用免费；商业使用需事先取得付费授权。
```

- [ ] **Step 5: Create NOTICE and align detailed docs**

Create `NOTICE.md` with product, author, author URL, license summary, and third-party notice. Update the application README and GitHub release guide so they reference the final repository URL, final directory, root license, and source-available terms. Remove `<你的 GitHub 仓库地址>` and every statement claiming the project uses MIT.

- [ ] **Step 6: Run focused documentation tests**

```bash
node --test src/release-branding-contract.test.mjs
```

Expected: PASS.

- [ ] **Step 7: Commit public documentation and license**

```bash
git add README.md LICENSE NOTICE.md imvia-ui-layer-review-canvas/README.md imvia-ui-layer-review-canvas/LICENSE imvia-ui-layer-review-canvas/docs/GITHUB_RELEASE.md imvia-ui-layer-review-canvas/src/release-branding-contract.test.mjs
git commit -m "docs: publish Imvia install and license terms"
```

---

### Task 3: Add the accessible developer attribution to the workbench

**Files:**
- Create: `imvia-ui-layer-review-canvas/src/attribution.js`
- Modify: `imvia-ui-layer-review-canvas/src/main.jsx`
- Modify: `imvia-ui-layer-review-canvas/src/styles.css`
- Modify: `imvia-ui-layer-review-canvas/src/workbench-toolbar.test.mjs`

**Interfaces:**
- Produces: `IMVIA_AUTHOR_NAME: string` and `IMVIA_AUTHOR_URL: string` for UI rendering.
- Consumes: the existing left sidebar and dark/light theme tokens.

- [ ] **Step 1: Write the failing UI attribution test**

Append to `src/workbench-toolbar.test.mjs`:

```js
test('the left sidebar credits developer Qingmu without tracking users', () => {
  assert.match(source, /className="developer-attribution"/);
  assert.match(source, /href=\{IMVIA_AUTHOR_URL\}/);
  assert.match(source, /target="_blank"/);
  assert.match(source, /rel="noopener noreferrer"/);
  assert.match(source, /aria-label="访问开发者青木的小红书主页"/);
  assert.match(source, /<span>开发者<\/span>/);
  assert.match(source, /<strong>\{IMVIA_AUTHOR_NAME\}<\/strong>/);
  assert.match(styles, /\.developer-attribution\s*\{[\s\S]*position:\s*sticky;[\s\S]*bottom:\s*0;/);
  assert.match(styles, /\.developer-attribution:focus-visible/);
  assert.doesNotMatch(source, /sendBeacon|fingerprint|trackingPixel/);
});
```

- [ ] **Step 2: Run the focused test and verify RED**

```bash
node --test src/workbench-toolbar.test.mjs
```

Expected: FAIL because the attribution component and styles do not exist.

- [ ] **Step 3: Add the focused attribution constants**

Create `src/attribution.js`:

```js
export const IMVIA_AUTHOR_NAME = '青木';
export const IMVIA_AUTHOR_URL = 'https://www.xiaohongshu.com/user/profile/5cdb80ac000000001601466b';
```

- [ ] **Step 4: Render the sidebar footer link**

Import the constants in `src/main.jsx`. Add this as the final child of the left sidebar:

```jsx
<a
  className="developer-attribution"
  href={IMVIA_AUTHOR_URL}
  target="_blank"
  rel="noopener noreferrer"
  aria-label="访问开发者青木的小红书主页"
>
  <span>开发者</span>
  <strong>{IMVIA_AUTHOR_NAME}</strong>
</a>
```

Do not render it over the image, crop preview, canvas, or generated PNG.

- [ ] **Step 5: Add low-interference sticky styling**

Implement these properties while using existing theme colors:

```css
.developer-attribution {
  position: sticky;
  bottom: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  min-height: 34px;
  margin-top: 24px;
  color: #718076;
  background: linear-gradient(180deg, rgba(18, 23, 20, 0), #121714 38%);
  text-decoration: none;
}

.developer-attribution:hover,
.developer-attribution:focus-visible {
  color: #59d99b;
}
```

Add a visible focus outline and a light-theme background override. Preserve the collapsed-sidebar behavior.

- [ ] **Step 6: Run focused UI tests**

```bash
node --test src/workbench-toolbar.test.mjs
```

Expected: PASS.

- [ ] **Step 7: Commit the UI attribution**

```bash
git add imvia-ui-layer-review-canvas/src/attribution.js imvia-ui-layer-review-canvas/src/main.jsx imvia-ui-layer-review-canvas/src/styles.css imvia-ui-layer-review-canvas/src/workbench-toolbar.test.mjs
git commit -m "feat: credit Imvia developer in workbench"
```

---

### Task 4: Preserve attribution in metadata, source entries, and production builds

**Files:**
- Modify: `imvia-ui-layer-review-canvas/package.json`
- Modify: `imvia-ui-layer-review-canvas/package-lock.json`
- Modify: `imvia-ui-layer-review-canvas/plugin-template/imvia-layer/.codex-plugin/plugin.json`
- Modify: `imvia-ui-layer-review-canvas/src/main.jsx`
- Modify: `imvia-ui-layer-review-canvas/codex-thread-bridge.mjs`
- Modify: `imvia-ui-layer-review-canvas/layer-review-mcp-server.mjs`
- Modify: `imvia-ui-layer-review-canvas/scripts/start-workbench.mjs`
- Modify: `imvia-ui-layer-review-canvas/scripts/install-codex-plugin.mjs`
- Modify: `imvia-ui-layer-review-canvas/scripts/finalize-targeted-job.py`
- Modify: `imvia-ui-layer-review-canvas/plugin-template/imvia-layer/scripts/start-mcp.mjs`
- Modify: `imvia-ui-layer-review-canvas/vite.config.js`
- Modify: `imvia-ui-layer-review-canvas/src/release-branding-contract.test.mjs`

**Interfaces:**
- Consumes: final author name/URL, repository URL, and root license.
- Produces: searchable author metadata and `IMVIA_COPYRIGHT_BANNER`, preserved in built JavaScript.

- [ ] **Step 1: Extend the contract test for metadata and source attribution**

Add metadata assertions:

```js
test('package and plugin metadata credit Qingmu', async () => {
  const plugin = JSON.parse(await readFile(new URL('../plugin-template/imvia-layer/.codex-plugin/plugin.json', import.meta.url), 'utf8'));
  assert.deepEqual(packageJson.author, {
    name: '青木',
    url: authorUrl,
  });
  assert.equal(packageJson.license, 'SEE LICENSE IN LICENSE');
  assert.equal(packageJson.repository.url, 'https://github.com/xiongrubing335100-beep/imvia-layer-review-canvas.git');
  assert.equal(plugin.author.name, '青木');
  assert.equal(plugin.author.url, authorUrl);
  assert.equal(plugin.interface.developerName, '青木');
});
```

Add source/banner assertions:

```js
const copyrightLine = 'Imvia Layer © 2026 青木';

test('critical source entries and the build preserve attribution', async () => {
  const paths = [
    './main.jsx',
    '../codex-thread-bridge.mjs',
    '../layer-review-mcp-server.mjs',
    '../scripts/start-workbench.mjs',
    '../scripts/install-codex-plugin.mjs',
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
```

- [ ] **Step 2: Run the contract test and verify RED**

```bash
node --test src/release-branding-contract.test.mjs
```

Expected: FAIL because metadata, source headers, and build banner are absent.

- [ ] **Step 3: Add package and plugin metadata**

Set the root package fields:

```json
{
  "name": "imvia-ui-layer-review-canvas",
  "author": {
    "name": "青木",
    "url": "https://www.xiaohongshu.com/user/profile/5cdb80ac000000001601466b"
  },
  "homepage": "https://github.com/xiongrubing335100-beep/imvia-layer-review-canvas#readme",
  "repository": {
    "type": "git",
    "url": "https://github.com/xiongrubing335100-beep/imvia-layer-review-canvas.git"
  },
  "license": "SEE LICENSE IN LICENSE"
}
```

Regenerate only root lock metadata with the project package manager. Set plugin `author` to 青木 plus the author URL, `interface.developerName` to 青木, and add the final GitHub homepage when the manifest schema permits an extra metadata field.

- [ ] **Step 4: Add concise source headers**

Add one comment at the top of each listed critical entry, using the language’s comment syntax:

```text
Imvia Layer © 2026 青木. Personal non-commercial use is free; commercial use requires a paid license. See LICENSE and NOTICE.md.
```

Do not add executable tracking, obfuscation, or runtime enforcement.

- [ ] **Step 5: Configure the preserved Vite banner**

Add:

```js
const IMVIA_COPYRIGHT_BANNER = '/*! Imvia Layer © 2026 青木 — Personal non-commercial use only; commercial license required. */';
```

Extend the existing Vite config without changing plugins or server behavior:

```js
build: {
  rollupOptions: {
    output: {
      banner: IMVIA_COPYRIGHT_BANNER,
    },
  },
},
```

- [ ] **Step 6: Run focused contracts and a production build**

```bash
node --test src/release-branding-contract.test.mjs
node node_modules/vite/bin/vite.js build
```

Expected: test and build PASS.

Verify the build artifact using Node so the check works on macOS and Windows runners:

```bash
node -e "const fs=require('fs');const p='dist/assets';const f=fs.readdirSync(p).find(x=>x.endsWith('.js'));const s=fs.readFileSync(p+'/'+f,'utf8');if(!s.includes('Imvia Layer © 2026 青木'))process.exit(1)"
```

Expected: exit code 0.

- [ ] **Step 7: Commit metadata and durable attribution**

```bash
git add imvia-ui-layer-review-canvas/package.json imvia-ui-layer-review-canvas/package-lock.json imvia-ui-layer-review-canvas/plugin-template/imvia-layer/.codex-plugin/plugin.json imvia-ui-layer-review-canvas/src/main.jsx imvia-ui-layer-review-canvas/codex-thread-bridge.mjs imvia-ui-layer-review-canvas/layer-review-mcp-server.mjs imvia-ui-layer-review-canvas/scripts/start-workbench.mjs imvia-ui-layer-review-canvas/scripts/install-codex-plugin.mjs imvia-ui-layer-review-canvas/scripts/finalize-targeted-job.py imvia-ui-layer-review-canvas/plugin-template/imvia-layer/scripts/start-mcp.mjs imvia-ui-layer-review-canvas/vite.config.js imvia-ui-layer-review-canvas/src/release-branding-contract.test.mjs
git commit -m "chore: preserve Imvia release attribution"
```

---

### Task 5: Run complete cross-platform-oriented verification and reinstall the local plugin

**Files:**
- Verify only; modify source only if a test exposes a regression covered by this specification.
- Generated local plugin outside the repository: `~/plugins/imvia-layer/` via the existing installer.

**Interfaces:**
- Consumes: final renamed application directory and all attribution/license contracts.
- Produces: verified release branch and a locally installed plugin pointing to the renamed workbench directory.

- [ ] **Step 1: Run every Node test**

From `imvia-ui-layer-review-canvas/`:

```bash
node --test src/*.test.mjs
```

Expected: all tests PASS with zero failures.

- [ ] **Step 2: Run every Python script test with the bundled runtime**

```bash
/Users/a1234/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3 -m unittest discover -s scripts -p 'test_*.py'
```

Expected: all tests PASS with zero failures.

- [ ] **Step 3: Build and verify the banner**

```bash
/Users/a1234/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node node_modules/vite/bin/vite.js build
/Users/a1234/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node -e "const fs=require('fs');const p='dist/assets';const f=fs.readdirSync(p).find(x=>x.endsWith('.js'));const s=fs.readFileSync(p+'/'+f,'utf8');if(!s.includes('Imvia Layer © 2026 青木'))process.exit(1)"
```

Expected: Vite build succeeds and the banner check exits 0.

- [ ] **Step 4: Verify repository hygiene and live paths**

From the repository root:

```bash
git diff --check
git status --short
rg -n "<你的 GitHub 仓库地址>|MIT License" README.md LICENSE NOTICE.md imvia-ui-layer-review-canvas/README.md imvia-ui-layer-review-canvas/LICENSE imvia-ui-layer-review-canvas/docs/GITHUB_RELEASE.md
```

Expected: `git diff --check` is clean; only intended tracked changes exist before their commits; no placeholder or MIT claim appears in owned release docs. Dependency-license entries in `package-lock.json` are not treated as project-license violations.

- [ ] **Step 5: Reinstall the personal plugin from the renamed directory**

Run after obtaining filesystem approval for the user plugin directory:

```bash
/Users/a1234/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node scripts/install-codex-plugin.mjs
```

Expected: the installer reports the renamed `imvia-ui-layer-review-canvas` workbench root and registers a fresh personal plugin version.

- [ ] **Step 6: Open the plugin and verify the visible release identity**

Invoke `@imvia-layer` in the current Codex task. Verify:

- workbench reaches “已就绪” or exposes the reconnect button;
- left sidebar displays `开发者 · 青木`;
- clicking 青木 targets the exact Xiaohongshu URL in a new page;
- no watermark appears on uploaded images or PNG outputs;
- an existing split task can still be created without path errors.

- [ ] **Step 7: Commit any verification-only fixture updates**

If verification required only expected snapshot/contract updates already covered by the spec, stage those exact files and commit:

```bash
git commit -m "test: verify Imvia release branding"
```

If no files changed, do not create an empty commit.

---

### Task 6: Update the PR, merge main, and rename the GitHub repository

**Files:**
- GitHub repository metadata.
- Local Git remote `origin`.
- No production files should change in this task.

**Interfaces:**
- Consumes: a clean, fully tested `codex/release-workbench` branch.
- Produces: merged `main`, final repository name `imvia-layer-review-canvas`, and a local origin that points to the final URL.

- [ ] **Step 1: Push the complete release branch**

```bash
git push -u origin codex/release-workbench
```

Expected: the remote branch contains all rename, README, license, UI, metadata, and banner commits.

- [ ] **Step 2: Update PR #2 for the full release scope**

Set title:

```text
Publish Imvia Layer workbench release
```

Update the PR body to cover final naming, universal installation, custom licensing, author attribution, tests, build, and the post-merge repository rename. Keep real Markdown newlines.

- [ ] **Step 3: Mark the PR ready and inspect mergeability**

```bash
gh pr ready 2 --repo xiongrubing335100-beep/layer-review-canvas
gh pr view 2 --repo xiongrubing335100-beep/layer-review-canvas --json state,isDraft,mergeable,statusCheckRollup,url
```

Expected: `isDraft` is false, the PR is open, and required checks are successful or absent.

- [ ] **Step 4: Merge the confirmed release PR**

```bash
gh pr merge 2 --repo xiongrubing335100-beep/layer-review-canvas --merge
```

Expected: PR #2 is merged into `main`. Do not delete the local branch before repository rename and final verification.

- [ ] **Step 5: Rename the GitHub repository**

```bash
gh repo rename imvia-layer-review-canvas --repo xiongrubing335100-beep/layer-review-canvas --yes
```

Expected: repository canonical URL becomes `https://github.com/xiongrubing335100-beep/imvia-layer-review-canvas`.

- [ ] **Step 6: Update and verify the local remote**

```bash
git remote set-url origin https://github.com/xiongrubing335100-beep/imvia-layer-review-canvas.git
git remote -v
gh repo view xiongrubing335100-beep/imvia-layer-review-canvas --json nameWithOwner,defaultBranchRef,url
```

Expected: fetch/push both use the new URL; default branch is `main`; repository URL and README installation link agree.

- [ ] **Step 7: Verify the merged public landing page**

```bash
gh api repos/xiongrubing335100-beep/imvia-layer-review-canvas/readme --jq '.html_url'
```

Expected: README exists on `main`. Open the returned page and verify the author link, installation commands, final directory name, and personal/commercial license summary.

- [ ] **Step 8: Record the release outcome**

Report:

- merged PR URL;
- final repository URL;
- merge commit;
- final Node/Python/build counts;
- local plugin reinstall result;
- any platform verification not executed on physical Windows hardware.

Do not claim a Windows end-to-end install was physically tested unless it actually ran on Windows; distinguish contract coverage from real-device coverage.

