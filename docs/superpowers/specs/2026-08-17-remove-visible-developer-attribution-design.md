# Remove Visible Developer Attribution Design

## Goal

Remove the visible `开发者 · 青木` strip from the bottom of the workbench's left sidebar because it distracts from the layer workflow.

## Scope

- Remove the `DeveloperAttribution` import and the single sidebar render site from the workbench UI.
- Remove CSS variables and selectors that exist only for the visible attribution strip.
- Keep the author constants and non-visual attribution module available as source-level ownership information.
- Keep README, LICENSE, NOTICE, plugin metadata, legal source headers, build banners, and the Xiaohongshu author link unchanged.
- Do not add a replacement watermark, hidden UI element, image watermark, export watermark, telemetry, or license enforcement.

## Verification

- Replace the UI contract that requires the sidebar attribution with a contract that rejects any `DeveloperAttribution` import or render in `main.jsx`.
- Keep the release contracts that verify documentation, licensing, metadata, legal headers, and absence of PNG/export watermark injection.
- Run the focused branding and toolbar tests, the complete Node test suite, the complete managed Python suite, and the production build.

## Success Criteria

The workbench no longer displays `开发者 · 青木` anywhere in its interface, while every non-visual copyright and licensing surface remains unchanged.
