# Matte contour regression

Frozen selected-region evidence from local attempt `52a54f79c8fa4a6a526fefef334f440c` (2026-10-13).
These copies are test inputs, not candidate outputs. No model call is required to replay them.

- `car-text-source.png`: original 990 × 500 RGBA crop at source coordinate (1639, 1213).
- `car-text-matte.png`: original 1536 × 1024 semantic matte; content region (62, 155, 1412, 713).
- The corresponding old candidate filled the A counter and made P's straight edge jagged during local refinement and alpha re-estimation.

`scripts/test_matte_contour_regression.py` checks inspected hole-interior points, straight-edge deviation, opaque source RGB and final-alpha integrity. It does not treat smoothness or boundary support as semantic ground-truth accuracy.

The 2026-10-14 retry `c0ae9eb299e74c1855d7ac5fedb6216e` reproduced the soft-edge false rejection at the same source location with a different generated matte:

- `reflective-text-source.png`: original 902 × 448 crop at (1668, 1224).
- `reflective-text-matte.png`: untouched 1536 × 1024 model matte, content region (62, 161, 1412, 701).
- Policy v5 rejected a 22-pixel P edge and a 14-pixel E edge; policy v6 uses source transition fitting and independent chromatic evidence. Tests retain the original 0.90 coverage / 12-pixel unsupported-run limits. `reflective-text-policy-v5-alpha.png` freezes the prior verified policy-v5 candidate `7a013045` alpha: its decoded L-mode raw-pixel SHA-256 remains `9aa2c54bec4cab4252671d20b61fe8b8d7fe70f081856573abee72ab801b8382`. This fixture was frozen from a replay whose alpha matched that existing historical digest exactly. The verifier audits this immutable mask and must leave every alpha byte unchanged; refinement is checked separately for delivery evidence, four counters, final contour integrity, dimensions, and unchanged opaque source RGB. A fresh numerical refinement is not required to reproduce a platform-specific full-image hash.
- Policy v7 handles the original `car-text` failure with a two-dimensional source check at soft corners and bounded, source-observed straight-segment registration. The final alpha is checked again under unchanged coverage/run limits, with counters, straightness and opaque source RGB protected. A backend integration test migrates the immutable failed archive once, resolves it automatically and exports a PSD without approval or generation. Previously verified v6 outputs stay usable.
- Negative controls cover displaced corners, repeated texture, illumination-only gradients and distant unrelated shapes. These cannot be promoted merely because a repair was attempted.

Run with the project's configured Python runtime:

```sh
python -B scripts/test_matte_contour_regression.py
python -B scripts/test_source_guided_matte.py
python -B scripts/test_v2_region_pixels.py
```

## Independent gold UI proposal

`gold-ui-source.png` is the 874 × 322 H5 card crop at (81, 2139).
`gold-ui-matte.png` is the earlier real model proposal. `gold-ui-regenerated-matte.png`
is the unchanged second real model output from independent acceptance attempt
`6061fe9bb1eb59b5fa271b323afdfa94`, SHA-256
`3e1d5e4b03718b99573c9118ba901ad2382899efeeb42333c36ea61bf074a866`.
Both use the 1536 × 1024 reference with content bounds (62, 252, 1412, 520).
The latter exposed over-reliance on the model's edge position: source gold lip
pixels (320, 33), (350, 33), (375, 33) were cut inward to the brighter inlay.
`test_product_matte_regression.py` requires those source-inspected material
points, exterior transparency, unchanged opaque RGB and the unchanged 0.90/12
delivery gates for both proposals. These fixtures do not establish general
complex-assembly segmentation quality.
