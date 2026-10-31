# V2 Task 5 — Figma and browser evidence

Date: 2026-09-27 (Asia/Shanghai)

## Figma source

- File: `ItDSmrMwF9us8K53dQHXwg` (`Untitled`)
- Empty/upload reference: node `35:2`; visible child context and screenshot reviewed at 2026-09-27 14:02 UTC.
- Unified canvas and layer list: node `84:2`; visible child context and screenshot reviewed at 2026-09-27 14:02 UTC.
- Empty state shows the IMVIA Layer header, green connection indicator, and two side-by-side upload cards on a dark dotted canvas.
- The overview reference uses a fixed top bar, a large left source canvas, a right layer panel, and persistent bottom actions. The V2 page follows that hierarchy. The `画布总览` control intentionally returns to the existing V1 overview entry, as specified by the implementation plan.

## Browser checks

- Local Vite page `/?workbench=v2` opened in Chrome with no uploaded user image and no generation request.
- Empty-state controls were visually checked at responsive sizes 1536×1024, 900×700, and 420×800. At the narrow size, the two upload choices stack and fit within the viewport.
- `node --test src/v2/workbench.test.mjs`: component SSR, stable selection/list IDs, custom route validation, reordering, fit math for landscape/portrait/tiny sources, persistence, and HTTP conflict checks.
- Not exercised in this task: real file-picker upload, dragging a selection in a browser session, transparent/landscape/portrait browser image rendering, and layer-list pointer selection with overlapping regions. Their normalization, geometry, shared IDs, and persistence contracts have targeted code/tests; the full interactive acceptance remains for a later task/browser fixture pass.

## Current stage boundary

The `拆分` and `下载 PSD` actions are visible but disabled until their downstream processing/export tasks are implemented. The edit icon currently selects the layer and reports that focused editing is the next stage; it does not dispatch generation or create a separate project.
