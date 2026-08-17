# Remove Visible Developer Attribution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan.

**Goal:** Remove the visible “开发者 · 青木” strip from the workbench sidebar while preserving all non-visual author, copyright, licensing, metadata, and Xiaohongshu-link attribution.

**Architecture:** Treat visible workbench attribution and release/legal attribution as separate contracts. Remove only the React render path and its dedicated CSS. Keep the author constants and every README, LICENSE, NOTICE, source-header, and package/plugin metadata reference unchanged.

**Tech Stack:** React, CSS, Node.js test runner, Vite, Python unittest.

---

## Task 1: Remove the visible attribution without changing legal attribution

**Files:**

- Modify: `imvia-ui-layer-review-canvas/src/workbench-toolbar.test.mjs`
- Modify: `imvia-ui-layer-review-canvas/src/release-branding-contract.test.mjs`
- Modify: `imvia-ui-layer-review-canvas/src/main.jsx`
- Modify: `imvia-ui-layer-review-canvas/src/attribution.js`
- Modify: `imvia-ui-layer-review-canvas/src/styles.css`

### Step 1: Write the failing UI-removal contract

Update the focused tests so they require all of the following:

- `main.jsx` does not import or render `DeveloperAttribution`.
- The left sidebar has no visible author link or developer-attribution element.
- `styles.css` contains no `.developer-attribution` UI rules or dedicated attribution color variables.
- `attribution.js` still exports `IMVIA_AUTHOR_NAME` and `IMVIA_AUTHOR_URL` with the existing values.
- README, LICENSE, NOTICE, source legal headers, package/plugin metadata, and export/finalizer no-watermark tests remain intact.

Do not weaken or remove non-visual attribution and licensing assertions.

### Step 2: Run the focused tests and verify RED

Run from `imvia-ui-layer-review-canvas`:

```bash
PATH="/Users/a1234/.workbuddy/binaries/node/versions/22.22.2/bin:$PATH" node --test src/workbench-toolbar.test.mjs src/release-branding-contract.test.mjs
```

Expected: FAIL because the current workbench still imports, renders, and styles `DeveloperAttribution`.

### Step 3: Make the minimal production change

In `main.jsx`:

- Remove the `DeveloperAttribution` import.
- Remove the `<DeveloperAttribution />` element at the bottom of the left sidebar.
- Do not change surrounding sidebar structure, spacing, layer items, or controls.

In `attribution.js`:

- Preserve `IMVIA_AUTHOR_NAME = '青木'`.
- Preserve the existing Xiaohongshu URL in `IMVIA_AUTHOR_URL`.
- Remove the visual `DeveloperAttribution` React component and its now-unused React import.

In `styles.css`:

- Remove only the `.developer-attribution` rule set, its responsive/light-theme variants, and its dedicated CSS variables.
- Do not alter unrelated layout or branding styles.

### Step 4: Run the focused tests and verify GREEN

```bash
PATH="/Users/a1234/.workbuddy/binaries/node/versions/22.22.2/bin:$PATH" node --test src/workbench-toolbar.test.mjs src/release-branding-contract.test.mjs
```

Expected: PASS.

### Step 5: Run complete regression verification

From `imvia-ui-layer-review-canvas`:

```bash
PATH="/Users/a1234/.workbuddy/binaries/node/versions/22.22.2/bin:$PATH" npm test
/Users/a1234/plugins/imvia-layer/.python-runtime/bin/python -m unittest discover -s scripts -p 'test_*.py'
PATH="/Users/a1234/.workbuddy/binaries/node/versions/22.22.2/bin:$PATH" npm run build
/Users/a1234/.cache/codex-runtimes/codex-primary-runtime/dependencies/bin/fallback/git diff --check
```

Expected:

- All Node tests pass.
- All Python tests pass.
- Vite production build succeeds.
- `git diff --check` reports no whitespace errors.

### Step 6: Verify the visible outcome

Open or refresh the local workbench and confirm:

- The left sidebar ends naturally after the layer list.
- The visible “开发者 · 青木” strip is absent.
- No replacement watermark or blank reserved attribution block remains.
- No other workbench UI changes are visible.

### Step 7: Commit only the scoped change

```bash
/Users/a1234/.cache/codex-runtimes/codex-primary-runtime/dependencies/bin/fallback/git add \
  docs/superpowers/plans/2026-08-17-remove-visible-developer-attribution.md \
  imvia-ui-layer-review-canvas/src/workbench-toolbar.test.mjs \
  imvia-ui-layer-review-canvas/src/release-branding-contract.test.mjs \
  imvia-ui-layer-review-canvas/src/main.jsx \
  imvia-ui-layer-review-canvas/src/attribution.js \
  imvia-ui-layer-review-canvas/src/styles.css
/Users/a1234/.cache/codex-runtimes/codex-primary-runtime/dependencies/bin/fallback/git commit -m "fix: remove visible developer attribution"
```

Do not stage or delete the pre-existing untracked `.vite` files.
