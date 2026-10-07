# Tasks: Honest CI Fallback

**Input**: Design documents from `/specs/002-honest-ci-fallback/`

**Prerequisites**: plan.md, spec.md, and `001`'s data-model.md (entities unchanged)

**Status**: Draft — awaiting owner review of `spec.md` + `plan.md` before implementation runs
(constitution §Development Workflow: the spec and plan are human checkpoints).

**TDD order is load-bearing** (constitution §VI, NON-NEGOTIABLE): each assertion lands **before** the
code that satisfies it, and each is demonstrated to **fail against the defect it guards**.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: can run in parallel (different files, no dependency)
- **[Story]**: US1..US2 from spec.md

## Phase 1: Artefact correction — `001` must stop describing behaviour that is being removed

These land **first**, because a spec that contradicts the code is the drift this project forbids
(constitution §Documented Surface, §Governance).

- [ ] C001 [US1] `001/spec.md` **FR-013** — replace "fall back to the most urgent repository and disclose
      it" with the abstention requirement; record the reason inline so the fallback is not reinstated
- [ ] C002 [US1] `001/spec.md` **US1 acceptance scenario 3** — replace with the abstention scenario
- [ ] C003 [US1] `001/spec.md` **Assumptions** — remove the `"Most urgent" ordering` bullet (the ordering
      no longer exists in code)
- [ ] C004 [P] `001/tasks.md` **T023** — amend (not delete) to record: specified → implemented → removed
      as harmful when a false answer was observed in use. `tasks.md` already documents the three
      historical defect cycles; this is the fourth and belongs in the same record.
- [ ] C005 [P] `001/checklists/requirements.md` — note that FR-013 was superseded by `002`, with the why

## Phase 2: RED — assertions that must fail before any implementation

- [ ] T001 [US1] Harness: a no-workspace chip must name **no** repository from the sweep. Fixture: the
      existing multi-repo `SWEEP`. Assert over the rendered tree that none of its repo names appear.
- [ ] T002 [US1] Harness: the abstaining chip must still identify itself and still be clickable —
      asserts against the chip rendering `null` (a vanish) as well as against a blank label
- [ ] T003 [P] [US1] Harness: **positive control** — a matching workspace still resolves its repository,
      so the abstention cannot over-reach into the working case
- [ ] T004 [P] [US1] Harness: rendering the abstaining chip must not navigate; navigation happens only
      on click (guards against a link that fires on render)

**Checkpoint**: run the suite. T001 and T002 MUST fail against the current code (which falls back and
which would have to be reworked to vanish). Record the failure output in the PR. If either passes, the
assertion is not testing the defect.

## Phase 3: GREEN — the implementation

- [ ] T005 [US1] `plugin.js` — **delete** `mostUrgent` and its rank table outright (FR-007). Not left
      unused: an unused helper is how this defect returns as an obvious improvement.
- [ ] T006 [US1] `plugin.js` — `CiChip` resolves `repo = repoForCwd(repos, cwd)` only; remove the
      `focused || fallback` selection and the now-unused `useMemo`/`fallback` binding
- [ ] T007 [US1] `plugin.js` — abstention state: muted `StatusDot` + `CI`, tooltip explaining there is no
      repository under this view (distinct from the collector-error state), `button` → CI page
- [ ] T008 [US1] `plugin.js` — remove the tooltip's "showing the most urgent one" line; the matched-state
      tooltip keeps repo · branch · RAG verdict · PR · sha-drift note
- [ ] T009 [P] [US1] `plugin.js` — i18n: add the abstention string; keep the total vocabulary so no state
      renders invisibly (§VII)
- [ ] T010 [US2] `plugin.js` — confirm the CI page is untouched: row visibility does not depend on the
      focused workspace (FR-005). No code change expected; assert it, do not assume it.

**Checkpoint**: suite green. Then re-run T001–T004's defects by hand — T011 below is the proof, not this.

## Phase 4: Negative controls (constitution §VI — the assertion must be *seen* to fail)

- [ ] T011 [US1] Reinstate the most-urgent fallback → T001's assertion MUST fail. Record the exact
      message; it should name the repo and why it is unjustified.
- [ ] T012 [US1] Make the abstention render `null` → T002's assertion MUST fail ("still identifies
      itself"). Record the message.
- [ ] T013 [P] [US1] Remove `mostUrgent` but leave the call site unreachable → the harness must fail to
      load (a `ReferenceError` at render), proving the deletion is load-bearing rather than cosmetic
- [ ] T014 [P] Restore each and confirm green again

## Phase 5: Documentation (constitution §VIII — same change)

- [ ] T015 `README.md` — the chip section documents the abstention behaviour; the "Where this shows up"
      section's rationale is corrected (the fallback was tried and removed, not merely absent)
- [ ] T016 [P] `README.md` — the layout table still matches the tree (no files added by this feature)

## Dependencies

- Phase 1 is independent of 2–4 but MUST land in the same change (a spec that lags the code is the drift
  the constitution forbids).
- Phase 2 blocks Phase 3 (red before green).
- Phase 4 requires Phase 3.
- Phase 5 lands with the implementation, never after.

## Out of scope for this slice

- `001`'s open Principle VI gap (T043–T046: compact row-shedding, the Gitea fold, command persistence).
  **Still open, still owned.** This feature neither closes it nor claims to.
- Per-card CI on the Kanban board; a composer-deck CI surface (no SDK seam — recorded in `001`).
