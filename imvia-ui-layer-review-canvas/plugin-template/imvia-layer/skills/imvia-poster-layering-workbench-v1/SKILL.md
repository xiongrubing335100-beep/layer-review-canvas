---
name: imvia-poster-layering-workbench-v1
description: Execute a workbench-authorized poster analysis or exactly one poster-layer candidate through the immutable lovart-poster-layering-v3-1 contract.
---

# Imvia Poster Layering Workbench v1

This adapter translates a trusted Imvia workbench task into the immutable `lovart-poster-layering-v3-1` process. It never replaces, copies, or edits that base skill.

## Required authority

Before any visual work, read all of the following in full:

1. `../lovart-poster-layering-v3-1/SKILL.md`
2. `../lovart-poster-layering-v3-1/references/layer-rules.md`
3. `../lovart-poster-layering-v3-1/references/prompt-templates.md`

Resolve `RUNTIME_DIR` as the adapter skill directory's sibling-relative `../../runtime` directory. Run `${RUNTIME_DIR}/scripts/prepare-poster-job.mjs` before work. Its JSON is trusted; do not improvise paths, plan versions, target layers, candidate numbers, or destination directories. The source full canvas is the only visual authority. Use `${RUNTIME_DIR}/scripts/finalize-poster-analysis.mjs` and `${RUNTIME_DIR}/scripts/finalize-poster-candidate.mjs` for finalization; this installed runtime is self-contained and must not depend on the caller's current directory or a source checkout.

The base contract is fixed: front-to-back ownership; one owner per visible pixel; full source canvas at original coordinates; evidence-limited repair envelopes; locked visible anchors; one candidate per explicit authorization; no automatic retry. Normal opaque assets key all non-asset pixels with `#00FF00`; Screen/Add effects use `#000000`. Never mix alpha into a keyed candidate.

The mechanical finalizer requires a real keyed field, not an incidental key-colour pixel: an exact `#00FF00` or `#000000` RGB region connected to the canvas border and covering at least 2% of the canvas (minimum two pixels), with no alpha channel. This proves the candidate retains a meaningful full-canvas background field while allowing every v3.1 normal/effect processing mode.

## Analysis task (`task_kind: poster_analysis`)

Confirm receipt and run the trusted preflight. Inspect the full source, then create source evidence and a front-to-back ownership plan containing every v3.1 required layer field. Separate independently movable dates, CTA cards, prices, badges, logos, corner marks, and icon groups by default.

Read the root `poster-layer-plan.json` as authority, but write evidence and the complete replacement plan only to the preflight-supplied candidate path under `evidence/`. Never overwrite the root authority directly. Finish with terminal `PLAN_REVIEW` by running `${RUNTIME_DIR}/scripts/finalize-poster-analysis.mjs` using that candidate plan; the finalizer validates it and atomically updates authority. **禁止调用 ImageGen。** Do not create candidate or formal-layer files, and do not mark a plan confirmed.

## Candidate task (`task_kind: poster_candidate`)

Confirm receipt, then verify the preflight `plan_version`, consumed Task 3 `GENERATION_AUTHORIZED`/`RETRY_AUTHORIZED` authorization, `authorization_id`, `layer_index`, candidate number, source path, and deterministic candidate destination against the plan. **只处理 preflight 指定的 layer_index；不得处理任何其他层。**

Use the v3.1 base prompt block plus exactly one matching type block. Make **only one ImageGen call** with the full source poster as the only visual authority. Save exactly one raw PNG candidate through `${RUNTIME_DIR}/scripts/finalize-poster-candidate.mjs`; never overwrite a prior candidate. Visually compare the actual candidate to the full source and prepare a release-gate report. **If ImageGen returns no usable PNG or no review report, do not leave the dispatched task open: immediately run `${RUNTIME_DIR}/scripts/finalize-poster-generation-failure.mjs --output-root <output-root> --job-id <job-id> --layer-index <layer-index> --dispatch-id <dispatch-id> --failure-code IMAGEGEN_NO_PNG --message <message>`.** Its dispatch is the authority for the candidate number, authorization, and plan version; do not supply or invent those values. Record v3.1 hard failure codes for invented effects, UI bundling, anchor mutation, whole-asset redraw, envelope overreach, missing completion, structural breakage, text/logo mutation, background drift, ownership/effect/leak/registration/key/canvas failures. Use `NEEDS_USER_REVIEW` only when no hard failure exists.

Stop after finalization. Do not accept the candidate, do not write `layers/`, do not normalize, publish, recomposite, export, or retry. Only the local user-acceptance interface may place a non-generatively normalized result in `layers/`.
