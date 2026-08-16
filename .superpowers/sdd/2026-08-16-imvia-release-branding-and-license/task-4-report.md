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
