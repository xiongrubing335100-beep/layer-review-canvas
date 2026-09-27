# V2 item contract

## Immutable identity

Before touching pixels, compare the returned processing manifest with the frozen batch record: `batchId`, `attemptId`, `documentId`, `workbenchSessionId`, `mode` (`poster` or `h5`), `layerId`, `layerRevision`, `dispatchId`, `authorizationId`, `snapshotId`, and `sourceFingerprint`. Check the snapshot's source bounds and `selectedCropPath` dimensions. Never infer a different category or include another layer.

`selectedCropPath` is the only source image input for extraction/RMBG. `referencePath` is the only allowed ImageGen input. The full source is not an image-model input. Placement is the frozen `snapshot.bounds.x/y`; never recenter or resize the final region PNG.

## Route table

| Route | Input and provider | Model budget | Region RGB / alpha |
|---|---|---:|---|
| `extract_mask` + `selection` | no model; use the frozen crop as raw input | 0 ImageGen | Crop RGB unchanged; path selection writes alpha |
| `extract_mask` + `bria` | send only `selectedCropPath` to BRIA; use returned RGBA as raw and matte | 0 ImageGen | Crop RGB unchanged; BRIA alpha only |
| `extract_mask` + `imagegen_matte` | use `referencePath` once to produce pure black background and white foreground matte; preserve the exact raw matte PNG | 1 ImageGen | Crop RGB unchanged; inverse-mapped matte writes alpha |
| `reconstruct` + `generated_region` | use `referencePath` once to create only the selected region content | 1 ImageGen | Generated RGB can change only inside `repairPaths` (or whole region when none exist); mapping crops padding |
| `reconstruct` + `bria` | first reconstruct as above, then BRIA only on the mapped selected region | 1 ImageGen | Generated RGB only in repair bounds; BRIA alpha |

If a padded matte or reconstruction image has no valid inverse mapping, fail the original attempt; never guess scale, crop by eye, or fabricate coordinates. When remove-background is enabled but the resulting foreground alpha is completely opaque, the audit status is `needs_review`, not a successful clean cutout.

## Review report and finalization

Keep `raw.png`, `review.json`, and any separate `matte.png` in the attempt directory. The JSON review report must include the exact values for `attemptId`, `dispatchId`, `authorizationId`, `snapshotId`, and `sourceFingerprint`, plus `checks` containing boolean mechanical checks (PNG readable, selected dimensions, mapping/placement, authorization binding). Do not claim semantic quality from those checks. Call the region finalizer once; it preserves source RGB on extraction, writes only region-size RGBA, and archives the report/raw evidence under the original attempt.

If no usable PNG or report exists, finalize the failure for that exact manifest. Report its structured error; do not re-dispatch or retry.
