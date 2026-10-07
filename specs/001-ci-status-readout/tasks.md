# Tasks: CI Status Readout

**Input**: Design documents from `/specs/001-ci-status-readout/`

**Prerequisites**: plan.md, spec.md, data-model.md

**Status**: **BASELINE.** Every task marked `[x]` is already implemented and merged on `main`
(`b4b34c4` → `f46c299`). This file records the work as it actually happened — including the three
defect-fix cycles — so the record matches the shipped revision. Tasks left `[ ]` are the **open
harness gaps** that form the next slice.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: can run in parallel (different files, no dependency)
- **[Story]**: US1..US5 from spec.md

## Phase 1: Setup

- [x] T001 Repository, MIT licence, README skeleton, `.gitignore`
- [x] T002 [P] CI workflow with three jobs: `collector (3.9)`, `collector (3.13)`, `plugin harness`
- [x] T003 [P] `docs` guard job: promised files present, plugin id contract, no hardcoded colour in `plugin.js`
- [x] T004 [P] Spec Kit scaffold (`.specify/`) + constitution v1.0.0
- [x] T005 [P] `examples/config.json` a user can copy to `~/.hermes/ci-status/`
- [x] T006 Branch protection on `main`: required checks (strict), 1 review, no force-push/deletion

## Phase 2: Foundational — the collector

- [x] T007 Remote parsing (`https`, `ssh`, `git+ssh`, scp-like) → `(host, owner/name)`; forge classification
- [x] T008 Repo discovery: explicit `repos` ∪ immediate git children of `scan_root`, de-duped by resolved path
- [x] T009 Branch resolution (current + default), tolerant of detached HEAD
- [x] T010 RAG fold `_tally()` with the load-bearing rule **failure/pending beat success**
- [x] T011 GitHub path: single GraphQL query per branch → head, suites, legacy statuses, PR
- [x] T012 Fold check **suites → job-level checks** (not the aggregate rollup)
- [x] T013 Gitea path: REST `branches` + `commits/<sha>/status` + `pulls`, token from env or `tea` login
- [x] T014 Gitea API-base resolution (config → tea logins → remote host → `:3000`), first that answers
- [x] T015 PR payload incl. `headMatches` (sha-drift detection), review decision, mergeability
- [x] T016 Tolerance: no-remote → skipped; per-repo exception caught; every call timeout-bounded
- [x] T017 `--selftest` offline checks (parsing, classification, fold precedence, PR drift)
- [x] T018 `--compact` mode + row-shedding loop to fit the 4000-char transport budget, disclosing `omitted`

## Phase 3: US1 — Glanceable chip (P1) 🎯 MVP

- [x] T019 [US1] `CiChip` on `statusBar.right`: dot + repo + branch + PR chip
- [x] T020 [US1] Theme-token RAG palette (`RAG`), total vocabulary incl. `unknown`
- [x] T021 [US1] `shell.exec` transport helper: command assembly, JSON parse, truncation explained in words
- [x] T022 [US1] Loading / error chip states (never blank)
- [x] T023 [US1] Fallback to most-urgent repo, **disclosed** in the tooltip
      → **AMENDED by `002-honest-ci-fallback`: the fallback was specified deliberately, implemented, then
      removed as harmful.** It was not a coding error but a wrong requirement: on a surface with no
      workspace (the Kanban board, any full page) the app leaves its `cwd` atom on the last conversation,
      so the fallback named a real repository's CI where nothing justified it — indistinguishable at a
      glance from a correct answer. `mostUrgent` and its rank table are deleted, and the abstention that
      replaces them is covered by negative-controlled assertions. Recorded here rather than removed, so
      the history reads as honest as the three defect cycles above it.
- [x] T024 [US1] **Defect fix** — chip follows the focused session via `session.info`, keyed by session id (was frozen on the previous session)
- [x] T025 [US1] 30s poll, deduped into one collector call with the page via a shared query key

## Phase 4: US2 — Full page (P1)

- [x] T026 [US2] Route `/ci` + sidebar nav + two palette commands
- [x] T027 [US2] `CiRow`: expander, dot, repo, branch, checks, PR, forge columns
- [x] T028 [US2] `review` / `conflict` / `sha drift` badges
- [x] T029 [US2] "Checked out but not watched" section for skipped checkouts
- [x] T030 [US2] **Defect fix** — column geometry as inline styles (`COLUMNS`), not Tailwind arbitrary values (labels bunched ~24px left)
- [x] T031 [US2] **Defect fix** — hover-action buttons given their own column so header and row agree
- [x] T032 [US2] Empty / loading / error states

## Phase 5: US3–US5 — Detail, links, settings

- [x] T033 [US3] `RepoChecks` expansion: per-check name, conclusion, run link, head SHA + truncation note
- [x] T034 [US3] **Defect fix** — read `headSha` off the branch (not the repo); the phantom "check" row removed by not reusing the rollup's context list
- [x] T035 [US4] External link opening for PR, checks, actions and repository
- [x] T036 [US5] Settings row: editable + persisted + resettable collector command

## Phase 6: Harness (Principle VI)

- [x] T037 Plugin harness: rewrites the three import specifiers to stubs, executes the **real** plugin
- [x] T038 [P] Assertions: registered areas, route/nav/palette, i18n bundle
- [x] T039 [P] Assertions: chip follows the focused session, and the fallback is disclosed
- [x] T040 [P] Assertions: page renders rows, counts, badges, forge hosts, skipped section
- [x] T041 [P] Assertions: truncated payload explained; collector exit error surfaced
- [x] T042 [P] Assertions verified to **fail against their bug** (the three historical defects)

## Defect cycle 5 (fixed by `003-absent-branch`)

- [x] T047 [US1] **Requirement fix, not a code fix** — FR-007 was *incomplete*: it required drift to be
      reported and said nothing about a local head that cannot be resolved, so the code folded that case
      to `false` and reported a **merged** PR as drifting. `headMatches` is now a tri-state and the
      comparison is reported as unknown when it cannot be made.
- [x] T048 [US1] `--selftest` covers the tri-state (all three reachable and distinct) and asserts the
      compact projection preserves it — the projection is where the value was destroyed in transit.
- [x] T049 [US1] The chip's **own** drift indicator is now asserted separately from `PrChip`'s: killing
      the chip's line alone previously left the suite green, because the PR chip's icon satisfied a
      generic icon check.

*Why this is recorded here rather than only in `003`:* `001`'s FR-007 is the requirement that was
incomplete, so the correction belongs beside it. Five cycles now — three coding defects
(T024, T030/T031, T034), one wrong **requirement** (T023), one incomplete requirement (T047).

## Phase 7: Open gaps → next slice

- [ ] T043 [P] Negative-controlled test: compact row-shedding actually sheds and sets `omitted`
- [ ] T044 [P] Test: the Gitea fold path (no coverage today)
- [ ] T045 [P] Test: collector-command persistence round-trip through plugin storage
- [ ] T046 Re-run the pre-fix suite at the base to record it green (guard against a fixture hiding a regression)

**Checkpoint**: T043–T046 close the Principle VI gap recorded in `plan.md` → Complexity Tracking.

## Dependencies

- Phase 2 blocks everything after it.
- Phases 3–5 are the shipped feature; 6 is the harness that guards them; 7 is the only open work.
