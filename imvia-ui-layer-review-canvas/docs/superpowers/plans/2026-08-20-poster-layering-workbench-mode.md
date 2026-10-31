# Imvia Layer Poster Layering Workbench Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an explicit poster-layering mode to Imvia Layer that plans source-evidenced full-canvas layers, generates one user-reviewed candidate per authorization, and exports only accepted green/black-key layers after recomposition audit.

**Architecture:** Keep the existing UI split pipeline unchanged and add a separate poster domain beside it. Reuse project documents, the current-conversation bridge, cancellation, and page lifecycle, while giving poster jobs their own plan, manifest, store, APIs, adapter skill, review components, and output package.

**Tech Stack:** React 19, Vite 8 middleware, Node.js ESM, MCP Apps SDK, Python 3/Pillow for deterministic image normalization, Node test runner, Python unittest.

**Spec:** `docs/superpowers/specs/2026-08-20-poster-layering-workbench-mode-design.md`

## Global Constraints

- Do not modify `/Users/a1234/.codex/skills/lovart-poster-layering-v3-1` or copy its rules into a divergent implementation.
- Existing image documents without `documentMode` normalize to `"ui"`.
- Poster analysis must not call ImageGen; candidate generation processes exactly one confirmed layer.
- One generation authorization creates exactly one candidate. No automatic retry is permitted.
- Normal poster layers use uniform `#00FF00`; Screen/Add effects use uniform `#000000`; formal layers never mix transparency with a key field.
- Poster candidates and accepted layers stay on the full source canvas at original coordinates.
- Hard-failure candidates cannot be accepted. A user action is required for both acceptance and retry.
- UI plans, UI `final/` results, result refinement, and all current UI tests must remain unchanged.
- Every task follows red-green TDD and ends with a focused commit that contains only that task.

---

## File Structure

New domain files and their single responsibilities:

- `src/poster-mode.js`: normalize document mode and guard mode changes.
- `src/poster-plan.js`: construct, validate, edit, version, and confirm poster ownership plans.
- `src/poster-candidate-state.js`: pure candidate/retry/acceptance state machine.
- `src/poster-workbench-host.js`: browser/MCP client for poster endpoints.
- `src/poster-job-store.js`: locked, atomic poster plan/manifest persistence.
- `src/poster-prompt.js`: compact analysis and one-layer candidate messages.
- `src/poster-release-gate.js`: standard v3.1 failure-code and acceptance precondition checks.
- `src/poster-recomposition.js`: deterministic audit inputs and export readiness.
- `src/PosterModePicker.jsx`: explicit upload-time document-mode choice.
- `src/PosterPlanReview.jsx`: evidence and ownership-plan editor.
- `src/PosterCandidateReview.jsx`: source/candidate/overlay/review controls.
- `scripts/normalize-poster-layer.py`: deterministic full-canvas key validation, scaling, and padding.
- `scripts/prepare-poster-job.mjs`: mechanical analysis/candidate preflight with no pixel generation.
- `scripts/finalize-poster-analysis.mjs`: validate and atomically bind an analysis plan to `PLAN_REVIEW`.
- `scripts/finalize-poster-candidate.mjs`: bind exactly one raw candidate and review report without accepting it.
- `plugin-template/imvia-layer/skills/imvia-poster-layering-workbench-v1/`: adapter skill that references immutable v3.1.

Existing files changed only at integration boundaries:

- `src/project-state.js`: persist `documentMode` and poster job references.
- `src/main.jsx`: select the document shell and connect poster components; do not add poster protocol logic here.
- `src/styles.css`: poster picker and review surfaces.
- `src/foreground-dispatch.js`: support a task-kind and explicit plan path while preserving UI defaults.
- `src/mcp-workbench-host.js`: no poster behavior; poster calls live in the new host module.
- `vite.config.js`: mount poster middleware routes and aggregate UI/poster foreground queues.
- `layer-review-mcp-server.mjs`: register poster app tools and poster confirmation tool.
- `scripts/install-codex-plugin.mjs`: include the new adapter skill in the installed plugin.
- `docs/guides/imvia-layer-workbench-user-guide.md`: explain the explicit mode and review flow.

---

### Task 1: Persist Explicit Document Mode

**Files:**
- Create: `src/poster-mode.js`
- Create: `src/poster-mode.test.mjs`
- Modify: `src/project-state.js`
- Modify: `src/project-state.test.mjs`

**Interfaces:**
- Produces: `normalizeDocumentMode(value): "ui" | "poster"`
- Produces: `canChangeDocumentMode({ currentMode, nextMode, hasModeState }): boolean`
- Extends: `createImageDocument({ documentMode, posterJobId, posterPlanVersion })`

- [ ] **Step 1: Write failing document-mode tests**

```js
test('legacy documents default to UI mode', () => {
  assert.equal(createImageDocument({ imageId: 'legacy' }).documentMode, 'ui');
});

test('poster mode persists independently per image', () => {
  const poster = createImageDocument({ imageId: 'p', documentMode: 'poster' });
  const ui = createImageDocument({ imageId: 'u', documentMode: 'ui' });
  assert.equal(poster.documentMode, 'poster');
  assert.equal(ui.documentMode, 'ui');
});

test('mode changes require an empty mode-specific state', () => {
  assert.equal(canChangeDocumentMode({
    currentMode: 'poster', nextMode: 'ui', hasModeState: true,
  }), false);
});
```

- [ ] **Step 2: Run tests and verify the red state**

Run: `node --test src/poster-mode.test.mjs src/project-state.test.mjs`

Expected: FAIL because `poster-mode.js` is missing and image documents do not include `documentMode`.

- [ ] **Step 3: Implement the pure mode contract**

```js
export function normalizeDocumentMode(value) {
  return value === 'poster' ? 'poster' : 'ui';
}

export function canChangeDocumentMode({ currentMode, nextMode, hasModeState }) {
  return normalizeDocumentMode(currentMode) === normalizeDocumentMode(nextMode)
    || !hasModeState;
}
```

Update `createImageDocument` to return:

```js
documentMode: normalizeDocumentMode(documentMode),
posterJobId: typeof posterJobId === 'string' ? posterJobId : '',
posterPlanVersion: Number.isInteger(posterPlanVersion) ? posterPlanVersion : 0,
```

- [ ] **Step 4: Run the focused tests**

Run: `node --test src/poster-mode.test.mjs src/project-state.test.mjs`

Expected: PASS.

- [ ] **Step 5: Commit the mode foundation**

```bash
git add src/poster-mode.js src/poster-mode.test.mjs src/project-state.js src/project-state.test.mjs
git commit -m "feat: persist poster document mode"
```

---

### Task 2: Model and Validate the Authoritative Poster Plan

**Files:**
- Create: `src/poster-plan.js`
- Create: `src/poster-plan.test.mjs`

**Interfaces:**
- Produces: `POSTER_PLAN_VERSION = "1.0"`
- Produces: `createPosterPlan(input): PosterPlan`
- Produces: `validatePosterPlan(plan): { valid: boolean, errors: Array<{ path, code, message }> }`
- Produces: `updatePosterLayer(plan, layerIndex, patch): PosterPlan`
- Produces: `confirmPosterPlan(plan, confirmedAt): PosterPlan`
- Consumes later: every server and UI task treats this module as the only plan authority.

- [ ] **Step 1: Write failing plan-contract tests**

```js
const requiredLayer = {
  layer_index: 1,
  layer_name: '主标题',
  asset_role: 'headline',
  layer_type: 'graphic',
  z_order: 1,
  position: 'full canvas coordinates',
  visible_content: ['老师您辛苦了'],
  included_content: ['source-visible title pixels'],
  excluded_content: ['9/10 date'],
  occludes: [],
  occluded_by: [],
  source_evidence: [{ description: 'central dark calligraphy', region: [0.1, 0.1, 0.6, 0.3] }],
  support_components: [],
  ui_independence: 'not_applicable',
  repair_envelope: { description: '', covered_segment: [], seam_band: '', forbidden_regions: [] },
  locked_visible_anchors: ['all visible glyph pixels'],
  completion_required: false,
  completion_regions: [],
  risk_level: 'high',
  processing_mode: 'graphic_completion',
  fill_color: '#00FF00',
  compositing_mode: 'Normal',
  separation_reason: 'independent headline',
};

test('poster plans require every v3.1 ownership field', () => {
  const plan = createPosterPlan(fixture({ layers: [{ ...requiredLayer, source_evidence: undefined }] }));
  assert.deepEqual(validatePosterPlan(plan).errors.map((error) => error.path), [
    'layers[0].source_evidence',
  ]);
});

test('independent UI cannot be merged into a headline', () => {
  const plan = createPosterPlan(fixture({ layers: [{
    ...requiredLayer,
    asset_role: 'headline',
    included_content: ['headline', 'date badge'],
    ui_independence: 'independent',
  }] }));
  assert.equal(validatePosterPlan(plan).errors[0].code, 'UI_BUNDLING_ERROR');
});
```

- [ ] **Step 2: Run the plan tests and verify failure**

Run: `node --test src/poster-plan.test.mjs`

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement plan construction and validation**

The implementation must enumerate exact required fields, accepted enum values, unique positive `layer_index`, front-to-back `z_order`, safe full-canvas source dimensions, and key/compositing compatibility. Return errors rather than throwing for user-editable problems.

```js
export function confirmPosterPlan(plan, confirmedAt = new Date().toISOString()) {
  const validation = validatePosterPlan(plan);
  if (!validation.valid) throw new PosterPlanValidationError(validation.errors);
  return {
    ...plan,
    status: 'PLAN_CONFIRMED',
    plan_version: Number(plan.plan_version || 0) + 1,
    confirmed_at: confirmedAt,
  };
}
```

Any structural edit to a confirmed plan must return `PLAN_REVIEW`, increment `plan_version`, and mark non-accepted candidates from older versions invalid.

- [ ] **Step 4: Add mutation/version tests and make them pass**

```js
test('editing a confirmed plan invalidates unaccepted candidate versions', () => {
  const edited = updatePosterLayer(confirmedFixture(), 1, { layer_name: '新主标题' });
  assert.equal(edited.status, 'PLAN_REVIEW');
  assert.equal(edited.plan_version, 3);
});
```

Run: `node --test src/poster-plan.test.mjs`

Expected: PASS.

- [ ] **Step 5: Commit the poster plan model**

```bash
git add src/poster-plan.js src/poster-plan.test.mjs
git commit -m "feat: define poster ownership plan"
```

---

### Task 3: Implement the Candidate Authorization State Machine

**Files:**
- Create: `src/poster-candidate-state.js`
- Create: `src/poster-candidate-state.test.mjs`

**Interfaces:**
- Produces: `reducePosterLayerState(layerState, event): PosterLayerState`
- Produces: `canGeneratePosterCandidate(layerState): boolean`
- Produces: `canAcceptPosterCandidate(layerState): boolean`
- Produces: `candidateFileName({ layerIndex, slug, generationCount }): string`
- Consumes: `planVersion` from Task 2.

- [ ] **Step 1: Write failing no-auto-retry tests**

```js
test('one authorization creates one generation only', () => {
  let state = posterLayerFixture({ status: 'PENDING', generationCount: 0 });
  state = reducePosterLayerState(state, { type: 'GENERATION_AUTHORIZED', planVersion: 2 });
  state = reducePosterLayerState(state, { type: 'GENERATION_STARTED' });
  state = reducePosterLayerState(state, { type: 'GENERATION_FAILED', error: 'ImageGen failed' });
  assert.equal(canGeneratePosterCandidate(state), false);
  assert.equal(state.status, 'HARD_REJECTED');
});

test('retry requires an explicit authorization event', () => {
  const rejected = posterLayerFixture({ status: 'HARD_REJECTED', generationCount: 1 });
  const retry = reducePosterLayerState(rejected, { type: 'RETRY_AUTHORIZED' });
  assert.equal(retry.status, 'RETRY_AUTHORIZED');
  assert.equal(canGeneratePosterCandidate(retry), true);
});
```

- [ ] **Step 2: Run and confirm the missing-module failure**

Run: `node --test src/poster-candidate-state.test.mjs`

Expected: FAIL.

- [ ] **Step 3: Implement explicit transitions**

Reject illegal transitions by throwing `PosterCandidateTransitionError`. `CANDIDATE_CREATED` requires a candidate ID/path and matching plan version. `HARD_REJECTED` cannot transition directly to `ACCEPTED`. `NEEDS_USER_REVIEW` can transition to `ACCEPTED` or `RETRY_AUTHORIZED` only.

```js
const legal = {
  PENDING: ['GENERATION_AUTHORIZED'],
  RETRY_AUTHORIZED: ['GENERATION_STARTED'],
  GENERATION_AUTHORIZED: ['GENERATION_STARTED'],
  GENERATING: ['CANDIDATE_CREATED', 'GENERATION_FAILED'],
  CANDIDATE_CREATED: ['HARD_FAILURE_FOUND', 'REVIEW_READY'],
  NEEDS_USER_REVIEW: ['CANDIDATE_ACCEPTED', 'RETRY_AUTHORIZED'],
  HARD_REJECTED: ['RETRY_AUTHORIZED'],
};
```

- [ ] **Step 4: Add stale-plan and acceptance tests**

```js
test('a stale candidate cannot be accepted', () => {
  const state = posterLayerFixture({
    status: 'NEEDS_USER_REVIEW', candidatePlanVersion: 2, activePlanVersion: 3,
  });
  assert.equal(canAcceptPosterCandidate(state), false);
});
```

Run: `node --test src/poster-candidate-state.test.mjs`

Expected: PASS.

- [ ] **Step 5: Commit the state machine**

```bash
git add src/poster-candidate-state.js src/poster-candidate-state.test.mjs
git commit -m "feat: enforce poster candidate authorization"
```

---

### Task 4: Build the Locked Poster Job Store

**Files:**
- Create: `src/poster-job-store.js`
- Create: `src/poster-job-store.test.mjs`

**Interfaces:**
- Produces: `initializePosterJob({ outputRoot, jobId, sourcePath, plan }): Promise<PosterJobRecord>`
- Produces: `readPosterJob(outputRoot, jobId): Promise<PosterJobRecord | null>`
- Produces: `mutatePosterJob(outputRoot, jobId, expectedVersion, mutation): Promise<PosterJobRecord>`
- Produces: `recordPosterCandidate(outputRoot, jobId, candidate): Promise<PosterJobRecord>`
- Consumes: `withDirectoryLock` from `src/file-lock.js`, Task 2 plan, Task 3 states.

- [ ] **Step 1: Write failing package-layout and atomic-version tests**

```js
test('initialization creates the required poster package', async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'poster-jobs-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  const record = await initializePosterJob({
    outputRoot: root, jobId: 'poster-job-1', sourcePath: fixturePng, plan: planFixture(),
  });
  assert.equal(path.basename(record.paths.source), 'source.png');
  assert.deepEqual((await readdir(record.paths.root)).sort(), [
    'candidates', 'evidence', 'layer_manifest.json', 'layers',
    'poster-execution-report.json', 'poster-layer-plan.json', 'source.png',
  ].sort());
});

test('stale manifest versions cannot overwrite a newer review', async () => {
  await assert.rejects(
    mutatePosterJob(root, 'poster-job-1', 1, (record) => record),
    /版本已变化/,
  );
});
```

- [ ] **Step 2: Run store tests and verify failure**

Run: `node --test src/poster-job-store.test.mjs`

Expected: FAIL.

- [ ] **Step 3: Implement safe paths, initialization, and atomic mutation**

Use `path.resolve`, a job ID regex of `/^[a-zA-Z0-9._-]+$/`, containment checks, `withDirectoryLock`, and same-directory temporary writes followed by `rename`. Copy the immutable v3.1 manifest template, preserving `candidate_visibility: "hidden"`.

```js
export async function mutatePosterJob(outputRoot, jobId, expectedVersion, mutation) {
  return withDirectoryLock(lockPath(outputRoot, jobId), async () => {
    const current = await readPosterJob(outputRoot, jobId);
    if (current.manifest.revision !== expectedVersion) {
      throw new PosterJobConflictError('海报任务版本已变化');
    }
    const next = await mutation(structuredClone(current));
    next.manifest.revision += 1;
    await atomicWriteJson(current.paths.plan, next.plan);
    await atomicWriteJson(current.paths.manifest, next.manifest);
    return readPosterJob(outputRoot, jobId);
  });
}
```

- [ ] **Step 4: Add traversal, concurrent mutation, and candidate retention tests**

Run: `node --test src/poster-job-store.test.mjs`

Expected: PASS, including concurrent attempts where exactly one expected-version mutation succeeds.

- [ ] **Step 5: Commit the poster store**

```bash
git add src/poster-job-store.js src/poster-job-store.test.mjs
git commit -m "feat: add atomic poster job store"
```

---

### Task 5: Create the Workbench Adapter Skill and Prompts

**Files:**
- Create: `src/poster-prompt.js`
- Create: `src/poster-prompt.test.mjs`
- Create: `scripts/prepare-poster-job.mjs`
- Create: `scripts/prepare-poster-job.test.mjs`
- Create: `scripts/finalize-poster-analysis.mjs`
- Create: `scripts/finalize-poster-analysis.test.mjs`
- Create: `scripts/finalize-poster-candidate.mjs`
- Create: `scripts/finalize-poster-candidate.test.mjs`
- Create: `plugin-template/imvia-layer/skills/imvia-poster-layering-workbench-v1/SKILL.md`
- Create: `plugin-template/imvia-layer/skills/imvia-poster-layering-workbench-v1/agents/openai.yaml`
- Modify: `scripts/install-codex-plugin.mjs`
- Modify: `src/setup-imvia-layer.test.mjs`

**Interfaces:**
- Produces: `buildPosterAnalysisPrompt({ jobId, planPath, sourcePath }): string`
- Produces: `buildPosterCandidatePrompt({ jobId, planPath, layerIndex, candidateNumber }): string`
- Produces skill contract: analysis writes plan only; candidate creates exactly one file and one non-accepting review report.
- Produces mechanical commands that validate job kind, plan version, source dimensions, layer authorization, candidate count, and output containment before state changes.

- [ ] **Step 1: Write failing prompt and install tests**

```js
test('analysis explicitly forbids generation', () => {
  const prompt = buildPosterAnalysisPrompt(fixture());
  assert.match(prompt, /禁止调用 ImageGen/);
  assert.match(prompt, /poster-layer-plan\.json/);
  assert.doesNotMatch(prompt, /生成候选第/);
});

test('candidate prompt authorizes exactly one layer and one candidate', () => {
  const prompt = buildPosterCandidatePrompt({ ...fixture(), layerIndex: 3, candidateNumber: 1 });
  assert.match(prompt, /只处理 layer_index=3/);
  assert.match(prompt, /只允许一次 ImageGen 调用/);
  assert.match(prompt, /不得接受候选/);
});
```

- [ ] **Step 2: Run prompt tests and confirm failure**

Run: `node --test src/poster-prompt.test.mjs src/setup-imvia-layer.test.mjs`

Expected: FAIL because the prompt module and adapter skill are absent.

- [ ] **Step 3: Create the adapter skill without duplicating v3.1**

The skill must require the executor to read:

```text
/Users/a1234/.codex/skills/lovart-poster-layering-v3-1/SKILL.md
/Users/a1234/.codex/skills/lovart-poster-layering-v3-1/references/layer-rules.md
/Users/a1234/.codex/skills/lovart-poster-layering-v3-1/references/prompt-templates.md
```

Analysis flow: confirm receipt, run poster-plan preflight, inspect the full source, write evidence and plan, write terminal `PLAN_REVIEW`, and never call ImageGen.

Candidate flow: confirm receipt, verify `PLAN_CONFIRMED` and plan version, process exactly one layer, call ImageGen once, save the raw candidate, visually compare it, record v3.1 failure codes or `NEEDS_USER_REVIEW`, and stop without accepting or writing `layers/`.

- [ ] **Step 4: Add mechanical analysis and candidate boundaries**

`prepare-poster-job.mjs --job-id <id> --phase analysis|candidate [--layer-index N]` reads the store and emits a compact trusted JSON spec. Analysis rejects any existing candidate request. Candidate preflight requires `PLAN_CONFIRMED`, the current plan version, an authorized target layer, and the next exact candidate number.

`finalize-poster-analysis.mjs --job-id <id> --analysis-plan <path>` validates the complete Task 2 schema, evidence paths, source identity, and output containment, then atomically writes `PLAN_REVIEW`. It must not create `candidates/` files.

`finalize-poster-candidate.mjs --job-id <id> --layer-index <n> --candidate-input <path> --review-report <path>` verifies one ImageGen authorization was consumed, copies exactly one candidate to the deterministic Task 3 filename, evaluates the release gate report, and writes either `HARD_REJECTED` or `NEEDS_USER_REVIEW`. It must never write `layers/` or mark `ACCEPTED`.

```js
test('candidate finalization cannot accept or publish a layer', async () => {
  const result = await finalizeCandidate(fixture());
  assert.match(result.status, /HARD_REJECTED|NEEDS_USER_REVIEW/);
  assert.equal((await readdir(result.layersDirectory)).length, 0);
});
```

Run: `node --test scripts/prepare-poster-job.test.mjs scripts/finalize-poster-analysis.test.mjs scripts/finalize-poster-candidate.test.mjs`

Expected: PASS.

- [ ] **Step 5: Wire plugin installation and make tests pass**

Add the adapter skill directory to the same copy/install mechanism used for current plugin skills. Test the installed file contains the immutable base skill name and `auto_retry: false`.

Run: `node --test src/poster-prompt.test.mjs src/setup-imvia-layer.test.mjs scripts/prepare-poster-job.test.mjs scripts/finalize-poster-analysis.test.mjs scripts/finalize-poster-candidate.test.mjs`

Expected: PASS.

- [ ] **Step 6: Commit prompts, mechanical boundaries, and skill**

```bash
git add src/poster-prompt.js src/poster-prompt.test.mjs scripts/prepare-poster-job.mjs scripts/prepare-poster-job.test.mjs scripts/finalize-poster-analysis.mjs scripts/finalize-poster-analysis.test.mjs scripts/finalize-poster-candidate.mjs scripts/finalize-poster-candidate.test.mjs plugin-template/imvia-layer/skills/imvia-poster-layering-workbench-v1 scripts/install-codex-plugin.mjs src/setup-imvia-layer.test.mjs
git commit -m "feat: add poster workbench adapter skill"
```

---

### Task 6: Route Poster Analysis and Candidates Through the Visible Conversation

**Files:**
- Modify: `src/foreground-dispatch.js`
- Modify: `src/foreground-dispatch.test.mjs`
- Create: `src/poster-workbench-host.js`
- Create: `src/poster-workbench-host.test.mjs`
- Modify: `vite.config.js`
- Modify: `layer-review-mcp-server.mjs`
- Modify: `src/mcp-bridge-server.test.mjs`
- Modify: `src/visible-conversation-route.test.mjs`

**Interfaces:**
- Extends dispatch payload: `{ taskKind, planPath, presentation }`
- Produces host calls: `submitPosterAnalysis`, `submitPosterCandidate`, `getPosterJob`, `updatePosterPlan`, `confirmPosterPlan`, `cancelPosterJob`, `abandonPosterJob`, `confirmPosterDispatch`
- Produces app tools: `submit_poster_layer_analysis`, `submit_poster_layer_candidate`, `get_poster_layer_job`, `update_poster_layer_plan`, `confirm_poster_layer_plan`, `cancel_poster_layer_job`, `abandon_poster_layer_job`, `confirm_poster_foreground_dispatch`
- Consumes: Tasks 4 and 5.

- [ ] **Step 1: Write failing generic-dispatch tests**

```js
test('poster dispatch updates its explicit poster plan path', async () => {
  await enqueueForegroundDispatch(transportDirectory, {
    jobId: 'poster-job-1',
    taskKind: 'poster_analysis',
    planPath: posterPlanPath,
    prompt: 'analyze',
    submittedAt: now,
  });
  const claim = await claimNextForegroundDispatchFromRoots(
    [uiJobsDirectory, posterJobsDirectory],
    { bridgeId: 'bridge-1', claimedAt: now },
  );
  assert.equal(claim.taskKind, 'poster_analysis');
  assert.equal(JSON.parse(await readFile(posterPlanPath)).status, 'sending_to_codex');
});
```

- [ ] **Step 2: Run dispatch tests and verify the missing multi-root behavior**

Run: `node --test src/foreground-dispatch.test.mjs src/poster-workbench-host.test.mjs`

Expected: FAIL.

- [ ] **Step 3: Generalize dispatch with safe defaults**

Keep all existing exports working for UI callers. Add:

```js
export async function claimNextForegroundDispatchFromRoots(roots, options) { /* oldest eligible */ }
export async function readForegroundQueueSummaryFromRoots(roots, options) { /* merged summary */ }
```

Resolve the status plan from `dispatch.planPath` only after verifying it is inside an allowed output root; otherwise use `path.join(jobDirectory, 'layer-review-plan.json')`. Include `taskKind` in claim responses and UI messages.

- [ ] **Step 4: Add poster HTTP and MCP tools**

Implement:

```text
POST /api/poster-layer/jobs/analyze
POST /api/poster-layer/jobs/:jobId/candidates/:layerIndex
GET  /api/poster-layer/jobs/:jobId
PATCH /api/poster-layer/jobs/:jobId/plan
POST /api/poster-layer/jobs/:jobId/plan/confirm
POST /api/poster-layer/jobs/:jobId/cancel
POST /api/poster-layer/jobs/:jobId/abandon
POST /api/poster-layer/jobs/:jobId/confirm-dispatch
```

Both submit routes initialize or mutate the poster job, enqueue one visible message, and return `202`. The candidate route rejects unconfirmed plans, missing explicit authorization, stale plan versions, and any layer already `GENERATING`. Plan update/confirm routes require an expected manifest revision. Cancel and abandon preserve the existing accurate limitation: they release local queue ownership and ignore late results but do not claim to stop an active Codex turn.

- [ ] **Step 5: Test MCP-host and standalone-host parity**

```js
test('poster analysis uses a dedicated MCP app tool', async () => {
  await submitPosterAnalysis(plan);
  assert.deepEqual(calls[0], ['submit_poster_layer_analysis', { plan }]);
});
```

Run: `node --test src/foreground-dispatch.test.mjs src/poster-workbench-host.test.mjs src/mcp-bridge-server.test.mjs src/visible-conversation-route.test.mjs`

Expected: PASS.

- [ ] **Step 6: Commit visible poster routing**

```bash
git add src/foreground-dispatch.js src/foreground-dispatch.test.mjs src/poster-workbench-host.js src/poster-workbench-host.test.mjs vite.config.js layer-review-mcp-server.mjs src/mcp-bridge-server.test.mjs src/visible-conversation-route.test.mjs
git commit -m "feat: route poster jobs through current conversation"
```

---

### Task 7: Enforce Release Gate, Acceptance, and Explicit Retry

**Files:**
- Create: `src/poster-release-gate.js`
- Create: `src/poster-release-gate.test.mjs`
- Create: `scripts/normalize-poster-layer.py`
- Create: `scripts/test_normalize_poster_layer.py`
- Modify: `src/poster-job-store.js`
- Modify: `src/poster-job-store.test.mjs`
- Modify: `src/poster-workbench-host.js`
- Modify: `src/poster-workbench-host.test.mjs`
- Modify: `vite.config.js`
- Modify: `layer-review-mcp-server.mjs`

**Interfaces:**
- Produces: `POSTER_FAILURE_CODES: ReadonlySet<string>`
- Produces: `evaluatePosterRelease({ layer, candidate, review }): { verdict, failureCodes, checks }`
- Produces: `acceptPosterCandidate({ outputRoot, jobId, layerIndex, candidateId, expectedRevision })`
- Produces: `authorizePosterRetry({ outputRoot, jobId, layerIndex, expectedRevision })`
- Consumes: Task 3 state machine and Task 4 store.

- [ ] **Step 1: Write failing failure-code and acceptance tests**

```js
test('mutated title geometry is a hard failure', () => {
  const result = evaluatePosterRelease({
    layer: headlineFixture(),
    candidate: candidateFixture(),
    review: { textOrLogoMutated: true },
  });
  assert.equal(result.verdict, 'HARD_REJECTED');
  assert.deepEqual(result.failureCodes, ['TEXT_OR_LOGO_MUTATED']);
});

test('hard failures cannot be accepted', async () => {
  await assert.rejects(
    acceptPosterCandidate({ ...fixture(), candidateId: 'candidate-hard' }),
    /硬失败候选不能接受/,
  );
});
```

- [ ] **Step 2: Run release tests and verify failure**

Run: `node --test src/poster-release-gate.test.mjs src/poster-job-store.test.mjs`

Expected: FAIL.

- [ ] **Step 3: Implement all immutable v3.1 failure codes**

Include exactly:

```js
new Set([
  'UNSUPPORTED_GRAPHIC_EFFECT', 'UI_BUNDLING_ERROR', 'VISIBLE_ANCHOR_MUTATION',
  'WHOLE_ASSET_REGENERATION', 'REPAIR_ENVELOPE_EXCEEDED', 'COMPLETION_MISSING',
  'ANATOMY_OR_STRUCTURE_BROKEN', 'TEXT_OR_LOGO_MUTATED', 'BACKGROUND_LAYOUT_DRIFT',
  'OCCLUDER_OWNERSHIP_ERROR', 'EFFECT_CONTINUITY_BROKEN', 'FOREIGN_CONTENT_LEAK',
  'REGISTRATION_UNCERTAIN', 'KEY_UNUSABLE', 'CANVAS_OR_GREEN_FIELD_INVALID',
]);
```

Unknown failure codes are rejected as invalid reports rather than ignored.

Add a table-driven test with one fixture for every code in `POSTER_FAILURE_CODES`; each fixture must produce `HARD_REJECTED` and must make `canAcceptPosterCandidate` false.

- [ ] **Step 4: Implement deterministic normalization**

`normalize-poster-layer.py` accepts `--input`, `--output`, `--source-width`, `--source-height`, `--fill-color`, and `--compositing-mode`. It validates PNG readability, aspect ratio, uniform key field, and absence of mixed Alpha. It may only uniformly scale and fixed-canvas pad. It exits nonzero for crop, stretch, registration uncertainty, or contaminated key.

```python
def normalize_candidate(image, source_size, fill_color):
    if image.mode not in ('RGB', 'RGBA'):
        raise ValidationError('CANVAS_OR_GREEN_FIELD_INVALID')
    if image.mode == 'RGBA' and image.getextrema()[3] != (255, 255):
        raise ValidationError('CANVAS_OR_GREEN_FIELD_INVALID')
    return uniform_scale_and_pad(image.convert('RGB'), source_size, fill_color)
```

- [ ] **Step 5: Add accept/retry routes and tests**

```text
POST /api/poster-layer/jobs/:jobId/layers/:layerIndex/accept
POST /api/poster-layer/jobs/:jobId/layers/:layerIndex/retry
```

Accept requires `NEEDS_USER_REVIEW`, matching candidate/plan/revision, runs the Python normalizer, writes `layers/layer_<index>_<slug>_source.png`, then marks `ACCEPTED`. Retry only writes `RETRY_AUTHORIZED`; it does not enqueue generation until the user separately clicks generate.

Run: `node --test src/poster-release-gate.test.mjs src/poster-job-store.test.mjs src/poster-workbench-host.test.mjs && python3 -m unittest scripts/test_normalize_poster_layer.py`

Expected: PASS.

- [ ] **Step 6: Commit the release gate**

```bash
git add src/poster-release-gate.js src/poster-release-gate.test.mjs scripts/normalize-poster-layer.py scripts/test_normalize_poster_layer.py src/poster-job-store.js src/poster-job-store.test.mjs src/poster-workbench-host.js src/poster-workbench-host.test.mjs vite.config.js layer-review-mcp-server.mjs
git commit -m "feat: gate and accept poster candidates"
```

---

### Task 8: Add the Explicit Picker and Plan Review UI

**Files:**
- Create: `src/PosterModePicker.jsx`
- Create: `src/poster-mode-picker.test.mjs`
- Create: `src/PosterPlanReview.jsx`
- Create: `src/poster-plan-review.test.mjs`
- Modify: `src/main.jsx`
- Modify: `src/styles.css`
- Modify: `src/workbench-layout.test.mjs`
- Modify: `src/workbench-toolbar.test.mjs`

**Interfaces:**
- Consumes: Task 1 document mode, Task 2 plan, Task 6 host.
- Produces: `PosterModePicker({ value, onChange, disabled })`
- Produces: `PosterPlanReview({ plan, validation, onLayerChange, onReorder, onDelete, onMerge, onConfirm })`

- [ ] **Step 1: Write failing static UI tests**

```js
test('empty upload state exposes explicit UI and poster choices', () => {
  const markup = renderToStaticMarkup(<PosterModePicker value="poster" onChange={() => {}} />);
  assert.match(markup, />UI\/运营图拆分</);
  assert.match(markup, />海报分层</);
  assert.match(markup, /aria-pressed="true"/);
});

test('poster plan review exposes evidence and ownership fields', () => {
  const markup = renderToStaticMarkup(<PosterPlanReview plan={planFixture()} validation={{ errors: [] }} />);
  assert.match(markup, /来源证据/);
  assert.match(markup, /遮挡关系/);
  assert.match(markup, /锁定可见锚点/);
  assert.match(markup, /修复范围/);
});
```

- [ ] **Step 2: Run UI tests and confirm failure**

Run: `node --test src/poster-mode-picker.test.mjs src/poster-plan-review.test.mjs src/workbench-layout.test.mjs`

Expected: FAIL.

- [ ] **Step 3: Implement the picker and document shell**

The picker appears before upload. Creating a source image passes the selected mode to `createImageDocument`. Legacy/current images do not change. `main.jsx` renders the existing guided UI for `ui` and a poster shell for `poster`; it does not branch inside `buildPlan`.

- [ ] **Step 4: Implement plan analysis/review interactions**

The poster shell has “分析海报层级” before analysis, progress while queued/processing, and `PosterPlanReview` for `PLAN_REVIEW`. Confirmation is disabled while `validatePosterPlan` has errors. Merge opens a confirmation and refuses `UI_BUNDLING_ERROR` combinations.

```js
const canConfirm = plan.status === 'PLAN_REVIEW' && validation.valid;
```

- [ ] **Step 5: Add accessibility and responsive tests**

Assert mode buttons have names and pressed state; reorder buttons have layer-specific labels; validation errors use `role="alert"`; poster selection survives switching between two image documents.

Run: `node --test src/poster-mode-picker.test.mjs src/poster-plan-review.test.mjs src/workbench-layout.test.mjs src/workbench-toolbar.test.mjs src/project-state.test.mjs`

Expected: PASS.

- [ ] **Step 6: Commit plan-review UI**

```bash
git add src/PosterModePicker.jsx src/poster-mode-picker.test.mjs src/PosterPlanReview.jsx src/poster-plan-review.test.mjs src/main.jsx src/styles.css src/workbench-layout.test.mjs src/workbench-toolbar.test.mjs
git commit -m "feat: add poster plan review workspace"
```

---

### Task 9: Add Candidate Comparison and Review UI

**Files:**
- Create: `src/PosterCandidateReview.jsx`
- Create: `src/poster-candidate-review.test.mjs`
- Create: `src/poster-preview.js`
- Create: `src/poster-preview.test.mjs`
- Modify: `src/main.jsx`
- Modify: `src/styles.css`
- Modify: `src/job-state.js`
- Modify: `src/job-state.test.mjs`

**Interfaces:**
- Consumes: Task 3 state, Task 6/7 host methods.
- Produces: `posterCandidateViewModel(job, layerIndex)`
- Produces: `PosterCandidateReview({ sourceUrl, candidateUrl, layer, review, onGenerate, onAccept, onRetry })`
- Produces: `derivePosterPreview({ candidateUrl, fillColor })` for display-only simulated transparency.

- [ ] **Step 1: Write failing candidate-control tests**

```js
test('hard rejected candidates never show accept', () => {
  const markup = renderToStaticMarkup(<PosterCandidateReview {...fixture({ status: 'HARD_REJECTED' })} />);
  assert.doesNotMatch(markup, />接受候选</);
  assert.match(markup, />重新生成此层</);
});

test('review-ready candidates show explicit accept and retry', () => {
  const markup = renderToStaticMarkup(<PosterCandidateReview {...fixture({ status: 'NEEDS_USER_REVIEW' })} />);
  assert.match(markup, />接受候选</);
  assert.match(markup, />重试此层</);
});
```

- [ ] **Step 2: Run tests and verify failure**

Run: `node --test src/poster-candidate-review.test.mjs src/poster-preview.test.mjs src/job-state.test.mjs`

Expected: FAIL.

- [ ] **Step 3: Implement source/candidate/overlay views**

Render source and candidate at the same fitted rectangle. Overlay uses the same DOM bounds and an opacity slider, not separately calculated crop boxes. The simulated transparency preview is explicitly labeled “预览”，never offered as a download.

```jsx
<div className="poster-compare__stack">
  <img src={sourceUrl} className="poster-compare__source" alt="原海报" />
  <img src={candidateUrl} style={{ opacity: overlayOpacity }} className="poster-compare__candidate" alt="候选图层" />
</div>
```

- [ ] **Step 4: Connect explicit generate/accept/retry actions**

Generate is enabled for `PENDING`, `GENERATION_AUTHORIZED`, or `RETRY_AUTHORIZED`. The first click from `PENDING` records `GENERATION_AUTHORIZED` and then submits that single authorization. Clicking retry calls `authorizePosterRetry` and stops; it must not automatically call `submitPosterCandidate`. A second user click on “生成候选” submits the authorized retry.

- [ ] **Step 5: Display hard-failure evidence and restore on reload**

Show standard failure codes plus localized explanations and stored review notes. Polling reads poster job status independently of UI jobs. A stale/cancelled late candidate remains diagnostic-only and never replaces the active candidate.

Run: `node --test src/poster-candidate-review.test.mjs src/poster-preview.test.mjs src/job-state.test.mjs src/workbench-layout.test.mjs`

Expected: PASS.

- [ ] **Step 6: Commit candidate review UI**

```bash
git add src/PosterCandidateReview.jsx src/poster-candidate-review.test.mjs src/poster-preview.js src/poster-preview.test.mjs src/main.jsx src/styles.css src/job-state.js src/job-state.test.mjs
git commit -m "feat: review poster layer candidates"
```

---

### Task 10: Recomposition Audit and Package Export

**Files:**
- Create: `src/poster-recomposition.js`
- Create: `src/poster-recomposition.test.mjs`
- Create: `scripts/audit-poster-recomposition.py`
- Create: `scripts/test_audit_poster_recomposition.py`
- Modify: `src/poster-job-store.js`
- Modify: `src/poster-workbench-host.js`
- Modify: `vite.config.js`
- Modify: `layer-review-mcp-server.mjs`
- Modify: `src/main.jsx`
- Modify: `src/styles.css`

**Interfaces:**
- Produces: `canRunPosterAudit(job): boolean`
- Produces: `buildPosterCompositeOrder(plan): number[]`
- Produces: `recordRecompositionAudit(job, report): PosterJobRecord`
- Produces routes: audit and archive download.

- [ ] **Step 1: Write failing readiness and z-order tests**

```js
test('audit requires every planned layer to be accepted', () => {
  assert.equal(canRunPosterAudit(jobFixture({ layerStatuses: ['ACCEPTED', 'NEEDS_USER_REVIEW'] })), false);
});

test('recomposition runs from the largest index down to one', () => {
  assert.deepEqual(buildPosterCompositeOrder(planFixture([1, 3, 2])), [3, 2, 1]);
});
```

- [ ] **Step 2: Run tests and verify failure**

Run: `node --test src/poster-recomposition.test.mjs`

Expected: FAIL.

- [ ] **Step 3: Implement deterministic compositing audit**

The Python audit loads every accepted full-canvas layer, validates identical dimensions and allowed key/compositing modes, composites from the largest index down, and writes an audit preview outside `layers/`. It reports missing layers, duplicate owned content metadata, invalid key fields, dimension mismatch, and manifest inconsistencies. Visual ownership failures supplied by the candidate review remain blocking.

```python
report = {
    'status': 'passed' if not failures else 'failed',
    'composite_order': sorted(layer_indices, reverse=True),
    'failure_codes': failures,
    'preview_path': str(preview_path),
}
```

- [ ] **Step 4: Add audit and export routes**

```text
POST /api/poster-layer/jobs/:jobId/audit
GET  /api/poster-layer/jobs/:jobId/export
```

Export returns `409` unless the latest audit matches the current plan/manifest revision and passed. The archive contains `source.png`, `poster-layer-plan.json`, `layer_manifest.json`, `layers/`, and `poster-execution-report.json`; it excludes raw candidates and preview caches.

- [ ] **Step 5: Add UI completion and failure behavior**

The poster shell enables “运行重组审计” only when all layers are accepted. Failed audit lists conflict layers and returns the user to their review controls without deleting accepted files. Passed audit enables “下载海报分层包”.

Run: `node --test src/poster-recomposition.test.mjs src/poster-workbench-host.test.mjs && python3 -m unittest scripts/test_audit_poster_recomposition.py`

Expected: PASS.

- [ ] **Step 6: Commit audit and export**

```bash
git add src/poster-recomposition.js src/poster-recomposition.test.mjs scripts/audit-poster-recomposition.py scripts/test_audit_poster_recomposition.py src/poster-job-store.js src/poster-workbench-host.js vite.config.js layer-review-mcp-server.mjs src/main.jsx src/styles.css
git commit -m "feat: audit and export poster layers"
```

---

### Task 11: Feature Flag, Documentation, and Full Regression

**Files:**
- Modify: `src/execution-features.js`
- Modify: `src/execution-features.test.mjs`
- Modify: `docs/guides/imvia-layer-workbench-user-guide.md`
- Modify: `README.md`
- Modify: `src/workbench-startup.test.mjs`
- Modify: `src/workbench-layout.test.mjs`
- Modify: `src/targeted-skill-contract.test.mjs`

**Interfaces:**
- Produces feature: `poster_layering_mode`, default enabled unless explicitly disabled.
- Verifies all prior task interfaces together.

- [ ] **Step 1: Write the failing feature-flag test**

```js
test('poster mode is enabled by default and can be disabled', () => {
  assert.equal(isExecutionFeatureEnabled('poster_layering_mode', {}), true);
  assert.equal(isExecutionFeatureEnabled('poster_layering_mode', {
    IMVIA_FEATURE_POSTER_LAYERING_MODE: '0',
  }), false);
});
```

- [ ] **Step 2: Implement the flag and hide only the poster entry when disabled**

UI mode, existing projects, and existing poster job files remain readable when the entry is disabled. The flag prevents new poster analysis submissions; it does not delete state.

- [ ] **Step 3: Document the complete user workflow**

Document explicit mode choice, plan review, one-candidate rule, failure codes, accept/retry distinction, green/black key output, recomposition audit, cancellation limitation, and package contents. State that transparent simulation is preview-only.

- [ ] **Step 4: Run every Node and Python test**

Run:

```bash
node --test src/*.test.mjs scripts/*.test.mjs
python3 -m unittest discover -s scripts -p 'test_*.py'
```

Expected: all tests pass with zero failures.

- [ ] **Step 5: Build the production client**

Run: `node node_modules/vite/bin/vite.js build --configLoader runner`

Expected: Vite exits 0 and writes the production bundle.

- [ ] **Step 6: Run the browser acceptance checklist**

Verify in a fresh workbench session:

1. Legacy project opens in UI mode and submits a normal UI split.
2. Poster upload produces a plan without an ImageGen candidate.
3. Plan errors block confirmation; valid plan confirmation unlocks one-layer generation.
4. One authorization creates exactly one candidate; no timer or reload creates another.
5. A title mutation receives `TEXT_OR_LOGO_MUTATED` and no accept button.
6. A review-ready candidate requires a user click before appearing in `layers/`.
7. Retry authorization does not generate until the next explicit click.
8. Refresh restores plan, candidate, failure codes, and accepted layers.
9. Audit failure blocks export; a matching passed audit enables the archive.
10. “放弃任务并释放队列” still accurately warns that it cannot stop the active Codex turn.

- [ ] **Step 7: Commit feature flag and documentation**

```bash
git add src/execution-features.js src/execution-features.test.mjs docs/guides/imvia-layer-workbench-user-guide.md README.md src/workbench-startup.test.mjs src/workbench-layout.test.mjs src/targeted-skill-contract.test.mjs
git commit -m "docs: ship poster layering workbench mode"
```

---

## Final Verification Gate

- [ ] Run `git status --short` and confirm only intentional changes remain.
- [ ] Run `node --test src/*.test.mjs scripts/*.test.mjs` and record test count with zero failures.
- [ ] Run `python3 -m unittest discover -s scripts -p 'test_*.py'` and record test count with zero failures.
- [ ] Run `node node_modules/vite/bin/vite.js build --configLoader runner` and record exit code 0.
- [ ] Confirm `lovart-poster-layering-v3-1` has no diff.
- [ ] Confirm no poster candidate enters `layers/` without an explicit acceptance event.
- [ ] Confirm no candidate generation happens from a retry authorization event alone.
- [ ] Confirm UI mode still serializes `version: "0.7"` and `task: "split_ui_design_layers_with_manual_regions"` unchanged.
