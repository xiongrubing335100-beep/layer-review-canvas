# Layer Rules v3.1

Read this file after inspecting the poster and before planning, prompting, or releasing a candidate.

## Required plan fields

Record `layer_name`, `asset_role`, `layer_type`, `z_order`, `position`, `visible_content`, `included_content`, `excluded_content`, `occludes`, `occluded_by`, `source_evidence`, `support_components`, `ui_independence`, `repair_envelope`, `locked_visible_anchors`, `completion_required`, `completion_regions`, `risk_level`, `processing_mode`, `fill_color`, `compositing_mode`, and `separation_reason` for every layer.

- A visible pixel has one owner. A generated completion pixel belongs to the asset it restores.
- `source_evidence` must identify an observed form and position. “Typical title shadow” is not evidence.
- `support_components` may contain only source-evidenced outline, stroke, glow, cast shadow, extrusion, brush tail, underlay, border, or antialiased edge. If uncertain, exclude it; never create a generic black backing plate.
- `ui_independence` is `independent` for separately movable badges, CTA cards, ribbons, dates, prices, labels, logos, and icon groups. Set `attached` only when the source physically fuses the UI with its owner.
- `repair_envelope` contains the occluded target segment and a minimal seam band. It may repair a whole interrupted forearm, clothing panel, or background section, but cannot include exposed identity-critical features without explicit user instruction.
- `locked_visible_anchors` are observed source pixels outside the repair envelope. They are invariants, not inspiration.

## Completion modes

| Mode | Use for | Rule |
| --- | --- | --- |
| `full_asset_completion` | people, products, props, solid decorations | Complete hidden continuous structure while preserving locked face, hair, anatomy, clothing, hand, weapon and material anchors. |
| `graphic_completion` | headlines, text, logos, UI, icons | Preserve exact wording/layout. Include only documented support components. |
| `effect_completion` | ribbons, beams, glows, particles, smoke, source-evidenced shadows | Reconnect only the observed effect trajectory/range; do not add effect mass. |
| `background_completion` | scenery behind planned foreground | Continue covered scenery while preserving visible geometry, perspective, motifs, grade and anchors. |

## Source-preservation rules

- Keep every independently movable UI asset separate from headline graphics by default.
- Do not use `brush tail`, `underlay`, `black shadow`, `dark backing`, `glow`, or `extrusion` as generic prompt vocabulary. Include it only when declared in `source_evidence` with a source-supported description.
- Do not authorize “complete the torso,” “rebuild the character,” or other whole-asset rewrites. Describe the blocked connected segment and seam band.
- Completion remains required even when a part is hidden; if ImageGen changes locked anchors while attempting it, reject the candidate rather than delivering a visibly wrong layer.
- Keep attached equipment with its owner only if it is visually inseparable and need not move independently.

## Automatic rejection

Reject a candidate if any condition applies. Never auto-retry.

- `UNSUPPORTED_GRAPHIC_EFFECT`: an absent black plate, brush, underlay, shadow, glow, extrusion, or decoration was invented.
- `UI_BUNDLING_ERROR`: a separately movable badge/CTA/date/logo/icon was merged into another layer.
- `VISIBLE_ANCHOR_MUTATION`: a locked source-visible feature changed in geometry, identity, colour, material, position, or crop.
- `WHOLE_ASSET_REGENERATION`: completion visibly redraws a broader character/product/background region than the repair envelope.
- `REPAIR_ENVELOPE_EXCEEDED`: generated repair extends beyond the declared envelope/seam band.
- `COMPLETION_MISSING`: a declared covered region remains blank, keyed out, or contains the removed occluder.
- `ANATOMY_OR_STRUCTURE_BROKEN`: person, hand, limb, prop, architecture, or product geometry is implausible.
- `TEXT_OR_LOGO_MUTATED`: wording, glyph form, logo construction, hierarchy, or placement changes.
- `BACKGROUND_LAYOUT_DRIFT`: visible perspective, roofline, motif, structure, or colour relationship drifts.
- `OCCLUDER_OWNERSHIP_ERROR`, `EFFECT_CONTINUITY_BROKEN`, `FOREIGN_CONTENT_LEAK`, `REGISTRATION_UNCERTAIN`, `KEY_UNUSABLE`, or `CANVAS_OR_GREEN_FIELD_INVALID`.

Set `NEEDS_USER_REVIEW` only if no listed failure exists and an artistic preference remains.

## Recomposition audit

1. Place graphic and UI owners independently according to `ui_independence`.
2. Confirm every support component appears in the source evidence and is above the layer it covers.
3. Confirm every repair envelope is internally continuous without mutating locked anchors.
4. Confirm background repair reconnects through removed assets while visible geometry remains stable.
5. Confirm the stack reconstructs the source without duplicate objects, leaked UI, or invented effects.
