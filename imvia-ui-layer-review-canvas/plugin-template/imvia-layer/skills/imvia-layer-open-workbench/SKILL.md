---
name: imvia-layer-open-workbench
description: Open the Imvia Layer UI review workbench in Codex's right-side browser panel when the user asks to open, launch, or use the workbench or split a UI image into layers.
---

# Open Imvia Layer

When the user asks to open Imvia Layer, launch the layer review workbench, or split a UI image into layers, call the `open_layer_review_workbench` MCP tool directly.

Every open or reopen defaults to a **new, empty V2 workbench** with a new workspace ID and session ID. Never look up or reuse a previous document, workspace, task, or browser URL to satisfy an ordinary opening request. The tool returns `workbenchUrl` and mounts the matching lightweight V2 conversation-bridge card in the same call. Immediately call `codex_app__open_in_codex` with `{ placement: "right", target: { type: "browser", url: workbenchUrl } }`. This must open the returned URL in the current task's right-side browser panel. Do not render the full workbench as an inline or fullscreen MCP App. Do not call a second opening tool to mount the bridge: that would create a different new workspace.

The right-side workbench initially shows the upload entry, with no source image, regions, candidates, or pending task from an earlier opening. The paired bridge waits for the first upload and then follows that document. The user can upload, arrange, frame, confirm, and split the image there. Existing saved documents are preserved, not deleted.

After the right-side browser is visible, tell the user to upload the source image there. A fresh bridge must not send or recover an earlier task. User-submitted split requests require host confirmation before the full visible follow-up message enters the same Codex conversation; transport acceptance is not model confirmation. Never start a hidden background split from the browser page itself.

Only when the user explicitly asks to continue an existing document or repair its connection, use `open_workbench_v2_bridge` with `mode: "resume"` and the exact current `documentId` and `workspaceId`. Ordinary requests to reopen the workbench or bridge still mean a new empty workspace. Both V2 opening tools default to `mode: "new"` even if stale IDs are supplied.
