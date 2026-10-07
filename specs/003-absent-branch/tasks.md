# Tasks: Absent-Upstream Branch Must Not Read as Drift

**Input**: Design documents from `/specs/003-absent-branch/`

**Prerequisites**: plan.md, spec.md, and `001`'s data-model.md

**Status**: **IMPLEMENTED.** The spec was approved and merged as PR #5 (`6f79a74`) before any
implementation ran. All tasks complete; every negative control (T010–T014) was executed and observed to
fail against its defect. One of them (T013) exposed a **hole in the assertions themselves** — killing the
chip's own drift line left the suite green — which is recorded as T049 in `001`.

**TDD order is load-bearing** (§VI): each assertion lands **before** the code, and each is demonstrated
to fail against the defect it guards.

## Format: `[ID] [P?] [Story] Description`

## Phase 1: Artefact correction — `001`'s FR-007 is incomplete, not wrong

- [x] C001 [US1] `001/spec.md` **FR-007** — refine: drift is reported only on an **established** mismatch,
      and an unresolvable local head is reported as unknown rather than drift
- [x] C002 [P] `001/spec.md` **Key Entities → Pull request** — record `headMatches` as tri-state
- [x] C003 [P] `001/spec.md` **Edge Cases** — add the absent-upstream case, which previously had no entry
      and therefore no specified behaviour (that silence is what the code filled with `false`)
- [x] C004 [P] `001/tasks.md` — record this as the fifth defect cycle, and that it was a *wrong
      requirement* rather than a coding error

## Phase 2: RED — assertions that must fail first

- [x] T001 [US1] `ci_status.py --selftest`: a PR whose local head is **empty** yields `headMatches is
      None` — and `is not False`. Asserting against `False` explicitly is the point: `None == False` is
      `False` but `None is False` is also `False`, so the assertion must name the failure it guards.
- [x] T002 [US1] `ci_status.py --selftest`: tri-state totality — `true` / `false` / `null` each reachable
      and distinct (a positive control for `true`, a negative for `false`)
- [x] T003 [P] [US2] `test/run.mjs`: compacting an entry whose PR has `headMatches: null` preserves
      `null` (does NOT become `false`) — the projection assertion, since the chip is where the defect was
      seen
- [x] T004 [P] [US1] `test/run.mjs`: a chip over a repo whose PR is `headMatches: null` renders **no**
      drift badge and **no** warning icon

**Checkpoint**: run both suites. All four MUST fail against current code. Record the output in the PR.

## Phase 3: GREEN — the implementation

- [x] T005 [US1] `ci_status.py` `_pr_payload` — `headMatches` becomes `None` when the local head is empty,
      else the comparison. Document the three states at the definition, since the tri-state is the point.
- [x] T006 [P] [US1] `ci_status.py` Gitea path — same rule for the Gitea PR payload (FR-007)
- [x] T007 [P] [US2] `ci_status.py` `_compact_pr` — stop coercing: pass the tri-state through
- [x] T008 [US1] `plugin.js` — describe the absent-upstream state in words (FR-005): the checks/detail slot
      says the branch is not on the remote, rather than "no checks"
- [x] T009 [P] [US1] `plugin.js` — confirm the badge remains gated on `=== false` only (no logic change
      expected; assert it rather than assume it)

**Checkpoint**: both suites green.

## Phase 4: Negative controls (§VI — each assertion *seen* to fail)

- [x] T010 [US1] Restore `bool(head_sha) and ...` → T001's assertion MUST fail
- [x] T011 [US1] Restore `bool(pr.get("headMatches"))` in the projection → T003's assertion MUST fail
- [x] T012 [US1] Make the badge render on `null` as well as `false` → T004's assertion MUST fail
- [x] T013 [P] Make drift **never** report → T002's positive control MUST fail (proves the fix cannot pass
      by never warning)
- [x] T014 [P] Restore each and confirm both suites green again

## Phase 5: Documentation (§VIII — same change)

- [x] T015 `README.md` — caveats: a branch with no remote ref reads as absent, not as drift, and why
      reporting it as drift would be a false positive on the normal post-merge state
- [x] T016 [P] `README.md` — the layout table still matches the tree

## Dependencies

- Phase 1 lands in the same change (a spec that lags the code is the drift the constitution forbids).
- Phase 2 blocks Phase 3. Phase 4 requires Phase 3. Phase 5 lands with the implementation.

## Out of scope for this slice

- `001`'s Principle VI gap (**T043–T046**: compact row-shedding, the Gitea fold, collector-command
  persistence). **Adjacent, deliberately not closed here.** This defect came from that untested-tolerance
  family, but closing one gap does not close the others, and claiming otherwise would be exactly the
  silence §VIII forbids.
