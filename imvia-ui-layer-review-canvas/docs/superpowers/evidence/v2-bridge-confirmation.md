# V2 confirmation bridge verification

Date: 2026-09-27. Status: real visible-message acknowledgement verified after the script fix; subsequent compact styling verified locally, not yet reloaded in the desktop host.

## Successful live receipt and compact card

The user sent the diagnostic through the MCP app. Visible message request `probe-9314518c-6767-44f0-b7d9-c0959d284f84` arrived in this conversation; `confirm_workbench_v2_batch` returned `{ok:true}` with its exact session and envelope digest. The user confirmed receipt and supplied the completed-state card screenshot. No image generation ran.

Following user feedback, the card uses the approved dark/teal direction with a compact 14px title, 13px body, explicit 12px buttons, 14px corner radius and maximum width 640px. Actual acknowledgement hides both actions and redundant descriptive copy. Local headless Chrome rendering checked ready and received states; at 320px width the completed card has no horizontal overflow and is about 87px high. Eleven resource/bridge tests pass, including acknowledgement-driven hiding. The already-running MCP process still needs module reload to show the new styling; existing cards are not claimed updated.

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
