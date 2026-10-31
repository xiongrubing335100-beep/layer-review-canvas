# Task 5 fast workbench — base preservation audit

## Ruling

The Task 5 checkout had an **untracked baseline** for `src/main.jsx` and
`src/styles.css`.  The requested initial commit therefore added those files in
full.  We cannot reconstruct a narrow historical diff from Git without
replacing or deleting the user's existing working files, which is not safe or
authorized.

## Auditable scope

The Task 5 implementation commits are:

- `3eb88db feat: add H5-shaped poster fast workbench`
- `73c1c96 fix: preserve fast poster canvas coordinates`

The repository-local check `src/poster-fast-base-preservation-audit.test.mjs`
audits `3eb88db^..73c1c96` with `git diff --name-only`. It rejects changes to
Bridge, shared collaboration artifacts, Photoshop runtime, the immutable `poster-layer-manifest-v3.1.json`,
and the `lovart-poster-layering-v3-1` base contract. The Task 5 fast additions
only live in the workbench UI/model/test paths and `main.jsx` wiring; they do
not import or modify protected runtime/base modules.

## Follow-up rule

Future changes must be reviewed as incremental diffs after `3eb88db` rather
than interpreting its full-file additions as evidence that high-quality UI or
protected runtime code was intentionally rewritten.

## Retained-boundary snapshot (2026-08-22)

This snapshot is **incremental evidence only**. It does not prove whole-file preservation
before `3eb88db`, because the original untracked baseline cannot
be recovered without replacing user files.

- `src/main.jsx SHA-256: 4c54b53cd3055c42bc3a58f51dcb88bde29d0663e390afedcd276c43fea44b18`
- `src/styles.css SHA-256: 8733ebcff92ac7770fe360f5de36260e2988d51524680e63ba4ba1c558337d2b`

The audit test verifies these current snapshots contain the retained
high-quality markers (`PosterPlanReview`, `PosterCandidateReview`,
`poster-candidate-workbench`, `poster-completion`, and their CSS selectors)
alongside fast wiring (`PosterFastWorkbench`,
`posterFastCandidatePreviewPath`, and `poster-fast-workbench__`). It also
scans both files for protected Bridge/Photoshop/v3.1 path markers and checks
the incremental diff range after `3eb88db` for protected-path changes.
