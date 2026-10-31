# Prompt Templates v3.1

Use the base block plus exactly one type block. Generate one candidate only unless the user explicitly authorizes a retry.

## Base block

```text
Use the supplied poster as the only visual authority. Generate one full-canvas candidate in the source [SOURCE_WIDTH] × [SOURCE_HEIGHT] coordinate system and [SOURCE_ASPECT_RATIO] aspect ratio.

Layer: [NAME]. Asset role: [ASSET_ROLE]. Position: [POSITION]. Remove only: [OCCLUDER_BUNDLE]. Keep these source-visible anchors unchanged: [LOCKED_VISIBLE_ANCHORS]. Complete only this repair envelope: [REPAIR_ENVELOPE], using these source anchors: [PRESERVE_ANCHORS]. Exclude [EXCLUDED_CONTENT].

Do not move, recrop, rescale, redesign, recolour, beautify, blur, or restyle any locked source-visible content. This is the only requested layer.
```

## Character, product, prop, decoration

```text
Mode: full_asset_completion. Composite: Normal. Use uniform #00FF00 outside the completed asset.

Retain [TARGET] at [POSITION], including [ATTACHED_COMPONENTS]. Remove [OCCLUDER_BUNDLE]. Repair the continuous hidden target segment inside [REPAIR_ENVELOPE] and its stated seam band, matching source anatomy, silhouette, clothing/material, lighting and design from nearby anchors. This is not permission to regenerate the whole character/product.

Face, hair, visible hands, visible weapons, exposed clothing seams, and every named locked anchor must remain exactly faithful to the source. Do not add limbs, fingers, accessories, background, or unrelated subjects. Reject the candidate if any locked anchor changes.
```

## Headline, logo, UI, icon, graphic device

```text
Mode: graphic_completion. Composite: Normal. Use uniform #00FF00 outside the graphic.

Retain [EXACT_TARGET] at [POSITION]. Source wording/identifiers: [VERBATIM_CONTENT]. Include only the support components explicitly evidenced here: [SOURCE_EVIDENCE]. Do not generate any black backing plate, brush tail, underlay, glow, extrusion, shadow, border, or texture that is not described by that evidence.

Treat [UI_INDEPENDENCE] UI separately from headline graphics. Preserve wording, glyph construction, baseline, spacing, colour, and placement. Do not translate, substitute, or invent marks.
```

## Ribbon, beam, glow, particle, smoke, shadow, effect

```text
Mode: effect_completion. Composite: [NORMAL/SCREEN/ADD/MULTIPLY]. Use [#00FF00 OR #000000] outside the effect.

Retain only the source-evidenced [TARGET]. Remove [OCCLUDER_BUNDLE] and reconnect it inside [REPAIR_ENVELOPE]. Preserve observed trajectory, width, direction, brightness, softness, density, and endpoints. Do not add a generic brush or dark backing effect.
```

## Background

```text
Mode: background_completion. Output the full original canvas.

Remove only [FOREGROUND_LAYER_LIST]. Retain [BACKGROUND_DESCRIPTION]. Complete the declared background repair envelopes using nearby source geometry and anchors: [PRESERVE_ANCHORS]. Keep visible perspective, horizon, building/panel lines, patterns, motifs, light direction, grade and depth unchanged.

Do not recreate a merely similar scene, relocate visible geometry, or add text, logos, people, objects, or effects absent from the source background.
```
