# 海报工作台定向快速模式 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a local, H5-shaped poster fast mode that lets users choose a category project, edit its bounds and prompt, generate exactly one targeted v3.1 candidate, and review the returned PNG without waiting for global Codex analysis.

**Architecture:** Keep the existing high-quality poster analysis route and UI intact. Add a `targeted_fast` plan origin, a per-layer immutable snapshot, a local suggestion/plan module, and a targeted poster adapter selected by `processing_category`. The fast UI is a dedicated poster workbench with a category-to-project sidebar, three center views (source / selection / PNG return), and a current-project inspector; the existing poster job store, foreground dispatch, candidate finalizer, acceptance and export safety remain the stateful back end.

**Tech Stack:** React 18, Vite middleware, Node.js test runner, existing poster plan/job-store modules, MCP app tools, installed Imvia Layer plugin template, immutable `lovart-poster-layering-v3-1` contract.

**Spec:** `docs/superpowers/specs/2026-08-21-poster-targeted-workbench-fast-mode-design.md`

## Global Constraints

- Preserve the immutable `lovart-poster-layering-v3-1` Skill, `layer-rules.md`, `prompt-templates.md`, and manifest template; add a sibling adapter only.
- Fast mode is `planning_mode: "targeted_fast"`, uses no global poster-analysis dispatch, and never starts a hidden background task.
- Every generated candidate uses the full source canvas and original coordinates; opaque layers use `#00FF00`, Screen/Add effects use `#000000`.
- Each targeted dispatch handles exactly one `layer_index`, one candidate number, one authorization, and one category block; no automatic retry or acceptance.
- A failed PNG remains in `candidates/` and the PNG return view shows the concrete Chinese failure facts; `IMAGEGEN_NO_PNG` is reserved for an actually missing/unusable PNG.
- The root fast plan may remain `PLAN_REVIEW`; a confirmed per-layer snapshot is the only fast candidate-generation input. High-quality plans retain the existing `PLAN_CONFIRMED` contract.
- Keep all user-facing labels, prompts, statuses and failure explanations in Simplified Chinese; retain English enum/failure codes only in technical details.
- Do not modify Bridge/shared protocol, Photoshop import/capture/success-reset code, or other RC protected runtime.
- Do not create `candidates/` or `layers/` from the UI; only the existing candidate finalizer and acceptance route may do so.

## File Map Before Coding

- Create `src/poster-fast-plan.js` and `src/poster-fast-plan.test.mjs`: local category suggestions, v3.1 field normalization, layer snapshots and fast-mode metadata.
- Create `src/poster-fast-workbench-model.js` and `src/poster-fast-workbench-model.test.mjs`: pure category/project grouping, selected-project state and three-panel view state.
- Create `src/PosterFastWorkbench.jsx`: H5-shaped fast poster UI with source, selection and PNG return views plus the right inspector.
- Create `src/PosterFastCandidateResult.jsx` and `src/poster-fast-candidate-result.test.mjs`: compact PNG return state and Chinese failure facts without changing the high-quality review page.
- Create `plugin-template/imvia-layer/skills/imvia-poster-layering-workbench-targeted-v1/SKILL.md` and `agents/openai.yaml`: targeted adapter contract and category router.
- Create `plugin-template/imvia-layer/skills/imvia-poster-layering-workbench-targeted-v1/references/category-blocks.md`: six category-specific prompt blocks.
- Modify `src/poster-plan.js` and `src/poster-plan.test.mjs`: validate `planning_mode`, `planning_origin`, `processing_category`, and targeted adapter metadata while keeping legacy high-quality fixtures valid.
- Modify `src/poster-prompt.js` and `src/poster-prompt.test.mjs`: build the targeted Chinese candidate prompt and preserve the current analysis/candidate prompt builders.
- Modify `src/poster-workbench-host.js` and `src/poster-workbench-host.test.mjs`: create fast jobs and submit a snapshot-bound targeted candidate.
- Modify `src/poster-job-store.js`, `src/poster-job-store.test.mjs`, `scripts/prepare-poster-job.mjs`, and related finalizer tests: snapshot authorization, fast preflight, candidate retention and exact failure terminal states.
- Modify `vite.config.js` and its route tests: local fast-job creation, targeted candidate payload routing and targeted adapter prompt selection.
- Modify `layer-review-mcp-server.mjs`: extend the existing candidate app tool with optional targeted snapshot/category fields; do not add a second hidden dispatch tool.
- Modify `scripts/install-codex-plugin.mjs` and `scripts/install-codex-plugin.test.mjs`: stage and verify the sibling targeted adapter.
- Modify `src/main.jsx`, `src/PosterModePicker.jsx`, and `src/styles.css`: default poster upload to fast planning, select high-quality explicitly, render the fast workbench, and keep the current high-quality route intact.

### Task 1: Add the Fast Poster Plan and Layer Snapshot Contract

**Files:**
- Create: `src/poster-fast-plan.js`
- Create: `src/poster-fast-plan.test.mjs`
- Modify: `src/poster-plan.js`
- Test: `src/poster-plan.test.mjs`

**Interfaces:**
- `suggestPosterFastLayers({ data, width, height })` returns deterministic project drafts with `{ layer_index, layer_name, processing_category, bounds, planning_confidence, user_confirmed: false }`.
- `createFastPosterPlan({ job_id, project_id, image_id, source, output_directory, layers })` returns a v3.1-compatible plan with `planning_mode: 'targeted_fast'`, `planning_origin: 'workbench_local_suggestion'`, `display_language: 'zh-CN'`, and targeted adapter metadata.
- `buildFastLayerSnapshot(plan, layerIndex, patch, confirmedAt)` returns `{ snapshot, plan }`; `snapshot` contains only the selected layer, source metadata, current `plan_version`, a deterministic `snapshot_id`, `user_confirmed: true`, and every v3.1 layer field.
- `fastLayerState(layer)` maps `SUGGESTED`, `USER_CONFIRMED`, `GENERATION_AUTHORIZED`, `GENERATING`, `CANDIDATE_CREATED`, `HARD_REJECTED`, `NEEDS_USER_REVIEW`, and `ACCEPTED` to Chinese labels.

- [ ] **Step 1: Write failing plan and suggestion tests**

```js
test('fast suggestions group concrete projects under six Chinese categories', () => {
  const layers = suggestPosterFastLayers({ data: fixturePixels, width: 120, height: 240 });
  assert.deepEqual([...new Set(layers.map((layer) => layer.processing_category))], [
    'subject', 'text', 'brand_ui', 'decoration_prop', 'effect', 'background',
  ]);
  assert.ok(layers.every((layer) => layer.user_confirmed === false));
});

test('snapshot confirms only the selected layer and preserves the full-canvas source', () => {
  const plan = createFastPosterPlan(fixturePlanInput());
  const { snapshot } = buildFastLayerSnapshot(plan, 2, { prompt: '只保留日期' }, '2026-08-21T00:00:00.000Z');
  assert.equal(snapshot.layer.layer_index, 2);
  assert.equal(snapshot.source.width, plan.source.width);
  assert.equal(snapshot.user_confirmed, true);
  assert.equal(snapshot.skill_contract.base, 'lovart-poster-layering-v3-1');
});
```

- [ ] **Step 2: Run the focused tests and verify they fail**

Run: `node --test src/poster-fast-plan.test.mjs`

Expected: FAIL because the fast plan module and snapshot functions do not exist.

- [ ] **Step 3: Implement the pure fast-plan functions**

Use the existing `analyzeFastCategories()` output as the local region hint, map its UI categories to the six poster `processing_category` values, and fill all required v3.1 arrays with explicit empty arrays or user-derived evidence. Never mark unobserved evidence as Codex evidence. Normalize bounds to both percentage and source-pixel coordinates, clamp to the source canvas, and compute `snapshot_id` from the canonical JSON of `{ job_id, plan_version, layer_index, layer, source }`.

- [ ] **Step 4: Extend poster-plan validation without breaking high-quality plans**

Add allowed `PLANNING_MODES`, `PLANNING_ORIGINS`, `PROCESSING_CATEGORIES`, and the targeted adapter value. Validate fast-only fields when `planning_mode === 'targeted_fast'`; preserve the existing adapter and required-field behavior for legacy/high-quality fixtures. Add a validation error when a fast layer is missing `processing_category`, `planning_confidence`, or a user confirmation/snapshot before targeted generation.

- [ ] **Step 5: Run both focused and legacy plan tests**

Run: `node --test src/poster-fast-plan.test.mjs src/poster-plan.test.mjs`

Expected: PASS with all existing v3.1 plan tests unchanged and new fast metadata/snapshot tests green.

- [ ] **Step 6: Commit the contract**

```bash
git add src/poster-fast-plan.js src/poster-fast-plan.test.mjs src/poster-plan.js src/poster-plan.test.mjs
git commit -m "feat: add targeted poster fast plan contract"
```

### Task 2: Add the Local Fast Job and Snapshot-Bound Candidate Route

**Files:**
- Modify: `src/poster-workbench-host.js`
- Modify: `src/poster-workbench-host.test.mjs`
- Modify: `src/poster-job-store.js`
- Modify: `src/poster-job-store.test.mjs`
- Modify: `vite.config.js`
- Create or modify: `vite-poster-fast-route.test.mjs` (use the repository's existing Vite route-test pattern)

**Interfaces:**
- `submitPosterFastJob(plan, fetchImpl, dependencies)` POSTs `/api/poster-layer/jobs/fast` and never calls `submit_poster_layer_analysis`.
- `submitPosterTargetedCandidate(jobId, layerIndex, { snapshot, authorizationId, expectedManifestRevision, planVersion }, fetchImpl, dependencies)` sends the existing foreground candidate tool/route with `planningMode: 'targeted_fast'` and the immutable snapshot.
- `initializePosterFastJob({ outputRoot, jobId, sourcePath, plan })` creates the standard poster job package with `PLAN_REVIEW`, no analysis dispatch, and the source/evidence/candidate/layer directories.
- The fast candidate route verifies the snapshot hash, layer index, plan version, authorization id, source fingerprint, and current manifest revision before enqueueing the visible dispatch.

- [ ] **Step 1: Write host/store/route contract tests**

```js
test('fast plan creation is local and does not call the analysis tool', async () => {
  const calls = [];
  await posterHost.submitPosterFastJob({ job_id: 'poster-fast-1' }, undefined, {
    isMcpHost: () => true,
    callTool: async (...args) => calls.push(args),
  });
  assert.equal(calls.length, 0);
});

test('targeted candidate payload binds one snapshot to one layer', async () => {
  const requests = [];
  await posterHost.submitPosterTargetedCandidate('poster-fast-1', 3, {
    snapshot: { snapshot_id: 'snap-3', layer_index: 3 },
    authorizationId: 'poster-fast-1:1:3:1', expectedManifestRevision: 2, planVersion: 1,
  }, async (url, options) => { requests.push({ url, options }); return { ok: true, json: async () => ({}) }; });
  const body = JSON.parse(requests[0].options.body);
  assert.equal(body.planning_mode, 'targeted_fast');
  assert.equal(body.layer_snapshot.layer_index, 3);
});
```

- [ ] **Step 2: Run focused tests and verify failure**

Run: `node --test src/poster-workbench-host.test.mjs src/poster-job-store.test.mjs vite-poster-fast-route.test.mjs`

Expected: FAIL because the fast endpoint, host functions and snapshot authorization are not implemented.

- [ ] **Step 3: Implement local fast-job creation**

Add the `/api/poster-layer/jobs/fast` POST branch before the existing `/analyze` branch. It must validate the feature flag, source dimensions and `createFastPosterPlan()` output, call `initializePosterFastJob()`, and return the same `posterResponse()` shape with no dispatch id. Reject a fast payload that contains an analysis dispatch request or a non-poster document mode.

- [ ] **Step 4: Implement snapshot-bound targeted candidate submission**

Extend the existing candidate request body with `planning_mode`, `layer_snapshot`, `snapshot_id`, and `authorization_id`. For `targeted_fast`, verify the selected snapshot against the current plan and manifest, bind the foreground dispatch to that snapshot, and permit root `PLAN_REVIEW` only when the snapshot is `user_confirmed: true`. Keep the legacy/high-quality branch requiring root `PLAN_CONFIRMED` and the existing authorization state.

- [ ] **Step 5: Add stale-response and cross-layer protections**

Persist `snapshot_id` and `layer_index` on the authorization and dispatch journal. Reconcile a late dispatch only when all of `dispatch_id`, `snapshot_id`, `layer_index`, `candidate_number`, `authorization_id`, and `plan_version` match. A delayed result for another layer must never replace the selected project's state.

- [ ] **Step 6: Run route/store tests and commit**

Run: `node --test src/poster-workbench-host.test.mjs src/poster-job-store.test.mjs vite-poster-fast-route.test.mjs`

Expected: PASS, including legacy high-quality candidate route tests.

```bash
git add src/poster-workbench-host.js src/poster-workbench-host.test.mjs src/poster-job-store.js src/poster-job-store.test.mjs vite.config.js vite-poster-fast-route.test.mjs
git commit -m "feat: route targeted poster candidates from fast plans"
```

### Task 3: Add the Targeted Poster Adapter and Chinese Category Blocks

**Files:**
- Create: `plugin-template/imvia-layer/skills/imvia-poster-layering-workbench-targeted-v1/SKILL.md`
- Create: `plugin-template/imvia-layer/skills/imvia-poster-layering-workbench-targeted-v1/agents/openai.yaml`
- Create: `plugin-template/imvia-layer/skills/imvia-poster-layering-workbench-targeted-v1/references/category-blocks.md`
- Modify: `src/poster-prompt.js`
- Modify: `src/poster-prompt.test.mjs`
- Modify: `vite.config.js`
- Modify: `scripts/install-codex-plugin.mjs`
- Modify: `scripts/install-codex-plugin.test.mjs`

**Interfaces:**
- `buildPosterTargetedCandidatePrompt({ jobId, planPath, snapshotPath, sourcePath, layerIndex, candidateNumber, processingCategory })` returns the visible Chinese task prompt and names the targeted adapter.
- `posterPrompt(prepared)` selects the targeted adapter only when the prepared plan has `planning_mode: 'targeted_fast'`; all analysis/high-quality candidate prompts continue to select `imvia-poster-layering-workbench-v1`.
- The new adapter reads the immutable v3.1 base references, validates the snapshot and dispatch envelope, uses the base block plus exactly one category block, calls ImageGen once, retains raw candidate/report, and stops after finalization.

- [ ] **Step 1: Write prompt and installer contract tests**

```js
test('targeted prompt names one category and forbids global analysis', () => {
  const prompt = buildPosterTargetedCandidatePrompt({
    jobId: 'poster-fast-1', planPath: '/job/plan.json', snapshotPath: '/job/snap.json',
    sourcePath: '/job/source.png', layerIndex: 2, candidateNumber: 1,
    processingCategory: 'text',
  });
  assert.match(prompt, /imvia-poster-layering-workbench-targeted-v1/);
  assert.match(prompt, /只处理 layer_index=2/);
  assert.match(prompt, /不得.*整张海报.*分析/);
  assert.match(prompt, /只允许一次 ImageGen/);
});

test('installer verifies both poster adapters and the six category blocks', async () => {
  const targeted = await readFile(path.join(pluginRoot, 'skills', 'imvia-poster-layering-workbench-targeted-v1', 'SKILL.md'), 'utf8');
  assert.match(targeted, /lovart-poster-layering-v3-1/);
  assert.match(targeted, /恰好一个类别/);
  assert.match(await readCategoryBlocks(), /subject[\s\S]*text[\s\S]*brand_ui[\s\S]*effect/);
});
```

- [ ] **Step 2: Run focused tests and verify failure**

Run: `node --test src/poster-prompt.test.mjs scripts/install-codex-plugin.test.mjs`

Expected: FAIL because the targeted prompt, adapter directory and installer checks do not exist.

- [ ] **Step 3: Write the sibling adapter**

The adapter must explicitly read `../lovart-poster-layering-v3-1/SKILL.md`, `references/layer-rules.md`, and `references/prompt-templates.md`; require the full source canvas; reject missing/foreign snapshots; pass every dispatch envelope field to finalization; and prohibit acceptance, `layers/` writes, retries and global analysis. Keep all user-facing prose Chinese while preserving machine failure codes.

- [ ] **Step 4: Write the category blocks**

Add exactly six blocks named `subject`, `text`, `brand_ui`, `decoration_prop`, `effect`, and `background`. Each block must state its keep/remove rules, allowed repair envelope, locked-anchor emphasis, expected key color, and category-specific hard-failure checks. Do not copy or modify v3.1 rules; reference them.

- [ ] **Step 5: Route targeted prompts and stage the adapter**

Add the prompt builder, route selection and installer verification. The installer must copy the new sibling skill and references into the portable plugin and continue to verify the existing adapter unchanged.

- [ ] **Step 6: Run prompt/installer tests and commit**

Run: `node --test src/poster-prompt.test.mjs scripts/install-codex-plugin.test.mjs`

Expected: PASS with both adapters installed and no change to the immutable base skill.

```bash
git add plugin-template/imvia-layer/skills/imvia-poster-layering-workbench-targeted-v1 src/poster-prompt.js src/poster-prompt.test.mjs vite.config.js scripts/install-codex-plugin.mjs scripts/install-codex-plugin.test.mjs
git commit -m "feat: add targeted poster category adapter"
```

### Task 4: Implement Fast Plan Preflight and Candidate Retention

**Files:**
- Modify: `scripts/prepare-poster-job.mjs`
- Modify: `scripts/prepare-poster-job.test.mjs`
- Modify: `scripts/finalize-poster-candidate.mjs`
- Modify: `scripts/finalize-poster-candidate.test.mjs`
- Modify: `scripts/finalize-poster-generation-failure.mjs`
- Modify: `scripts/finalize-poster-generation-failure.test.mjs`
- Modify: `src/poster-job-store.js`
- Modify: `src/poster-job-store.test.mjs`

**Interfaces:**
- `preparePosterJob({ phase: 'candidate', planningMode: 'targeted_fast', snapshotPath, ... })` returns a candidate spec bound to the snapshot and targeted adapter.
- `finalizePosterCandidate()` stores the raw PNG and release-gate report for both high-quality and fast jobs without writing `layers/`.
- `finalizePosterGenerationFailure()` writes a failure report only for no usable PNG/review; it must not relabel an existing rejected PNG as `IMAGEGEN_NO_PNG`.

- [ ] **Step 1: Add failing fast-preflight and retention tests**

Cover: root `PLAN_REVIEW` plus confirmed snapshot succeeds; missing snapshot fails; snapshot layer mismatch fails; wrong category block fails; existing PNG with `CANVAS_OR_GREEN_FIELD_INVALID` stays in `candidates/`; missing PNG yields `IMAGEGEN_NO_PNG`; candidate finalizer never creates `layers/`.

- [ ] **Step 2: Run focused finalizer tests and verify failure**

Run: `node --test scripts/prepare-poster-job.test.mjs scripts/finalize-poster-candidate.test.mjs scripts/finalize-poster-generation-failure.test.mjs`

Expected: FAIL on the new targeted snapshot and failure-retention assertions.

- [ ] **Step 3: Implement targeted preflight**

Load and validate the canonical plan, read the supplied snapshot, compare its SHA-256/snapshot id and source dimensions, verify one layer/category, and create the deterministic candidate destination. Keep the existing high-quality `PLAN_CONFIRMED` path unchanged.

- [ ] **Step 4: Implement truthful failure retention**

When a PNG exists but the release gate fails, record its path, dimensions, key findings and failure codes in the candidate and manifest. Use `IMAGEGEN_NO_PNG` only when the ImageGen output or review report is genuinely unavailable. Preserve atomic writes and existing directory locks.

- [ ] **Step 5: Run focused plus all poster tests and commit**

Run: `node --test scripts/prepare-poster-job.test.mjs scripts/finalize-poster-candidate.test.mjs scripts/finalize-poster-generation-failure.test.mjs src/poster-job-store.test.mjs`

Expected: PASS with all existing candidate acceptance/recomposition tests green.

```bash
git add scripts/prepare-poster-job.mjs scripts/prepare-poster-job.test.mjs scripts/finalize-poster-candidate.mjs scripts/finalize-poster-candidate.test.mjs scripts/finalize-poster-generation-failure.mjs scripts/finalize-poster-generation-failure.test.mjs src/poster-job-store.js src/poster-job-store.test.mjs
git commit -m "fix: retain truthful targeted poster candidate failures"
```

### Task 5: Build the H5-Shaped Fast Poster Workbench UI

**Files:**
- Create: `src/poster-fast-workbench-model.js`
- Create: `src/poster-fast-workbench-model.test.mjs`
- Create: `src/PosterFastWorkbench.jsx`
- Create: `src/PosterFastCandidateResult.jsx`
- Create: `src/poster-fast-candidate-result.test.mjs`
- Modify: `src/main.jsx`
- Modify: `src/styles.css`

**Interfaces:**
- `groupPosterFastLayers(layers)` returns ordered `{ category, label, items }` groups; each item remains a concrete project.
- `posterFastWorkbenchState({ plan, selectedLayerIndex, busy, sourceUrl, candidate })` returns the three view models and current inspector values without mutating the plan.
- `<PosterFastWorkbench sourceUrl sourceSize plan selectedLayerIndex onSelectLayer onAddLayer onUpdateLayer onOpenPen onSplit onAccept onRetry busy />` renders the left category/project list, center source/selection/PNG views and right inspector.
- `<PosterFastCandidateResult candidate layer onAccept onRetry busy />` renders empty, pending, accepted, review-ready and rejected states with Chinese facts and technical code details.

- [ ] **Step 1: Write pure UI model tests**

```js
test('grouping keeps category headers above concrete projects', () => {
  const groups = groupPosterFastLayers([{ processing_category: 'subject', layer_name: '花束' }]);
  assert.deepEqual(groups[0].items.map((item) => item.layer_name), ['花束']);
  assert.equal(groups[0].label, '主体');
});

test('PNG return state never labels a candidate as a formal layer', () => {
  const model = posterFastWorkbenchState({ plan: fastPlan, selectedLayerIndex: 1, candidate: { status: 'NEEDS_USER_REVIEW' } });
  assert.equal(model.pngReturn.formalLayer, false);
  assert.equal(model.pngReturn.label, '候选，未写入正式图层');
});
```

- [ ] **Step 2: Run model tests and verify failure**

Run: `node --test src/poster-fast-workbench-model.test.mjs src/poster-fast-candidate-result.test.mjs`

Expected: FAIL because the fast workbench model and result component do not exist.

- [ ] **Step 3: Implement the model and result state**

Use the existing poster candidate state/release-gate models and status maps. Keep `candidateUrl` and `failureCodes` separate from the source URL; format concrete dimensions/key/registration facts in Chinese and expose the raw code only as a technical detail.

- [ ] **Step 4: Implement the React workbench**

Render exactly three center panels: `原图展示` (read-only), `框选操作区` (drag/resize/reset and pen overlay), and `PNG 回传展示区` (empty/candidate/failure). Render the left hierarchy as category heading followed by concrete project cards. Render the right inspector with only 名称, 提示词, 去背景, 钢笔 and 拆分当前项目 controls. Do not render the old bottom three-step cards or the high-quality four-panel reviewer in this component.

- [ ] **Step 5: Wire existing canvas and pen behavior**

Pass the existing source canvas coordinate conversion and pen-path callbacks from `main.jsx`; do not create a second pixel editor. On bounds/prompt/category changes, invalidate the current layer snapshot and unaccepted candidate. On a delayed result, update the project identified by `layer_index` rather than the currently selected project.

- [ ] **Step 6: Add scoped CSS and run UI contract tests**

Add a `poster-fast-workbench__` namespace to `src/styles.css`. Verify desktop three-column layout, narrow-screen vertical stacking, keyboard labels, selected project focus, empty PNG state, and no `poster-completion`/bottom-step markup in the fast component.

Run: `node --test src/poster-fast-workbench-model.test.mjs src/poster-fast-candidate-result.test.mjs src/poster-candidate-review.test.mjs`

Expected: PASS without changing the existing high-quality candidate review tests.

- [ ] **Step 7: Commit the UI component**

```bash
git add src/poster-fast-workbench-model.js src/poster-fast-workbench-model.test.mjs src/PosterFastWorkbench.jsx src/PosterFastCandidateResult.jsx src/poster-fast-candidate-result.test.mjs src/main.jsx src/styles.css
git commit -m "feat: add H5-shaped poster fast workbench"
```

### Task 6: Make Fast Planning the Poster Default and Preserve High-Quality Entry

**Files:**
- Modify: `src/main.jsx`
- Modify: `src/PosterModePicker.jsx`
- Modify: `src/poster-workbench-state.js`
- Modify: `src/poster-workbench-state.test.mjs`
- Modify: `src/poster-mode-picker.test.mjs`
- Modify: `src/poster-job-ui-state.test.mjs`

**Interfaces:**
- `posterPlanningMode` is `targeted_fast` by default and `quality_global` only when the user explicitly chooses “高质量分析”.
- `startPosterFastPlanning()` materializes/upload the source, calls `submitPosterFastJob()` once, stores the local plan, and never calls `startPosterAnalysis()`.
- `posterWorkbenchView()` returns `{ kind: 'fast' }` for a targeted-fast plan, while preserving `{ kind: 'review' }`, `{ kind: 'confirmed' }`, `{ kind: 'failed' }`, `{ kind: 'queued' }` for high-quality jobs.

- [ ] **Step 1: Add failing entry/state tests**

Assert that a poster upload defaults to `targeted_fast`, a fast plan invokes no `submit_poster_layer_analysis`, a high-quality selection still invokes the existing analysis path, and a fast job does not render `PosterPlanReview`/`poster-completion`.

- [ ] **Step 2: Run focused tests and verify failure**

Run: `node --test src/poster-mode-picker.test.mjs src/poster-workbench-state.test.mjs src/poster-job-ui-state.test.mjs`

Expected: FAIL on the new fast mode/state assertions.

- [ ] **Step 3: Implement mode selection and local planning**

Add a poster-only planning mode choice to the existing upload picker. On poster upload, run `analyzeFastCategories` locally, create the fast plan, and call `/api/poster-layer/jobs/fast`. Keep `startPosterAnalysis()` reachable from the explicit high-quality choice and preserve its existing visible Codex queue/loading states.

- [ ] **Step 4: Render the fast workbench branch**

In the poster branch of `main.jsx`, render `PosterFastWorkbench` for targeted-fast jobs, the existing `PosterPlanReview`/`PosterCandidateReview` route for quality-global jobs, and the existing failed/queued states for quality-global jobs. Add callbacks that patch the fast layer locally, persist through the plan route, snapshot/authorize the selected layer, submit the targeted candidate and refresh only that layer.

- [ ] **Step 5: Run focused tests and commit**

Run: `node --test src/poster-mode-picker.test.mjs src/poster-workbench-state.test.mjs src/poster-job-ui-state.test.mjs src/poster-fast-plan.test.mjs`

Expected: PASS; high-quality route tests remain unchanged.

```bash
git add src/main.jsx src/PosterModePicker.jsx src/poster-workbench-state.js src/poster-workbench-state.test.mjs src/poster-mode-picker.test.mjs src/poster-job-ui-state.test.mjs
git commit -m "feat: default posters to local targeted planning"
```

### Task 7: Wire MCP Payloads, Chinese Failure Display and Candidate Review Regression

**Files:**
- Modify: `layer-review-mcp-server.mjs`
- Modify: `src/poster-candidate-review-model.js`
- Modify: `src/PosterCandidateReview.jsx`
- Modify: `src/poster-candidate-review.test.mjs`
- Modify: `src/poster-workbench-host.test.mjs`

**Interfaces:**
- Existing `submit_poster_layer_candidate` accepts optional `planningMode`, `layerSnapshot`, `snapshotId`, `authorizationId`, and `processingCategory`; high-quality callers remain valid without them.
- `failureExplanation(code, facts)` returns a Chinese message and an optional technical-code label for `GENERATION_FAILED`, `IMAGEGEN_NO_PNG`, `CANVAS_OR_GREEN_FIELD_INVALID`, `KEY_UNUSABLE`, `REGISTRATION_UNCERTAIN`, and all existing v3.1 codes.

- [ ] **Step 1: Add failing MCP and failure-display tests**

Test exact optional payload forwarding, no global-analysis tool call for fast candidate submission, and concrete facts such as `852 × 1846` versus `1848 × 4000` appearing in the PNG result/review model.

- [ ] **Step 2: Run focused tests and verify failure**

Run: `node --test src/poster-candidate-review.test.mjs src/poster-workbench-host.test.mjs`

Expected: FAIL for optional targeted payloads and missing Chinese explanations.

- [ ] **Step 3: Implement optional payload forwarding and translations**

Keep the existing app tool name and annotations. Add optional Zod fields, forward them unchanged to the Vite route, and add Chinese status/failure mappings without changing machine codes or high-quality acceptance rules.

- [ ] **Step 4: Run focused tests and commit**

Run: `node --test src/poster-candidate-review.test.mjs src/poster-workbench-host.test.mjs`

Expected: PASS with legacy review behavior preserved.

```bash
git add layer-review-mcp-server.mjs src/poster-candidate-review-model.js src/PosterCandidateReview.jsx src/poster-candidate-review.test.mjs src/poster-workbench-host.test.mjs
git commit -m "fix: show truthful Chinese poster candidate failures"
```

### Task 8: Full Verification, Installer Smoke Test and Documentation Handoff

**Files:**
- Modify: `README.md` or `docs/guides/imvia-layer-workbench-user-guide.md` only if the fast mode needs user-facing setup documentation.
- Modify: `docs/codex/index.md` and `docs/codex/doc-map.md` only if the new spec/plan must be indexed by the repository convention.
- Test: existing poster, targeted, workbench and installer test files.

- [ ] **Step 1: Run all source tests**

Run: `npm test`

Expected: PASS. If a failure touches an unrelated dirty change, record the exact test and file in the handoff; do not reset or overwrite the unrelated work.

- [ ] **Step 2: Build the workbench**

Run: `npm run build`

Expected: Vite build completes with the fast poster component and targeted adapter assets present.

- [ ] **Step 3: Run targeted poster and installer checks**

Run: `node --test src/poster-*.test.mjs src/targeted-*.test.mjs scripts/*poster*.test.mjs scripts/install-codex-plugin.test.mjs`

Expected: PASS, including high-quality plan/candidate/recomposition tests and targeted fast snapshot/failure-retention tests.

- [ ] **Step 4: Run the portable installer smoke test**

Run: `node --test scripts/install-codex-plugin.test.mjs`

Expected: the installed plugin contains both `imvia-poster-layering-workbench-v1` and `imvia-poster-layering-workbench-targeted-v1`, the runtime is self-contained, and the immutable base files are unchanged.

- [ ] **Step 5: Perform the manual acceptance matrix**

Use one real poster and verify:

1. Upload defaults to fast mode with no Codex analysis dispatch.
2. Left category headings contain concrete projects; selecting a project updates all three center views and the right inspector.
3. Bounds and optional pen edits update only the selected project.
4. Clicking 拆分当前项目 sends exactly one visible targeted task with one category block.
5. PNG returns to the selected project's third center panel; a delayed result cannot overwrite another project.
6. A rejected PNG remains visible with concrete Chinese facts and does not appear in `layers/`.
7. Acceptance is the only route that writes a formal layer.
8. Explicit 高质量分析 still opens the existing global route and remains unchanged.

- [ ] **Step 6: Review protected-file diff and commit verification notes**

Run: `git diff --name-only HEAD~8..HEAD` and confirm no Bridge/shared protocol, Photoshop import, capture or success/reset protected file was touched. Record the test/build commands and any unrelated dirty-worktree caveats in the final handoff.

## Self-Review Checklist

- [ ] Every spec section maps to at least one task: fast default/local plan (Tasks 1, 6), H5 UI (Task 5), targeted adapter/category blocks (Task 3), v3.1 snapshot/coordinates/key colors (Tasks 1, 4), candidate retention and truthful failures (Tasks 4, 7), high-quality boundary (Task 6), tests/installer (Task 8).
- [ ] No task changes the immutable v3.1 base Skill or protected RC runtime.
- [ ] The fast root `PLAN_REVIEW` exception is limited to the new layer snapshot route; high-quality candidate generation still requires root `PLAN_CONFIRMED`.
- [ ] Type/signature names match across the plan: `submitPosterFastJob`, `submitPosterTargetedCandidate`, `createFastPosterPlan`, `buildFastLayerSnapshot`, `PosterFastWorkbench`, and `PosterFastCandidateResult`.
- [ ] No step relies on automatic retry, automatic acceptance, hidden background work, or a made-up PNG.
- [ ] All test commands use the repository's Node test runner and existing `npm test`/`npm run build` scripts.
