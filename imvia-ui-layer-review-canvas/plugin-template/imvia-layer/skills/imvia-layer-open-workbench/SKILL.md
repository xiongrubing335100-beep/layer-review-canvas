---
name: imvia-layer-open-workbench
description: Open the Imvia Layer UI review workbench in Codex's right-side browser panel when the user asks to open, launch, or use the workbench or split a UI image into layers.
---

# Open Imvia Layer

When the user asks to open Imvia Layer, launch the layer review workbench, or split a UI image into layers, call the `open_layer_review_workbench` MCP tool directly.

The tool returns `workbenchUrl` and mounts a lightweight conversation-bridge card. Immediately call `codex_app__open_in_codex` with `{ placement: "right", target: { type: "browser", url: workbenchUrl } }`. This must open the workbench in the current task's right-side browser panel. Do not render the full workbench as an inline or fullscreen MCP App.

The right-side workbench opens in guided frame mode. The user can upload, arrange, frame, confirm, and split the image there.

After the right-side browser is visible, tell the user to upload the source image there. After submitting a split action, the mounted bridge card must present an enabled `发送到 Codex` control. Only the user's direct click on that control may call the host-bound `sendFollowUpMessage` capability with the full prompt and a confirmation title. Never call `sendFollowUpMessage` from polling, timers, or another automatic callback. After the host confirmation, the full visible follow-up message enters the same Codex conversation. The card must not treat transport acceptance as model confirmation. Never start a hidden background split from the browser page itself. If the bridge card is offline, stop and ask the user to reopen the plugin in the current task.
