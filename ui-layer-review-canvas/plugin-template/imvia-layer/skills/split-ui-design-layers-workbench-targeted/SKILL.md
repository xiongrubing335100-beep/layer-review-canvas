---
name: split-ui-design-layers-workbench-targeted
description: "Execute targeted UI layer records submitted by the local infinite-canvas workbench in fast or quality mode. Use when a workbench plan provides authoritative layers[], exact selected records, pixel regions, mask annotations, remove-background settings, per-layer requirements, execution route hints, execution modes, and an absolute output directory. Never diagnose the whole page or add inferred layers."
---

# Targeted UI Workbench Executor

## Workbench Authority

Treat the submitted workbench plan and its authoritative `layers[]` as the complete execution contract.

- Read the plan JSON before editing. For fast `direct_crop`, `alpha_extract`, and `codex_rgba`, use the
  submitted exact crop and do not reopen the full source image. Read the full source only for
  `quality`, `targeted_repair`, or `kvBackground`; for `result_refinement`, read and attach only the
  current successful base PNG.
- Process exactly the records in `layers[]`, in `layer_index` order.
- Do not add, split, merge, rename, omit, or rediscover records.
- Do not perform whole-page diagnosis or create another manifest.
- Treat each record as a targeted job defined by its `name`, `category`, `source_region_pixels`, `mask_annotations`, `remove_background`, `requirement`, `execution_route_hint`, and `execution_mode`.
- Before visual work, run the repository's `scripts/prepare-targeted-job.mjs` for this `jobId` and use its `preflight.json` as the machine-readable execution specification. If preflight fails, stop and report the task as failed; do not improvise paths, dimensions, layers, or context attachments.
- Use `fast` when `execution_mode` is absent.
- Use the plan's absolute `output_directory` as the only legal final delivery directory.
- Never redirect final output to the current Codex working directory, a temporary project, or another same-named job folder.

This skill decides how to execute a confirmed record. It never decides what the user should have selected.

## Single-Turn Intent Normalization

Normalize short, colloquial, or empty requirements inside this same execution turn.
Do not create another Codex turn and do not pause for ordinary normalization.
Preserve explicit user instructions. Use the category route only to fill missing constraints.
Pause only when ownership of multiple independent components is unresolved, keep/remove
instructions conflict on the same structure, or the request both preserves and removes the same target.

## Mechanical Preflight Boundary

The preflight executor may only read the authoritative plan, verify the job directory, source and
crop files, layer order, logical placement dimensions, output-directory containment, and declared
repair-region sources. It may normalize whitespace and record timestamps, but it must not inspect
pixels, generate content, create masks, call ImageGen, call RMBG, or write anything into `final/`.

Use the returned `repair_engine`, `requires_global_context`, `maximum_imagegen_calls`,
`transparency_strategy`, `rmbg_required`, `structure_validation_required`,
`output_resolution_policy`, and `expected_output`
fields as the execution contract. Missing fields in legacy
plans are conservatively inferred by the executor; never infer a new layer or a repair region.

## Execution Route Hint

- `direct_crop`: crop exact source pixels, skip segmentation and generation.
- `alpha_extract`: run the submitted exact crop through RMBG as the final background-removal
  step, preserve its RGB result, and skip generation.
- `codex_rgba`: prepare a source-locked native ImageGen canvas and ask ImageGen for a semantic
  black-background/white-subject alpha matte, then mechanically map only the declared content
  region back to the exact crop and apply it to the untouched source RGB. Never ask ImageGen to
  redraw the final glyph RGB, because its native output canvas is not the requested crop size.
  Never call RMBG for this route.
- `codex_rgba_repair`: use when a text/title/logo layer requires true transparency and also needs
  an occluded or removed portion completed. Prepare both `reference_path` and the mapped
  `repair_scope_path`. First generate and accept repair RGB from those two references. You must
  complete the hidden RGB structure before generating the alpha matte. Only after that candidate
  passes structural inspection may ImageGen generate one full-subject alpha matte from the accepted
  repair RGB. The finalizer intersects that alpha with submitted `repair_regions` for repair writes,
  keeps visible source RGB outside that scope, and uses the same cleaned alpha for the final cutout.
  Never use RMBG or accept a black plate/full-opaque result. Fast mode budgets three calls (two
  required stages plus one retry for one failed stage); quality budgets four (one retry per stage).
- `targeted_repair`: prepare the standard ImageGen reference canvas and mapping, then repair only
  approved holes inside its declared `content_region`. With `transparency_strategy: rembg` and
  `output_resolution_policy: native_imagegen_content`, accept an ImageGen result at a different
  native pixel size when its canvas aspect ratio and composition remain unchanged; scale the
  mapping coordinates uniformly and keep the extracted native `content_region` resolution through
  RMBG and delivery. Reject aspect-ratio changes, stretched or compressed content, and composition
  drift. `expected_output` remains the infinite-canvas logical placement size. Without this native
  output policy, map the prepared region to the exact logical crop.
- `result_refinement`: treat the current successful PNG as the only authoritative base, preserve
  its actual pixel dimensions and alpha, and edit only the scope compiled from the structured
  operation and closed Bézier pen paths. Natural-language text supplies the visual goal, never the
  scope or Alpha authority. This route must never call RMBG.

Honor a submitted `execution_route_hint`. When it is absent, select the narrowest route that
satisfies the normalized record requirement: `direct_crop`; `codex_rgba_repair` when text, title,
or logo transparency also requests occlusion/hidden-area completion; `codex_rgba` for text, title,
and logo transparency without repair; `alpha_extract` for other subject transparency; then
`targeted_repair`. A route must
preserve crop-relative coordinates, the mask-priority result, and final RGBA output. Preserve exact
crop pixel dimensions except when `output_resolution_policy: native_imagegen_content` applies to a
`targeted_repair` RMBG record.

For `fast`, do not create candidates speculatively or perform full-page analysis. Call ImageGen only for `targeted_repair`, `codex_rgba`, `codex_rgba_repair`, or `result_refinement`, and never exceed
`maximum_imagegen_calls`. Create each first required working result and immediately run the
first-candidate gate below. Accept a passing result without another call. Only when that result
fails may one targeted ImageGen retry address the failed checks; for `result_refinement`, this
limit applies independently to each `roi_job`. If the retry fails, stop. For `quality`, keep the
same route and call ceiling but add the existing validation depth.

## PNG Result Refinement

For `execution_route_hint: result_refinement`, the 当前成功 PNG is the only authoritative base.
Do not fall back to the original source or any earlier PNG version, logical selection crop, canvas
screenshot, or other visual context. Its decoded pixel dimensions are the final dimensions.

Read the trusted version-2 policy from preflight before visual work. Use
`normalized_user_requirement` as the visual goal, and verify the structured summary from
`refinement_operation`, `repair_path_ids`, `erase_path_ids`, `protect_path_ids`,
`subject_path_ids`, and `alpha_include_path_ids`. The declared `expected_roi_tile_count` is the
exact repair ROI count. `maximum_imagegen_calls` must equal twice that count: one initial candidate and at most one retry per `roi_job`. Text alone never grants local or full-canvas scope;
`full_canvas_explicit` is valid only when it is already present in the trusted policy.

Run the preparation command exactly as supplied in the workbench message, using its resolved Python invocation
and absolute path to `scripts/prepare-targeted-imagegen-canvas.py` with the active
`--job-id <jobId> --layer-id <layerId>` arguments. This invocation may be `py -3` on Windows; never
replace it with a guessed `python3` or a repository-relative script path.

The preparation result is a version-2 `result_refinement_roi_manifest`. Process its `roi_jobs` one
at a time. Give ImageGen only that job's `reference_path`; keep the declared canvas and
`content_region` at native 1:1, and enforce the job's manifest-authorized scope. A local `roi_job`
uses its closed repair-path mask. A job with `path_id: "full-canvas"` has no repair-path mask and
instead uses the manifest's explicit full-canvas tile and `content_region` as its authorized scope.
Never merge distant jobs, perform whole-page analysis, or use a forced resize to make a candidate
fit. Save each accepted candidate outside `final/`.

A candidate may be RGB or RGBA. Candidate RGB inside the manifest-authorized scope may be used, but
candidate Alpha is not authoritative. Final Alpha comes from the base PNG plus the structured
`erase_path_ids`, `subject_path_ids`, `alpha_include_path_ids`, and protected base pixels. Never
paint a checkerboard, infer transparency from chroma, create a chroma mask, or perform
prompt-inferred deletion. All pixels outside the manifest-authorized scope remain byte-for-byte locked to the
base, and protected paths restore the base RGBA last. Never call RMBG.

For each `roi_job`, make one initial ImageGen call. Inspect it before finalization; only a failed
candidate may receive one retry for the failed checks. An empty `roi_jobs` array must not call ImageGen:
continue directly to deterministic Alpha composition. If a candidate still fails, stop, keep the
current successful PNG visible and unchanged, and write no replacement into `final/`.

Bind every accepted candidate with one repeatable
`--generated-input roi-id=/absolute/path.png` argument. Then run the workbench-supplied resolved
Python invocation and absolute path to `scripts/finalize-targeted-job.py`, passing the active
`--job-id`, `--layer-id`, every candidate binding, and the absolute manifest path through
`--imagegen-mapping`. A zero-ROI task passes no `--generated-input` arguments.

Complete all visual inspection and retry decisions before the finalizer. A successful finalizer
must be the last tool call in the Codex turn; immediately return the finalizer-approved PNG path and
end the reply. Do not preview, reread, list, or validate anything after it.

## Performance Report

Write `execution-report.json` outside `final/` with:
`status`, `execution_route`, `timing.submitted_at`, `timing.codex_turn_started_at`,
`timing.preflight_started_at`, `timing.preflight_completed_at`, `timing.intent_normalized_at`, `timing.extraction_started_at`, optional
`timing.repair_started_at`, `timing.validation_started_at`, `timing.completed_at`, optional
`fast_path`, `output_resolution_policy`, `asset_dimensions`, `logical_placement`, and
`validation_results`. Set `fast_path` to `accepted_first_candidate`,
`accepted_retry_candidate`, or `not_applicable`. Record `validation_results` as an object with boolean `count`,
`dimensions`, `alpha`, `annotation_conformance`, and `obvious_exclusion` fields. Set each field
to `true` only after its mandatory check passes. Write the report at
`dirname(output_directory)/execution-report.json`, the parent job directory; never write it in
`final/`.

### Terminal Report Invariant

Before completing the Codex task or sending a final reply, write exactly one terminal top-level
status to `execution-report.json`: use `"status": "completed"` only after every final PNG and
mandatory validation has passed, otherwise use `"status": "failed"` with a concise `error`.
Successful reports must also include `execution_route`, `timing.completed_at`, and
`validation_results`. A valid PNG without this terminal status is an unfinished workbench task,
even if the originating Codex turn is still active.

### Terminal Fast-Stop Invariant

Complete every visual comparison, candidate inspection, annotation check, and retry decision before
calling the mechanical finalizer. The finalizer is the acceptance gate, not an intermediate result.

When the finalizer returns `status: completed` after atomically writing the PNG and terminal
`execution-report.json`, that finalizer call must be the last tool call in the Codex turn. Immediately
send the concise final reply with the returned output path and end the turn. Do not call `view_image`,
reopen the PNG, generate preview backgrounds, inspect alpha statistics, reread the report, list the
directory, run another shell command, or repeat validation after completion. Those checks must live
inside the finalizer or occur before it. A workbench result card that already shows the completed PNG
must never wait for redundant Codex-side verification.

If the finalizer fails, follow the permitted retry rule. The fast-stop invariant applies only after a
successful terminal result.

## Execution Modes

### `fast`

Use the shortest source-pixel-first route:

1. Normalize the record and execute its selected route directly from the exact `source_region_pixels` and submitted annotations.
2. Do not create alternate candidates before the first-candidate gate or perform full-page analysis.
3. Use `targeted_repair` only when the requirement explicitly needs approved text removal, hole filling, or occlusion completion. Create one first working result.
4. Immediately validate that result for the dimensions required by `output_resolution_policy`, annotation conformance, obvious exclusions, and structural integrity. When all four pass, accept it and skip repair-mask generation and source-locked recomposition.
5. Only when the first working result fails this gate, perform one targeted ImageGen retry for the failed checks. Reuse the exact submitted crop and approved repair scope; do not infer a new region, create a third candidate, or upgrade to `quality`. A `codex_rgba` candidate must preserve the prepared native canvas. A `targeted_repair` candidate under `native_imagegen_content` may use ImageGen's different native pixel dimensions when the canvas aspect ratio and composition remain unchanged; proportionally scale the declared `content_region` coordinates and keep the resulting native pixels. For `result_refinement`, apply the gate and one-retry ceiling to each manifest `roi_job`. Retry an aspect-ratio or composition failure once; never stretch, compress, or force-resize an arbitrary ImageGen canvas into the requested crop or ROI.
6. Run the mandatory count, dimensions, alpha, annotation-conformance, and obvious-exclusion checks. Annotation conformance must honor forced keep and exclude annotations; when they overlap, the larger `order_index` wins.
7. Emit no more than one progress message before final delivery.

### `quality`

Use the complete targeted route:

1. Execute the same selected route for the submitted region, with one source-locked local candidate when validation requires it.
2. Apply generation only to approved repair holes under `targeted_repair`, a semantic matte under
   `codex_rgba`, or the submitted mutable scope under `result_refinement`.
3. Compare the candidate against source pixels, annotations, geometry, material continuity, and alpha edges.
4. If a check fails, perform at most one targeted retry for the failed area only.
5. Run the complete acceptance gate before delivery.

Both modes must preserve logical placement dimensions, real alpha, forced keep and exclude
annotations, and reliable original visible pixels. Asset pixel dimensions follow
`output_resolution_policy`; the mode changes repair depth and validation effort, not that contract.

## Per-Record Workflow

For every submitted record:

1. Use the preflight specification for `source_region_pixels`, `mask_annotations`, `requirement`, `remove_background`, `execution_mode`, context attachments, logical placement dimensions, and output resolution policy.
2. Build the working crop from the exact selected rectangle. Do not broaden it to nearby controls or visually similar repeated items.
3. Apply submitted annotations and complete the requested split structure.
4. Follow the selected execution mode and route. In fast `direct_crop` and `alpha_extract`, execute directly. In fast `targeted_repair`, `codex_rgba`, `codex_rgba_repair`, and `result_refinement`, run the first-candidate gate and short-circuit accepted work before any retry.
   For `targeted_repair`, first run `scripts/prepare-targeted-imagegen-canvas.py` with the current
   `jobId` and `layerId`. Give ImageGen only the returned standard reference canvas, require the
   aspect ratio, composition, and approved repair scope to remain unchanged, and edit only approved
   holes inside the returned `content_region`. Save the native result in `generated/`. Under
   `native_imagegen_content`, a same-aspect-ratio native result such as `1024×1024 → 1254×1254` is
   valid and must be passed unchanged to the finalizer; do not resize it manually. A changed aspect
   ratio, stretched geometry, or composition drift is a failed candidate.
   For `codex_rgba`, first run `scripts/prepare-targeted-imagegen-canvas.py` with the current
   `jobId` and `layerId`. Use only the returned reference canvas for ImageGen and request a pure
   black-background/white-subject alpha matte without moving, resizing, redrawing, or reflowing the
   content region. Compare its full glyph or logo structure against the submitted crop on both light
   and dark preview backgrounds after the source RGB has been composed with the matte.
   Reject missing strokes, fragmented glyphs, altered wording, changed proportions, opaque
   backplates, or modified source material. Retry once only for failed checks. Do not fall back to RMBG.
   For `codex_rgba_repair`, obey the returned `stage_reference_policy`. Generate repair RGB from
   `reference_path` plus `repair_scope_path`, inspect it immediately, and save the accepted repair
   RGB path. Reject it before cutout when hidden structure is incomplete, retains the original
   occluder, breaks a junction, changes reliable visible pixels, or mismatches the visible stroke
   width, outline, gradient, texture, material, or lighting. Inspect the repaired junction enlarged
   on both light and dark backgrounds. Then generate one full-subject alpha matte using only the
   accepted repair RGB; do not use the original occluded reference or the repair-scope overlay for
   this cutout stage. The finalizer must receive `--generated-input` and `--alpha-matte-input`
   together with `--imagegen-mapping`; it cleans model matte haze, writes repaired RGB only where
   the cleaned alpha intersects submitted `repair_regions`, and locks visible source RGB everywhere
   else. Fast mode allows the two required calls plus one retry for exactly one failed stage;
   quality allows one retry per stage. Stop immediately and write a failed terminal report
   if a stage cannot pass within that budget; never continue to later stages after a failed repair
   RGB.
   Keep the workbench synchronized by running
   `node scripts/update-targeted-job-stage.mjs --job-id <jobId> --layer-id <layerId> --status <status>`
   before each repair stage: use `repair_rgb` before the repair RGB call, `alpha_matte` before the full-alpha
   call, and `finalizing` immediately before the finalizer.
   These are non-terminal reports: preserve the current job and layer metadata, omit
   `timing.completed_at`, and never claim a later stage before the preceding candidate has passed.
   A rejected stage must write `failed` with its concrete validation reason instead of leaving the
   workbench spinning on `finalizing`.
   For `result_refinement`, follow **PNG Result Refinement** above: run the workbench-supplied
   preparation command, then process the returned version-2 manifest one `roi_job` at a time. Attach
   only the current job's `reference_path`, enforce its closed-path mask, and never call RMBG.
5. For `targeted_repair`, pass the native generated canvas plus the returned mapping JSON to
   `scripts/finalize-targeted-job.py --imagegen-mapping`; the finalizer validates the canvas aspect
   ratio, uniformly scales mapping coordinates when ImageGen returned a same-ratio native size, and
   extracts only the declared content region. If the record uses RMBG with
   `output_resolution_policy: native_imagegen_content` (also the legacy default for targeted repair
   plus RMBG), the finalizer sends that native region directly to RMBG and delivers the same pixel
   dimensions. It must not resize to `expected_output` before RMBG. Otherwise it performs the
   deterministic mapping to the exact logical crop. Do not pre-resize the generated canvas.
   For
   `codex_rgba`, pass the generated matte plus the returned mapping JSON to
   `scripts/finalize-targeted-job.py --imagegen-mapping`; the finalizer extracts only the declared
   content region, maps its alpha to the exact crop, and keeps the original source RGB. Treat the crop
   top-left as output coordinate `0,0`.
   For `codex_rgba_repair`, pass the accepted repair RGB candidate, full alpha matte, and
   returned mapping JSON to `scripts/finalize-targeted-job.py` with
   `--generated-input` and `--alpha-matte-input`. The finalizer extracts the exact content region,
   intersects the cleaned alpha with submitted repair regions for RGB writes, locks source RGB
   everywhere else, and applies that same alpha to the completed subject without RMBG.
6. Save the accepted Codex split result inside the job's `generated/` directory, outside `final/`.
7. Run the repository's mechanical finalizer with the current `jobId`, `layerId`, and generated
   input. The finalizer enforces policy-selected asset dimensions, declared repair-region source
   locking, atomic PNG delivery, true-alpha and source-RGB validation for `codex_rgba` and
   `codex_rgba_repair`, and the
   existing `scripts/finalize-rmbg.py` call only when `rmbg_required` is true.
   Do not create a custom mask or substitute chroma, contour, dilation, or blur extraction.
8. Write only the finalizer-approved PNG into `output_directory`.
9. Preserve the source x/y only as placement metadata in the execution report.

Independent records may run in parallel, but each generation request must describe only one submitted record.

## Mask Priority

Resolve selection and transparency in this order:

1. Treat `source_region_pixels` as a candidate work area, not as the final subject mask.
2. Apply keep annotations as forced subject ownership.
3. Apply exclude annotations as forced removal. When keep and exclude overlap, the annotation with the larger `order_index` wins.
4. Apply brush strokes as the highest-priority contour guide. A contour guide refines the edge but does not independently label either side.
5. Infer only unresolved pixels inside the candidate work area from the source and record requirement.
6. Apply the submitted `transparency_strategy` only after the complete split structure exists.
   For `codex_rgba`, the complete Codex result itself must already be transparent and must bypass
   RMBG. For `rembg`, pass the complete result through RMBG and use the accepted RMBG PNG.

RMBG-routed background removal must never be replaced by an assistant-authored mask,
color-distance key, contour expansion, dilation, or Gaussian edge blur. The black/white matte used
by `codex_rgba` must be authored by ImageGen on the prepared source-locked canvas; local code may
only perform the declared geometric mapping and source-RGB composition. It must not infer or repair
the subject mask.

## Category Routes

### `kvTitle`

Isolate only the selected title artwork. Preserve glyph design, bevel, outline, inner texture, and title-owned effects requested by the record. Repair only explicitly requested hidden title parts. Exclude nearby KV decoration unless the record owns it.
When background removal is requested, require `codex_rgba`; reject plans that route this category
through BRIA RMBG 2.0 (`bria-rmbg`) unless the authoritative plan is an explicit legacy record.

### `kvElement`

Isolate only the selected visual object and its owned shadow or attached decoration. Preserve usable source pixels. Complete only explicitly hidden or occluded parts. Exclude nearby independent objects.

### `kvBackground`

Create a clean plate only for the submitted background record. Preserve unoccluded source pixels. Remove only the foreground identified by its region, annotations, and requirement, then fill only the resulting holes.

### `ordinaryText`

Extract only the ordinary UI text covered by this record. Preserve source glyph pixels, antialiasing, color, and crop-relative position. Do not include button, card, badge, or panel fills.
When background removal is requested, use `codex_rgba` and visually verify every glyph before
finalization. An opaque crop or partial glyph fragments are failures.

### `uiComponent`

Produce only the selected component. When the requirement asks for a clean base, remove ordinary text and separately editable content, then reconstruct only the holes in the base material. Preserve component-owned borders, gradients, highlights, shadows, and glows.

## Pixel And Repair Rules

- Prefer original visible RGB wherever the boundary is reliable.
- Lock unaffected source pixels during text removal and occlusion repair.
- Use ImageGen only for approved hidden-pixel repair under `targeted_repair`, semantic matte work
  under `codex_rgba`, or the submitted mutable scope under `result_refinement`; never redesign the
  complete selected component.
- Reject candidates that change proportions, gradients, bevel depth, icon identity, compression texture, or source geometry outside an approved repair hole.
- Do not substitute blur, clone smearing, broad inpainting, or a similar-looking generated component for a failed repair.
- When `remove_background` is true, follow `transparency_strategy`. A `codex_rgba` ImageGen result
  must be a black/white semantic matte on the prepared native canvas; the finalizer turns that matte
  into real alpha while preserving source RGB. A `rembg` candidate must be complete before the
  workbench RMBG finalizer runs. Never bake a checkerboard into either candidate.

## Output Contract

- Deliver exactly one PNG for every successful submitted record.
- Use the record `id`, or normalized `layer_index` plus `name`, for the filename.
- `expected_output` and `source_region_pixels` always define logical placement, not an instruction
  to downsample a high-resolution generated asset.
- For `targeted_repair` plus RMBG, the final PNG must match the native mapped `content_region`
  dimensions. For every other route, it must match `source_region_pixels.width` and
  `source_region_pixels.height`.
- Final pixels outside the selected subject inside the crop must be transparent RGBA.
- For `transparency_strategy: codex_rgba`, keep the prepared reference, mapping JSON, and ImageGen
  matte outside `final/`, then run `scripts/finalize-targeted-job.py --imagegen-mapping <mapping>`.
  It must reject a changed native canvas, a matte without black and white extrema, opaque output,
  or changed source glyph RGB.
- For `execution_route_hint: targeted_repair`, keep the standard reference, mapping JSON, and native
  ImageGen result outside `final/`, then pass both result and mapping to the targeted finalizer. With
  `native_imagegen_content`, it must accept a same-aspect-ratio native canvas, scale the mapping
  coordinates uniformly, and reject only aspect-ratio, geometry, or composition changes before any
  RMBG step. When RMBG is required, it must extract the native `content_region`, run RMBG at that
  resolution, and return the high-resolution PNG.
- For `transparency_strategy: rembg`, write the pre-RMBG image outside `final/`; the targeted
  finalizer runs `scripts/finalize-rmbg.py` with the actual candidate asset width and height.
- Put diagnostics, prompts, masks, and reports outside `final/`.
- Keep `final/` limited to the submitted element PNG files.
- Before reporting completion, verify each delivered PNG resolves inside the exact absolute `output_directory`.

## Acceptance Gate

For every record, always verify:

1. Exactly one expected final PNG exists and no unrequested final PNG exists.
2. Its dimensions match `asset_dimensions`: the native mapped `content_region` for targeted repair
   plus RMBG, otherwise the selected rectangle.
3. Its visible element has no crop-relative coordinate drift.
4. Forced keep and exclude annotations conform to the submitted mask; when they overlap, the larger `order_index` wins. Neighboring components are absent.
5. Transparent areas contain real alpha and no green, magenta, black slab, checkerboard, or unrelated residue.
6. For `codex_rgba`, every submitted glyph or logo structure remains complete when previewed on
   both light and dark backgrounds, and reliable visible RGB stays source-faithful.

For `quality`, also verify:

7. Reliable original details remain source-faithful outside approved repair holes.
8. Removed text or content leaves a complete base with no glyph cavity or imprint.
9. Geometry, material continuity, shadows, glows, and edge antialiasing match the source.

If a record cannot pass within its mode's retry limit, keep diagnostics outside `final/` and report the record as failed. Do not invent a replacement layer or expand the task.
