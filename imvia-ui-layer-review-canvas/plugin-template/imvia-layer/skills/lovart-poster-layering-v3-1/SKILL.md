---
name: lovart-poster-layering-v3-1
description: Decompose a poster or marketing reference into complete, independently editable full-canvas layers with ImageGen. Use for poster splitting, subject isolation, occlusion repair, source-evidenced graphic/UI separation, green-screen layer preparation, and recompositing without auto-retrying candidates.
---

# Lovart Poster Layering v3.1

Turn a flattened poster into reviewable, complete editable layers. Use ImageGen to complete intended hidden regions, but never let it invent graphic effects or rewrite source-visible identity.

## Version rule

Treat this version as immutable for acceptance testing. Make every later revision as a new sibling skill with an incremented suffix; never overwrite `lovart-poster-layering-v3-1`.

## Execution contract

```text
inspect → evidence map → independent-layer plan → one candidate per layer → source comparison → accept/reject → normalize accepted files → deliver
```

- Create an evidence map before generating. Every layer must declare `asset_role`, `occludes`, `occluded_by`, `source_evidence`, `support_components`, `ui_independence`, `repair_envelope`, `locked_visible_anchors`, `completion_required`, `completion_regions`, and `risk_level`.
- A graphic support component belongs to a title/logo only when it is visibly evidenced in the source. Never infer a black brush plate, underlay, enlarged shadow, glow, extrusion, or decoration because such a component is common in a poster.
- Split independently movable UI by default. A date badge, CTA, price card, footer ribbon, logo, corner mark, or icon cluster must be a separate layer from a headline unless source pixels physically form one inseparable graphic.
- Keep a source-evidenced title outline, shadow, depth, or glow with its owner. Do not leave it baked into the character/background below; do not create an unobserved version of it.
- Default to a complete editable asset. Complete every planned layer behind its declared occluders, including characters, props, UI, effects, and background. A repair envelope may cover a continuous hidden body/prop segment and a small seam band; it must not authorize re-rendering the whole asset.
- Lock all source-visible anchors outside the repair envelope: face, hair, hands, weapons, exposed anatomy, costume seams, typography, logos, rooflines, horizons, and other stable features. ImageGen may not change them.
- Keep every layer on the full source canvas, at original coordinates. Use uniform `#00FF00` outside normal opaque layers. Do not crop, trim, centre, reposition, or mix transparency with green screen.
- Generate exactly one ImageGen candidate for each planned layer. Never auto-retry. A retry requires the user's explicit instruction, for example `重试第 03 层`.
- Save candidates under `candidates/`. Move a file to `layers/` only after it passes the release gate and the user explicitly accepts it.

## Required package

Create `outputs/poster_layers/<source-stem>/` unless the user specifies a destination.

```text
source.png
layer_manifest.json
candidates/
layers/
```

Copy [assets/layer-manifest.json](assets/layer-manifest.json) as `layer_manifest.json` and record every state change.

## 1. Inspect and plan

1. Inspect the reference and record true source dimensions, aspect ratio, 2× target, and source path.
2. Read [layer rules](references/layer-rules.md), then create a front-to-back ownership graph.
3. For every graphic support component, record source evidence: shape, colour, edge behaviour, location, and owner. If evidence is absent or ambiguous, do not generate the component.
4. Separate headline, date/CTA UI, brand identity, icons, and graphic effects according to independent movement—not convenience.
5. For every completion, declare a repair envelope: the occluded target segment plus only the seam band needed to reconnect it. Name locked visible anchors around it and rate the completion risk.
6. Number layers from foreground (`layer_index: 1`) to background. Composite from the largest index down to 1.

## 2. Generate one candidate

Read [prompt templates](references/prompt-templates.md). For every `PENDING` layer:

1. Call built-in `image_gen` once with the source as the only visual authority and request a full source canvas.
2. Remove only declared foreground layers. Preserve all locked source-visible anchors and complete only the declared repair envelope.
3. Save the raw candidate in `candidates/layer_<index>_<slug>_candidate-01.png`.
4. Record `CANDIDATE_CREATED`, generation count, prompt, path, evidence, envelope, anchors, and dimensions in the manifest.
5. Inspect the actual candidate against the original. Prompt text and image dimensions are not visual review.

## 3. Release gate

Read the failure codes in [layer rules](references/layer-rules.md). Reject immediately when a candidate invents an unsupported graphic effect, merges independent UI, mutates a locked anchor, re-renders a whole character, breaks anatomy, changes text, drifts background geometry, or contaminates the key field.

Use `NEEDS_USER_REVIEW` only when no hard failure exists and the remaining decision is subjective art direction. Record failure codes; do not auto-retry. Ask for `接受第 NN 层` or `重试第 NN 层`.

Before acceptance, verify recomposition: independent UI remains independently movable; every visible graphic support component has source evidence; completed assets are continuous; locked anchors match; and the front-to-back stack reconstructs the source without duplicate content.

## 4. Finalize accepted layers

After acceptance, use only non-generative uniform scaling and fixed-canvas padding to produce `layers/layer_<index>_<slug>_source.png` at source dimensions. Preserve aspect ratio; never crop useful content, stretch, rotate, content-aware fill, or call ImageGen merely to correct dimensions.

Use `#00FF00` for normal opaque layers and `#000000` for Screen/Add light effects. Do not simulate Lovart HD with ImageGen. If no Lovart HD control is available, record `HD_UNAVAILABLE`.
