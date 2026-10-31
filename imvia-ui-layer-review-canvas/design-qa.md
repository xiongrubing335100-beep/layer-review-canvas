# Imvia Layer 海报快速工作台 Design QA

## Target

- Reference: `/var/folders/pl/yt_50trd34jbd3tdn4bsd4t80000gn/T/codex-clipboard-c5d25164-7412-4a9b-bf73-d9b2008b6930.png`
- Current runtime capture: `/private/tmp/imvia-poster-fast-after.png`
- Runtime: installed Imvia Layer workbench at `http://127.0.0.1:4173/`, Codex in-app browser.
- State: the same 1848 × 4000 poster used by the failed candidate job, fast mode, first concrete project selected.

## Visual comparison

- Reference and runtime capture were opened in one comparison input before judging the result.
- Poster fast mode now uses the H5 guided hierarchy: source/project rail, selected-project header, original-position preview, current crop, Codex result area, and right inspector.
- The right inspector matches the H5 control order: category/status, editable name, per-project delete, requirement, quick requirements, mode, remove background, boundary tools, previous/confirm/split.
- The original source card is above the category list and exposes the real thumbnail, dimensions, and delete action.
- Surfaces, grid, typography, borders, spacing, and mint semantic accents reuse the existing H5 design system.
- Source and crop images use contained sizing; no preview image overflows its panel.

## Functional checks

- Local fast analysis produced six editable concrete projects without sending a Codex task.
- Previous/next navigation moved between item 1 and item 2 and returned to item 1.
- Name editing updated the workbench state and was restored after the check.
- Remove-background state and pen-tool selection changed correctly and were restored.
- Source/project delete controls are enabled where applicable; deletion was not invoked during QA.
- Split was not clicked, so no generation, hidden task, or external message was created.
- Browser console contained no errors or warnings.

## Candidate pipeline checks

- A failed green-screen candidate now passes BRIA-first processing through the restricted chroma fallback when BRIA returns an opaque alpha.
- The fallback removes green spill on partially transparent edges, emits real alpha, and maps the result back to the complete 1848 × 4000 canvas.
- Failed candidates with a retained raw PNG remain visible next to their failure report instead of rendering an empty PNG area.
- New targeted prompts require at least a 6% internal safe margin so enlarged text, quotation marks, strokes, shadows, and decorations cannot touch or cross the output edge.

## Result

passed
