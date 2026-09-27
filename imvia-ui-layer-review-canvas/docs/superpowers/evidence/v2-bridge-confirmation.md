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

### First live attempt: blank widget (2026-09-27)

The desktop loaded the V2 server and committed the widget frame, then logged `Failed to execute 'write' on 'Document': missing ) after argument list` at 12:34:49.816Z. Local parsing of every generated inline script reproduced the same error in the embedded SDK. `injectMcpAppsBridge` used a string replacement, which interpreted SDK `$` replacement tokens and corrupted its source. Changed that replacement to a callback so SDK contents remain literal. Added a regression that parses all three emitted scripts; observed failure before the fix and success after it. All 10 resource/bridge tests pass. The running MCP process must reload the module; live rendering and delivery remain unverified after this source fix.

This Codex session has no Imvia Layer workbench tool exposed. Its `imvia` tools are image-import tools, not this workbench. A separately named test MCP connection to this branch is required to test the real modal, visible user message and model acknowledgement without replacing the installed legacy plugin. No connection configuration has been changed and no production generation has run.
