# Final release fix report

## Status

All authoritative final-review findings were implemented on
`codex/release-workbench` from baseline `c03547f`. The known untracked legacy
`ui-layer-review-canvas/.vite` cache was left untouched.

## Changes

- `npm run setup` and `npm run update` now fail closed through the exact order:
  dependency-free Node preflight, `npm ci`, production build, then the locked
  Python/model/plugin lifecycle. A tracked-files archive regression begins
  without `node_modules` or `dist`, runs both commands, replaces an injected
  stale bundle, and completes a real MCP initialize through the installed
  `.mcp.json`.
- Setup now owns the stable parent lifecycle lock continuously from the first
  managed-Python mutation through model prewarm, Node runtime publication,
  plugin copy/config publication, and marketplace registration. Named
  lock-held APIs replace the former `lockAlreadyHeld` boolean path. Direct
  install, runtime repair, uninstall, and marketplace updates use the same
  parent lock.
- The plugin template now ships a byte-identical copy of the canonical
  Imvia license, a complete Imvia/author/commercial/third-party/Node runtime
  NOTICE, and manifest `license: "SEE LICENSE IN LICENSE"`. Installation no
  longer rewrites the manifest, so LICENSE, NOTICE, and manifest hashes remain
  byte-identical after install.
- Package engines, both public READMEs, and the GitHub release guide require
  `^20.19.0 || >=22.12.0` and recommend Node.js 22 LTS. The dependency-free
  preflight accepts 20.19, 22.12, and 24 while rejecting 20.18, 21, and 22.11.
- CI now uses real Node 20.19.0 on macOS and Windows, starts with `npm ci`,
  performs one declared production build plus exact-one-banner verification,
  runs every `src/*.test.mjs`, installs the real hashed managed runtime without
  model prewarm, verifies runtime/license/template hashes, and runs complete
  Python discovery with managed `rembg`.
- Uninstall output now names both managed Python and Node runtimes. Public
  update instructions use `npm run update`, whose dependency/build behavior is
  the same self-contained release path as setup.

## RED evidence

- Focused release tests failed with no dependency-free preflight module,
  missing `update`, setup lacking a build, missing plugin LICENSE/manifest
  license, incomplete plugin NOTICE, and old documentation/CI contracts.
- Two independent-process lifecycle tests failed before refactoring because
  setup did not expose or hold one complete lifecycle critical section.
- The clean tracked archive failed with `MODULE_NOT_FOUND` for the unshipped
  preflight, demonstrating that a fresh distribution was not self-contained.
- A manifest-mutation check changed installed `plugin.json` after template
  copy; the SHA-256 parity test failed on the exact manifest hash.
- Reverting uninstall copy to the old Python-only sentence made the focused
  behavior test fail on the missing Node runtime statement.
- The CI contract failed on Node 24-only, filtered tests, absent complete
  Python discovery, and absent explicit banner/runtime parity verification.

## GREEN evidence

- Complete Node suite: **451 passed, 0 failed, 0 skipped**.
- Clean tracked archive: **1 passed**; setup and update each ran real `npm ci`
  and production build, stale `dist/index.html` was removed, installed
  LICENSE/NOTICE/manifest hashes matched, and MCP initialize succeeded with no
  `ENOENT`.
- Managed Python discovery: **68 passed, 0 failed**, including `rembg` import
  and RMBG finalizer tests.
- Production build: Vite 8.1.5, **1,798 modules**, one emitted JavaScript
  bundle with the Imvia legal banner **exactly once**.
- Real lifecycle: locked uninstall succeeded; fresh setup installed **121 npm
  packages**, built production assets, rebuilt Python 3.12/rembg 2.0.69 and
  Node v24.19.0 runtimes, prewarmed BRIA RMBG 2.0, and registered the plugin.
  A subsequent real `npm run update` repeated dependency sync/build and reused
  the verified model/runtime before re-registration.
- Runtime verifier: Python lock SHA-256
  `ca8cb0354db7f7858bbd66c4c922a3f0eb1eb9b35af6cc66c2981d63ad2109c9`;
  Node executable/version/LICENSE checks and installed
  LICENSE/NOTICE/manifest hash parity all passed.
- Canonical root, application, and plugin-template LICENSE files are
  byte-identical. `git diff --check` passed.

## Concerns

- Physical verification was performed on macOS with Node v24.19.0. The
  committed workflow gives macOS and Windows real Node 20.19 coverage, but
  remote GitHub Actions and a physical Windows host were not run in this task.
- `npm ci` reported four dependency audit findings (two moderate, two high).
  No unreviewed `npm audit fix` was applied because it could change the locked
  dependency graph outside this focused release fix.
- The release continues to preserve the custom Imvia license, passive author
  URL/attribution, and no-watermark/no-telemetry boundaries.
