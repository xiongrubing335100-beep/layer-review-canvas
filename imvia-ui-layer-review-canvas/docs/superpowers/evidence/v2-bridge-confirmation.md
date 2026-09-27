# V2 confirmation bridge verification

Date: 2026-09-27. Status: automated verification only; real Codex host gate remains pending.

## Implemented contract

- Dedicated V2 no-generation probe widget; no change to the V1 widget.
- Preparation binds a batch, session and server-computed canonical-envelope SHA-256.
- A user click invokes the host message API directly; SDK resolution does not mark delivery.
- Only the model-visible confirmation tool can acknowledge matching delivery.
- Duplicate requests do not resend; changed bindings are rejected; cancellation is terminal and rejects late acknowledgement.
- The probe explicitly prohibits ImageGen, RMBG and production task execution.

## Automated evidence

`src/v2/batch-bridge.test.mjs` covers duplicate clicks, request rebinding, acknowledgement, cancellation, abort and synchronous host exceptions. It exercises the real MCP SDK in-memory transport and the generated widget script with a controlled host adapter.

The actual server factory exposes all five V2 tools in an in-memory MCP session. This does not prove desktop resource rendering or a real confirmation modal.

An existing V1 regression test (`src/mcp-bridge-widget.test.mjs`, test starting at line 46) expects `presentation.preview`, whereas its unchanged implementation supplies `title` and `scrollToBottom`. The mismatch is present at execution base `a873ee1`; neither V1 file was changed for this task.

## Outstanding gate

This Codex session has no Imvia Layer workbench tool exposed. Its `imvia` tools are image-import tools, not this workbench. A separately named test MCP connection to this branch is required to test the real modal, visible user message and model acknowledgement without replacing the installed legacy plugin. No connection configuration has been changed and no production generation has run.
