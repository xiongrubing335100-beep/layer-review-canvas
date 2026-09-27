---
name: imvia-layer-batch-v2
description: Execute one visibly confirmed Imvia Layer V2 frozen batch in serial order, preserving source coordinates and attempt identity.
---

# Imvia Layer V2 frozen batch

Use only after the exact V2 batch message is visible in the current Codex conversation. This skill never submits or confirms its own message.

1. Call `confirm_workbench_v2_batch` with the batch/request IDs and receipt values from the visible message. Stop if it fails. Keep the returned receipt.
2. Call `claim_workbench_v2_batch_item` with that batch ID and receipt. It returns at most one prepared item, or `done`/`running`. A `preparationFailed` result is already terminally recorded for that attempt; do not retry or call its finalizer, continue to the next claim only.
3. Verify attempt, batch, document, layer, dispatch, authorization, snapshot, source fingerprint, mode, selected bounds, route, call budget and provider against the frozen batch record and returned manifest. The prepared manifest already binds a crop to original source coordinates. Do not read or analyze other layers or submit the full poster to an image model.
4. Follow [the item contract](references/item-contract.md) for exactly that route. Preserve the raw result and a review report within the attempt folder. Do not adopt the candidate, change document layers, retry, publish or export.
5. If a valid region PNG and bound review report were produced, run `node scripts/finalize-v2-candidate.mjs --manifest <manifest> --raw <raw.png> --report <review.json> [--matte <matte.png>]`. If generation or evidence fails, run the same finalizer with `--failure-code <CODE> --failure-message <MESSAGE>` and include any available `--raw`/`--report` evidence. Never call either finalizer twice for the same attempt.
6. Call `record_workbench_v2_attempt_event` with the exact attempt ID and dispatch ID. Use `suggested` only when finalization returned an archived candidate version; use `failed` for a finalized failure. Then call `claim_workbench_v2_batch_item` again with the same receipt. Stop on `done`, cancellation, binding mismatch, or any authorization failure; never retry automatically.

The `text`/`brand_ui` extract-with-background-removal route may make at most one ImageGen call, using only `referencePath` to produce a black-background/white-foreground semantic matte. BRIA routes make zero ImageGen calls. Reconstruct may make at most one ImageGen call using only its prepared reference; if background removal is enabled, then use BRIA on the mapped selected-region result. The per-attempt manifest's budget and route are authoritative.
