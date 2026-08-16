# Task 4 Report — Metadata, source headers, and build banner

## Status

Completed with Fix Round 1. The application package and plugin metadata credit 青木, link to the final repository and author profile, and use the custom `SEE LICENSE IN LICENSE` marker. Critical source entries carry concise transparent attribution headers. Vite/Rolldown now preserves the attribution banner in minified production JavaScript through `output.comments.legal: true`.

## TDD evidence

- Initial RED: the expanded `release-branding-contract.test.mjs` failed because package author metadata and source attribution were absent.
- Fix Round 1 RED: a real temporary `vite build --sourcemap` emitted an `index-*.js` bundle with **0** `Imvia Layer © 2026 青木` banner occurrences. This proved the original `output.banner` alone was removed by Vite 8 minification.
- Fix Round 1 GREEN: adding `output.comments: { legal: true }` made the temporary sourcemapped production-build contract pass. Every emitted JavaScript bundle contains the legal banner exactly once; each `.map` parses and identifies its associated bundle.

## Verification

- `/Users/a1234/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node --test src/release-branding-contract.test.mjs` — 10 passed, 0 failed after Fix Round 1.
- `/Users/a1234/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node --test src/*.test.mjs` — 408 passed, 0 failed.
- The release contract now also verifies root lock-license parity, full package/plugin project metadata, passive attribution structure, and absence of hidden attribution-related networking controls.
- `/Users/a1234/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node node_modules/vite/bin/vite.js build --sourcemap` — succeeded; direct artifact inspection confirmed every emitted JavaScript bundle has one legal banner and a valid associated source map.
- Production verification also uses `vite build --sourcemap` in a temporary directory and inspects every emitted JS bundle and its parsed source map rather than checking only the first `dist` file.
- `git diff --check` — no whitespace errors.

## Concerns

- The existing untracked `ui-layer-review-canvas/.vite/` cache directory was intentionally left untouched.
- Attribution remains passive metadata, comments, and a build banner only: no telemetry, fingerprinting, hidden network access, license checks, or PNG watermarking was added.

## Fix Round 2 — Prohibited-control and watermark contracts

### RED / GREEN

- RED: temporarily injected nested `attribution.remoteDisable` metadata into `package.json`. The focused contract failed exactly as intended, reporting `attribution (key)` and `attribution.remoteDisable (key)`.
- GREEN: removed the temporary fault. The recursive manifest contract now rejects prohibited keys and string values at every depth, while exactly allowlisting `license=SEE LICENSE IN LICENSE`.
- No production behavior changed: the fix is a regression contract only.

### Coverage and verification

- Locks the current package scripts and rejects all npm lifecycle hooks capable of hidden pre/post-install licensing behavior.
- Restricts transport and enforcement assertions to the attribution module, source headers, Vite attribution configuration, and plugin developer metadata; it deliberately leaves legitimate Codex/MCP local communication and existing `sourceFingerprint` behavior out of scope.
- Proves attribution stays out of PNG finalizers, RMBG, and the export/download composition block. It treats the required Python header separately, then rejects author URL/banner/watermark injection in the finalizer bodies.
- Focused contract: 13 passed, 0 failed. Full Node suite: 411 passed, 0 failed.
- `vite build --sourcemap`, every-bundle legal-banner/source-map inspection, and `git diff --check` all passed.

## Fix Round 3 — Render tree, entry body, and complete PNG-path isolation

### RED / GREEN

- RED: temporarily injected a guarded `new Image()` allocation into `src/attribution.js`. The new rendered-attribution contract failed exactly on the tracking/resource-node prohibition.
- GREEN: removed the temporary injection. The production module remains unchanged; the fix is limited to regression contracts.

### Coverage and verification

- Renders the developer attribution component and permits one exact-author `a` link with text-only inline content, while rejecting resource elements, event handlers, and image/network tracking APIs.
- For every Task 4 header entry, strips only the legal first-line comment before asserting the entire body contains no author URL, copyright/author text, or author/banner constant markers. Plugin metadata remains verified structurally in its dedicated manifest test instead of being treated as an entry script.
- Covers actual pixel generation and delivery sources: `finalize-targeted-job.py`, `finalize-rmbg.py`, `result_refinement_roi.py`, `prepare-targeted-imagegen-canvas.py`, plus the complete `main.jsx` crop-canvas and direct export/download sections. It allows legitimate `canvas`, `drawImage`, and `ImageDraw` processing while rejecting author constants, URLs, watermarks, and text-drawing injection.
- Focused contract: 16 passed, 0 failed. Full Node suite: 414 passed, 0 failed.
- `vite build --sourcemap`, per-bundle legal-banner/source-map inspection, and `git diff --check` all passed.
