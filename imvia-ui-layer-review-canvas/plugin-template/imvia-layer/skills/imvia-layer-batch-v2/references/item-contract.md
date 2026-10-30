# V2 item contract

## Immutable identity

Before touching pixels, compare the returned processing manifest with the frozen batch record: `batchId`, `attemptId`, `documentId`, `workbenchSessionId`, `mode` (`poster` or `h5`), `layerId`, `layerRevision`, `dispatchId`, `authorizationId`, `snapshotId`, and `sourceFingerprint`. Check the snapshot's source bounds and `selectedCropPath` dimensions. Never infer a different category or include another layer.

`selectedCropPath` is the only source image input for extraction/RMBG. `referencePath` is the only allowed initial ImageGen input. An explicitly authorized bounded second call uses that same reference plus its reserved initial raw as specified below. The full source is not an image-model input. Placement is the frozen `snapshot.bounds.x/y`; never recenter or resize the final region PNG.

New manifests bind `processingPolicy`: the processor digest, the item-contract digest and its canonical `itemContractPath`. Read that bound contract, not an older installed copy. Finalization rejects `PROCESSING_POLICY_CHANGED` if the prepared code/contract changed during generation. Preserve evidence and end that attempt; do not silently migrate or retry it.

## Combined editing requirements

Read `processingRequirements` and every entry in `regionInstructions` from the prepared manifest. They combine the layer-wide requirements with the separately saved requirements for each closed path. Apply every local instruction only to its corresponding path: `anchors` are crop-relative pixels; `referenceAnchors` use the prepared reference image's coordinates. The `target` and `pathId` identify the exact frozen path, and excluded repair regions remain protected. Specific local requirements refine the overall requirements inside that region. Do not discard these instructions or treat one region's text as a replacement for the others. A repair region with written requirements uses the reconstruct route, even if an older document still says extract.

## Route table

| Route | Input and provider | Model budget | Region RGB / alpha |
|---|---|---:|---|
| `extract_mask` + `selection` | no model; use the frozen crop as raw input | 0 ImageGen | Crop RGB unchanged; path selection writes alpha |
| `extract_mask` + `bria` | send only `selectedCropPath` to BRIA; use returned RGBA as raw and matte | 0 ImageGen | Crop RGB unchanged; BRIA alpha only |
| `extract_mask` + `imagegen_matte` | use `referencePath` once to produce pure black background and white foreground matte; preserve the exact raw matte PNG | 1 ImageGen | Original opaque interiors and placement retained; source-guided alpha and soft-edge foreground-color recovery |
| `reconstruct` + `generated_region` | use `referencePath` once to create only the selected region content | 1 ImageGen | Generated RGB can change only inside `repairPaths` (or whole region when none exist); mapping crops padding |
| `reconstruct` + `bria` | first reconstruct as above, then BRIA only on the mapped selected region | 1 ImageGen | Generated RGB only in repair bounds; BRIA alpha |
| `reconstruct` + `native_rgba` | initial `referencePath` with native transparency; read `nativeRgbaRequirements` | 1; at most 2 only for frozen `scoped_once_v1` | Source-preserving compositor; bounded second edit only in diagnosed regions, never a second matte |

## Bounded second-call repair

Applies only to `native_rgba`, frozen `strategy.localRepairPolicy=scoped_once_v1`,
`fidelityPolicy=source_faithful_repair` and `maximumImagegenCalls=2` together.
Budget 2 is a ceiling, not a requirement to call twice. First results that pass
complete source inspection finalize normally. Never alter an old manifest.

If the first rendered result has precise source-confirmed defects:

1. Preserve the first raw and inspection. Write `rejected.json` with envelope keys
   `attemptId,batchId,documentId,layerId,layerRevision,dispatchId,authorizationId,snapshotId,sourceFingerprint`,
   `rawSha256`, `visualReview.status="rejected"` and `defects`.
   Each defect is `{kind,x,y,width,height,evidence}` in selected-region pixels;
   kinds: `false_hole`, `filled_gap`, `missing_edge`, `broken_line`, `edge_contamination`.
   Evidence must explain what the SOURCE actually shows. Include enough neighboring
   edge for a clean join. Max 16 rectangles, summed area at most 25% of the region.
   Ambiguous areas are not facts; whole-subject distortion is not a local defect.
   Before reserving, run `node scripts/plan-v2-local-repair.mjs <manifest> <initial-raw> <rejected.json>`.
   This read-only command checks the current policy, active identity and raw hash,
   renders the first output, and lists connected unsupported runs omitted from
   the proposed repair scope. It consumes no call and changes no report.
   Inspect suggested regions against the frozen source yourself; do not ask the
   user to confirm them. Unsupported contrast is not proof of a semantic defect.
   Add only source-confirmed defects with concrete evidence, retaining complete
   damaged segments and clean joins; rerun planning against the updated report.
   Do not automatically copy suggestions into a reservation or expand explicit
   path permissions. An uncovered blocking run means the proposed repair scope
   cannot address that delivery failure. Resolve its source interpretation and
   scope before spending the second call; preserve the original area/count budget.
2. Run `node scripts/prepare-v2-local-repair.mjs <manifest> <initial-raw> <rejected.json>`.
   It checks the live running attempt, current policy and parent hash, then exclusively
   writes `local-repair-request.json`. Use its returned `requestSha256` verbatim;
   it is a canonical record digest, not the file-bytes hash. Failure means no call. Do not delete a reservation.
3. Use built-in ImageGen once: Image 1 is the prepared source reference (authority),
   Image 2 is the reserved initial raw (edit target). Translate defect rectangles to
   reference coordinates with `mapping.json` for the prompt. Change only listed defects
   according to source; retain all other composition/text/material and real transparency.
   Save exact output as a distinct `repair-raw.png`. No third call, including on timeout
   or unknown result. Cancellation stops immediately. Generation failure is finalized
   with its actual error, never by inventing an image or asking the user to approve pixels.
4. Write review data containing initial `rawSha256` and
   `scopedRepair:{requestSha256,rawPath,rawSha256}` (the nested hash is repair raw).
   Run `node scripts/preview-v2-local-repair.mjs <manifest> <initial-raw> <review.json>`.
   Inspect `repair-preview/preview-dark.png`, `preview-light.png` and the complete source.
   Both proposals are source-aligned/source-composited. For an initial
   per-component alignment, the repair fitter excludes components whose
   complete bounded-transform reach cannot intersect the authorized patch.
   A broad-phase possible-reach overlap alone is insufficient: a component
   with zero anchored contour probes and zero anchored material coverage
   inside the patch plus joining context is also excluded, never moved into
   the patch merely to establish evidence.
   Excluded second-image content never contributes pixels or fitting evidence;
   relevant components retain geometry, correspondence and sampling checks.
   Only the diagnosed
   rectangles intersected with frozen paths enter the final image; exterior RGBA stays
   byte-identical. Never inspect only the repair raw or bypass this merge.
   Within those rectangles, source-supported edit groups select complete RGBA
   pixels from either proposal. Alpha additions, removals and color-only edits
   are grouped separately so a color adjustment cannot join unrelated edges.
   A contour edit must improve source evidence without worsening either the
   unsupported-pixel count or longest unsupported run. It cannot erase an
   entire original visible component. This selection neither blends mattes nor
   authorizes a larger repair area; the complete merged contour, holes and
   six visual checks remain mandatory.
5. Set the six `nativeRgbaChecks`, actual `visualReview`, technical `checks`, and
   `finalPreview.rgbaSha256` from the command's JSON output (also stored in
   `repair-preview/inspection.json`). It hashes the transparent merged
   `repair-preview/preview.png` decoded RGBA, NOT either composited background image.
   Finalize with the INITIAL raw
   and this report through the normal finalizer. It rechecks hashes, active state,
   merged pixels, placement and alignment, and archives both raw outputs and request.
   A remaining defect is not a passing result. Preserve earlier delivered versions.

For an absent `scoped_once_v1` flag or any other route, the one-call rules below
remain in force. This scoped phase is not permission for automatic task retries.

## Source-faithful native RGBA repair

For `nativeRgbaRequirements.version = 3`, explicit frozen repairPaths take
precedence and must not be expanded. With no explicit repair paths, automatic
RGB patches are limited to observed source/model color disagreement in a
2–8 source-pixel silhouette band. They fade into unchanged source interior.
This repairs local color contamination using the same aligned model proposal,
without another generation, alpha erosion or hole filling. It does not prove
the proposed silhouette correct. Inspect source-composited patches and the
entire silhouette before delivery; retain the existing six visual checks.
The pixel audit records unchanged foreground RGB counts (alpha >= 128) and
range-exterior pixel equality. Do not call a canvas-wide equality percentage
the original-subject preservation rate. Preview and export use the same pixels.

For `nativeRgbaRequirements.version = 2`, alpha and RGB repair permissions are
independent. The renderer retains frozen source RGB outside frozen
`snapshot.strategy.repairPaths`; empty repair paths allow no RGB replacement.
The model image is a proposal, not a replacement layer. Do not expand frozen
repair permissions or use whole-layer reconstruction to conceal a bad cutout.
Inspect the final source-composited preview for source background revealed by
local contour mismatch. `pixelAudit.localRepair.outsideRepairRgbIdentical` must
be true. This invariant proves pixel preservation, not correct segmentation.
Version 1 historical artifacts retain their original semantics; do not relabel
them as source-pixel-preserving results.

This route requires the frozen strategy `fidelityPolicy = source_faithful_repair`.
It does not migrate historical snapshots or replace strict-source extraction.
Edit the prepared source reference, preserving its text, identity, material,
composition and fixed canvas coordinates. Repair boundaries only from source
evidence. Request actual transparency when `removeBackground` is true.
Do not run BRIA, matte generation, source-matte refinement or erosion afterward.
The complete generated alpha, including fine lines and holes, is authoritative
for rendering, but it is not proof of source fidelity.
The renderer uses distributed source feature matches to estimate one bounded
similarity transform for the complete RGBA, composing it with the reference
mapping before sampling the unchanged raw. It never warps alpha separately.
Feature extraction ignores invisible RGB and may normalize illumination for
matching only; neither operation changes delivered pixels. Low-texture marks
may remain on the global path. If global fitting fails on a detailed composite,
the renderer may fit a bounded local coordinate map from reciprocal feature
matches with locally consistent displacement. Held-out source-coordinate errors
must remain within 3 pixels at the 95th percentile and 6 pixels maximum; broad
support, residual displacement, relative stretch and positive Jacobian checks
are mandatory. RGBA share the same inverse map and are sampled together once.
The source RGB is not warped; normal source compositing still applies. This
does not fill holes, invent edges or certify semantic correctness: inspect the
complete rendered result using the same six checks. The processor hash binds
this implementation; never relabel an old failed attempt as successful.
Low-texture marks
may use a bounded whole-image similarity proposal initialized by source
foreground/background contrast. Repeated-location ambiguity is rejected.
This fallback verifies the entire mapped contour at ORIGINAL source resolution
(not the enlarged model reference), retaining the existing 0.90 coverage and
12-pixel unsupported-run gates. It does not deform alpha separately or fill
holes. Insufficient evidence or unreliable alignment fails; the transform is not proof
that local shape, text or material survived. Inspect those independently.

When those global and reciprocal-feature routes fail, disconnected low-feature
blocks may use bounded per-component affine coordinate proposals. Source edges
and foreground/background color separation constrain placement; positive scale,
non-overlap, source bounds, component and counter preservation constrain the
shared RGBA sampler. Detached soft coverage retains the common global anchor.
This route must also pass the unchanged native-source 0.90/12 contour gates
before returning a single-call alignment. During an authorized scoped merge,
only this contour acceptance is deferred on intermediate images; dimensions,
source correspondence, transform geometry, clipping, collision and topology
checks still run. The entire merged result must then pass the same contour
gates, including the unchanged exterior. A deferred intermediate is labelled
`pending_scoped_merge`, never passed. No manifest flag can enable this mode
for a single-call render. This route never supplies a new matte, changes alpha
independently, or bypasses the six final source-inspection checks. The fitting
and sampling modules are both included in the frozen processor digest.
For bounded repairs of this component route, the actual defect rectangles and
frozen path permissions determine the required source area internally.
The second proposal retains the initial proposal's verified global anchor;
only bounded component-local adjustment is allowed. Only second-image
components that cannot reach this area under any permitted local adjustment
are excluded from fitting and sampling. Components selected only by that
conservative reach bound but with no actual anchored contour or material
coverage in the patch and its eight-pixel context are likewise excluded.
An intersecting component with insufficient evidence still fails.
The initial
image is still processed completely, its exterior RGBA is retained exactly,
and the complete merged contour must pass the original gates. A partial
intermediate is not a standalone candidate; manifest flags cannot request it.
Component-local fitting uses contour and color probes anchored inside the
requested patch plus eight reference pixels of joining context. Unmerged
parts of the same connected shape do not steer that local fit. Geometry,
whole-component sampling integrity and full merged-image validation remain
mandatory; this does not authorize stretching a seam or expanding a patch.
For the scoped intermediate only, a combined topology change caused solely
by summed soft coverage outside the exact permitted source patch does not
reject the repair. The validator substitutes the already-checked component
union in that protected exterior for this probe only; sampled RGBA is never
edited. Contacts inside the patch, solid overlap, per-component topology loss,
and ordinary unscoped results still fail. The exterior is discarded on merge
in favor of the initial RGBA, and the complete merged result remains subject
to source-contour and hole checks.
Source-supported edit selection must also preserve a continuous join at the
permission boundary. If clipping an edit creates a solid/transparent boundary
absent from both complete input silhouettes and unsupported by a color
transition across that exact edge in the frozen source, that edit group is
retained from the initial image even if its average contour score improves.
Source-confirmed corners are allowed; smooth illumination ramps and nearby
edges with a different orientation do not establish a matching transition.
Do not expand
a reserved rectangle to hide this seam. Before reserving the second call,
inspect whether each defect rectangle includes the complete damaged segment
and its source-matching joins, within the unchanged area and call budgets.
An existing enclosed counter cannot disappear unless its entire former area
is within a diagnosed `false_hole` rectangle; removing a contour is not proof
that it was correct merely because the remaining boundary matches.

For a single-call result, preview using `scripts/v2-region-pixels.py --manifest <manifest> --raw <raw.png>
--output <new-preview.png>`; decode its RGBA to compute `finalPreview.rgbaSha256`.
Inspect the entire preview against the source, not only selected probe points.
The bound report must contain `rawSha256`, `finalPreview.rgbaSha256`,
`visualReview.status = passed`, and true `nativeRgbaChecks` for
`contentFidelity`, `fullSilhouette`, `thinStructures`, `holesAndSolidMaterial`,
`placement`, and `protectedRegions`. These are executor inspection results,
not user checkboxes. Never mark unseen or defective content as passed.
The finalizer verifies both hashes and rejects any second matte. The existing
one-call budget applies without `scoped_once_v1`. Scoped results must use the
bounded procedure and its merged preview hash above. Failure recording remains
unchanged; neither route permits whole-task retries.

If a padded matte or reconstruction image has no valid inverse mapping, fail the original attempt; never guess scale, crop by eye, or fabricate coordinates. When remove-background is enabled but the resulting foreground alpha is completely opaque, the audit status is `needs_review`, not a successful clean cutout.

## Extraction precision

Read `matteInstructions` from the manifest. The reference is a fixed coordinate plane, not a layout to redesign. Keep the object's position, scale, corners, true background holes and attached details. White interiors must be flat, not textured or shaded. A material groove, grille, reflection, letter extrusion or a gap backed by a requested record is opaque foreground, even when dark. Inventory the requested assembly from the source before the one allowed model call, and make that distinction explicit in the prompt. Do not invent decorative tips or simplify the silhouette. Never crop the generated matte to its own visible bounds or recenter it.

New matte references use area coverage when reducing and linear interpolation when enlarging, filtering premultiplied RGBA. The canvas, padding, content rectangle and inverse mapping remain unchanged; only reference sampling changes. Do not reinterpret this metadata as a new output coordinate system. Existing nearest-sampled references remain readable and their frozen mappings must not be rewritten. Reconstruction references and other provider routes are unchanged.

## Source-semantic topology inspection

New `imagegen_matte` manifests require `semanticRequirements.version = 1`. The execution agent performs this source inspection; never ask the user to check boxes or certify pixels. Color contrast locates boundaries but cannot determine whether a dark area is material or a background hole. The category alone cannot make that decision either.

1. Inspect `selectedCropPath` before generation. Inventory **all** requested objects, including attachments in `processingRequirements`. Choose a content profile: `flat_graphic`, `material_composite` or `organic_subject`. Do not change the frozen category, provider or model budget. Include the inventory and opaque-material/true-hole distinctions in the single ImageGen prompt using only `referencePath`.
2. Keep the raw generated PNG unchanged. Run `python scripts/inspect-v2-matte.py --manifest <manifest> --raw <raw.png>` with the project's managed Python. This maps the matte into source-crop coordinates and prints `rawSha256` and every enclosed hole's ID, bounds and interior point. Coordinates are **selected-region pixels**, not padded-reference or whole-document coordinates.
3. Compare every listed hole with the original crop. For a true background counter, use `preserve`; for a hole entirely covering source-confirmed solid material belonging to a requested object, use `fill_material`. Supply a concrete source-based reason for each. Do not treat an uncertain or mixed material/background component as a solid hole. Add one source-inspected interior point for each requested object in `objects`. These are completeness probes, not proof that the entire object is correct. Record this in `review.json` with the inspection's exact raw hash:

```json
{
  "rawSha256": "<sha256 of the unchanged raw PNG>",
  "semanticTopology": {
    "version": 1,
    "coordinateSpace": "selected_region_pixels",
    "profile": "material_composite",
    "objects": [{ "name": "solid microphone body", "point": [120, 180] }],
    "holes": [
      { "id": 1, "treatment": "preserve", "reason": "Source background is visible through the ring." },
      { "id": 2, "treatment": "fill_material", "reason": "This is a dark groove on the opaque microphone body." }
    ]
  }
}
```

This fragment supplements, not replaces, the bound identity and mechanical `checks` described below. Classify **all actual IDs exactly once**; use an empty `holes` array when inspection finds none. Never copy example coordinates/IDs into a real report. A separate edited matte is not accepted as evidence for the unchanged raw hash.

For `material_composite`, also inspect `materialNotchProposals` returned by the same command. A dark grille or seam may have been cut open to exterior background and therefore will never appear in the enclosed-hole list. The inspector enumerates small exterior pockets with a fixed four-source-pixel closing; enumeration does not fill them. Only if the **entire** pocket is source-confirmed opaque material belonging to a requested object, add `materialNotches: [{"id": <actual ID>, "reason": "<source-specific evidence>"}]` inside `semanticTopology`. Omit true background gaps, ambiguous pockets and mixed material/background pockets. Inspect the complete bounds, not just the suggested point. This uses the unchanged raw and current source coordinate frame, not a hand-drawn replacement or another model call. The renderer rejects invalid/duplicate IDs and corrections across selection/native transparency, includes them in the existing correction budget, and preserves them through the final semantic check. A restored notch is not proof of correct exterior alignment; the same final source-contour gates still apply.

4. Run the same inspection command with `--report <review.json> --preview <new-preview.png> --stage final`. This runs the **same complete pixel renderer** as final delivery: topology correction, source-contour refinement, optional source-assembly segmentation, edge-color recovery, selection limits and native alpha. It returns `pixelAudit` and `rgbaSha256`; it does not finalize, create a candidate, change a document or spend a model call. Inspect this final RGBA against the crop, including every object, real counters, outer contours and placement. A distorted proposal alone is not a terminal failure before this source-backed processing. Only after both the pixel audit and source comparison pass record `visualReview: {"status":"passed","summary":"<specific source comparison>"}` and `finalPreview: {"rgbaSha256":"<returned hash>"}`. If the final preview remains incorrect, record `status: rejected` and `code: SEMANTIC_MATTE_MISMATCH`, describe the remaining defects and finalize that failure once. CLI success or mechanical checks alone cannot justify `passed`. The default `--stage topology` is only an intermediate diagnostic and cannot replace final-output inspection.
5. Pass the original raw and completed report to the finalizer once. It applies the declared corrections before source-contour refinement, then rechecks semantic probes **after** selection/native transparency limits. It rejects missing/duplicate hole decisions, altered raw bindings, erased objects/counters, and fills that cross user exclusions/native transparency, touch the outer contour or exceed the bounded correction budget. The original source RGB is retained at opaque pixels. Geometry still has to pass the unchanged 0.90/12 gates. The resulting semantic audit is also required by preview selection, composition and PSD export.

The enclosed-hole correction repairs only classified interior material. For `material_composite`, the complete renderer also proposes a source-driven assembly segmentation when the old bounded-shape route fails. Source colors matching observed exterior samples are probabilistic background, not locked foreground just because they lie inside an eroded model mask. The source proposal must retain component identity and true counters, respect source-inspected material/object probes and selection, and pass the unchanged independent 0.90/12 contour gates. Growth is bounded to a scale-dependent 16–48 source-pixel neighborhood; this is not permission to add a missing remote object or hand-draw a replacement. Unresolvable or mixed material/background holes still fail. Do not use extra model calls or relaxed gates to hide failures. Historical processing without source-semantic review does not acquire one merely by local revalidation; original evidence and eligible legacy results remain unchanged.

The generated matte is only a semantic proposal. Policy v7 inverse-maps it into frozen source coordinates: crop the exact content region before filtering, integrate pixel coverage when reducing size, and use bounded linear interpolation when enlarging. Do not point-sample a high-resolution matte; it destroys antialias coverage on small curves and thin strokes. When source color evidence supports it, the finalizer recovers low-contrast/soft edges and internal holes. Otherwise, source segmentation estimates bounded per-component displacement; a robust shape-preserving transform applies that displacement to the clean contour and its complete counters. It must not replace a straight edge with pixelwise color noise or shrink a counter to a single protected pixel. Source-edge verification still applies: a smooth mask can remain misaligned and fail automatic delivery checks. Opaque interior RGB, source transparency, region size and original placement are preserved. Soft-edge foreground-color recovery does not alter the validated alpha silhouette. Never replace RGB with generated matte pixels.

Read `sourceGeometryAlignment.status`, `contourIntegrity`, `reviewReasons`, and the final audit status. `POSSIBLE_MISSING_COMPONENTS` means similar source components were not selected: they are not silently added. `SOURCE_BOUNDARY_UNCERTAIN` means the source does not sufficiently support the proposed contour; it is not proof of an incorrect edge. `ALPHA_CONTOUR_CHANGED` means final alpha recovery changed the validated silhouette or filled its counters. These retain a diagnostic PNG with audit status `needs_review`. The workbench delivers automatically only when current source/selection binding, file checks and the geometry gate pass. Local refinement and validation are internal processing steps, not user approvals. `uncertainRegions` and `longestUnsupportedRun` remain internal diagnostics; the latter counts connected boundary pixels, not displacement. A `needs_review` diagnostic is not a deliverable and cannot be released by a human acknowledgement. Missing parts, damaged holes, weak overall evidence, old/unbound results and unreadable PNGs remain blocked. The split-execution agent finalizes and records the result; it does not ask the user to certify edges, mutate document selection, or export on its own. A finalized diagnostic attempt is not a clean split or a reason to generate again. User path exclusions constrain the missing-component check. `semanticCompleteness = requires_user_review` in historical audit records describes an unmeasured property, not a required user workflow. A boundary support score is not accuracy, proof of complete text, or proof that all holes are correct.

If the processor returns a structured error (for example no usable foreground/background, excessive correction, invalid mapping, or a region over the 4-million-pixel limit), end the attempt with that error. Do not replace a returned `needs_review` diagnostic with `GENERATION_FAILED`. Do not widen thresholds, omit the audit, resize the result, invoke finalization twice, or retry automatically. The workbench automatically selects a current, policy-v7 passing result for composition and PSD; already verified compatible v6 results remain usable. No adoption click is required. Optional version switching is limited to eligible results and cannot override quality checks. If automatic processing still cannot verify a result, report the item as not completed rather than requesting a quality waiver. Old PNG/PSD files remain historical evidence; do not rewrite them.

Policy v6 checks blurred source transitions without counting the transition itself as background noise, and independently measures chromatic steps when reflections dominate luminance. The added evidence cannot move alpha, fill holes or extrapolate an unsupported arc. Misregistered transitions, repeated texture and a smooth illumination ramp are not valid edge evidence. The original coverage (0.90) and longest-unsupported-run (12 boundary pixels) gates remain unchanged. After an upgrade, the workbench may revalidate immutable archived evidence locally and archive a new result with zero model calls; it must preserve the original attempt manifest, raw matte and document revision.

Policy v7 also verifies soft corners against a two-dimensional source patch, competing nearby displaced silhouettes against the aligned shape and a shared illumination plane. This check cannot edit alpha; displaced corners, repeated texture and illumination-only gradients are negative controls. If a local straight edge remains misregistered, the finalizer may fit a bounded source-observed displacement along the complete segment instead of tracing pixelwise segmentation noise. It keeps a repair only when topology and frozen trimap constraints hold and independent source evidence improves. It then rechecks the final alpha, counters, opaque RGB and unchanged coverage/run gates. `localContourRepair` records whether pixels actually changed; a repair attempt alone never establishes delivery.

For independently displaced edges, policy v7 may also solve smooth normal offsets within the original correction band. Reflective rims are checked against a locally fitted exterior color profile; a dark/light/dark metal surface is not a transparency hole. A cast-shadow step alone cannot supply this additional material evidence. Source-observed color segmentation is a bounded prior, not authority to cut off a darker opaque rim. The repaired silhouette must still preserve components, counters and the frozen trimap, improve source evidence, and pass the unchanged 0.90/12 gates. The final PNG is verified after antialias rasterization. Processor digests distinguish fixes within the same public policy version: an archived diagnostic from an older digest may be locally reprocessed once with zero model calls; refresh must not retry a diagnostic made by the current processor. Already delivered results and original attempts stay unchanged.

## Review report and finalization

For locally displaced composite outlines, the current processor pairs the two
sides of narrow strokes before fitting a shared source-coordinate deformation.
Coarse registration and fine refinement use fixed alpha frames to estimate the
coordinate map; the delivered alpha samples the original matte exactly once.
Iterations do not repeatedly resample the previous output, and source RGB is
never warped. Transport integrity compares final alpha to that same map, not
to the untransformed mask's thresholded component count: subpixel sampling can
change that count without adding or deleting a semantic object. Pixel edits
after the map fail this check, except source-confirmed fixed opaque material;
source object/counter checks remain separate and mandatory.
Local damping prevents one sharp corner from freezing unrelated corrections.
Both stage geometry and the complete composed map retain the original strain,
Jacobian, displacement and source-clipping limits. Source-confirmed solid
material remains fixed in source coordinates, while generated counter IDs
follow the same composed map as alpha. The complete final alpha is checked
again against source evidence and semantic topology after those constraints
are applied. This is an automatic internal fallback, not another model call,
a manual waiver, or permission to change the original image or selection.

For a source-inspected material assembly, near-white model noise (247–254)
more than three source pixels inside a near-white region is normalized to
opaque before local deformation. Edge/counter coverage, gray regions, organic
subjects, native source transparency and user exclusions are not normalized.
This removes unintended translucency in solid interiors without thresholding
thin strokes or antialiased boundaries; the semantic audit records the count.

Keep `raw.png`, `review.json`, and any separate `matte.png` in the attempt directory. The JSON review report must include the exact values for `attemptId`, `dispatchId`, `authorizationId`, `snapshotId`, and `sourceFingerprint`, plus `checks` containing boolean mechanical checks (PNG readable, selected dimensions, mapping/placement, authorization binding). Do not claim semantic quality from those checks. Call the region finalizer once; it writes only region-size RGBA and archives the report/raw evidence under the original attempt.

An explicit rejected, needs-review or unknown `visualReview.status` blocks delivery even when every file check passes. The historical `proposal_requires_source_alignment` status deferred geometry to the finalizer rather than rejecting semantics: a legacy result with that status still requires its independently passing source-contour audit. It is not valid semantic approval for a new manifest. New semantic-required manifests need the raw-bound `semanticTopology` and `visualReview.status = passed`; missing evidence is not a pass. Never omit a rejection to reach finalization or PSD. The failure branch records `SEMANTIC_MATTE_MISMATCH` for a known unrepaired semantic defect; it preserves the raw/report without creating a deliverable.

If no usable PNG or report exists, finalize the failure for that exact manifest. Report its structured error; do not re-dispatch or retry.
