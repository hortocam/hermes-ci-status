# Requirements Checklist: Absent-Upstream Branch Must Not Read as Drift

**Purpose**: Requirements-quality review of `003-absent-branch`. **Reviewer-owned** — `[x]` means the
criterion was reviewed and satisfied *as a requirement*, not that implementation is complete.
**Created**: 2026-10-07
**Feature**: [spec.md](../spec.md)

## Requirement Quality

- [x] CHK001 Every requirement is a testable MUST
- [x] CHK002 The tri-state is stated as a **prohibition** on the wrong value (FR-001: "MUST NOT report
      `false`") rather than a vague "handle the absent case" — a prohibition cannot be satisfied by a
      differently-shaped guess
- [x] CHK003 FR-002 requires all **three** states to be preservable, which is what makes FR-001 enforceable
      end to end rather than at one producer
- [x] CHK004 The projection is called out as its own requirement (FR-003). Without it, a collector-only fix
      would pass every collector test and still be broken on the chip — the surface where it was reported
- [x] CHK005 FR-004 keeps the badge gated on a **proven** mismatch, and SC-003 is its positive control, so
      the change cannot pass by never warning
- [x] CHK006 FR-006 protects existing drift detection explicitly: this narrows a warning, it does not
      remove one
- [x] CHK007 Both forge paths are required (FR-007); the defect was never GitHub-specific
- [x] CHK008 Out-of-scope names `001`'s Principle VI gap and states why it is *not* closed here

## Change Control

- [x] CHK009 FR-007 is **refined, not replaced** — the original requirement was incomplete, and the spec
      says so, so the record does not imply the original was wrong
- [x] CHK010 The three `001` artefacts this falsifies are enumerated with the specific edit
- [x] CHK011 The reason travels with the requirement: a silent gap in FR-007 is what the code filled with
      `false`, so the refinement is what prevents a recurrence

## Constitution Compliance

- [x] CHK012 §VI: SC-001…SC-004 each name the defeat they must be shown to catch; T010–T013 are the
      negative controls
- [x] CHK013 §VI: the tri-state also lands in `--selftest`, so CI enforces it offline on the oldest
      supported Python rather than only in the Node harness
- [x] CHK014 §VII is strengthened: an unresolvable head becomes a *named* state instead of a false one —
      the same move `002` made for "no workspace"
- [x] CHK015 §VIII: README gains the absent-upstream behaviour in the same change
- [x] CHK016 No Complexity Tracking entry required: the change deletes a coercion

## Design Soundness

- [x] CHK017 The tempting shortcut — "use the PR's head when the branch is absent" — is recorded as
      **rejected with its reason** (it converts a loud false positive into a silent false negative)
- [x] CHK018 `null` is explicitly distinguished from a softened `false`: it asserts that no comparison
      happened, which is why no badge may fire
- [x] CHK019 The detection rule is stated in terms of what is knowable (an empty resolved head), not in
      terms of a heuristic that could drift

## Gaps Recorded (not satisfied — owned elsewhere)

- [ ] CHK020 `001`'s Principle VI gap (T043–T046: compact row-shedding, the Gitea fold, command
      persistence) **remains open**. This feature adds only the assertions it needs; the wider tolerance
      family is still untested and the materials say so.
- [ ] CHK021 Whether other "cannot determine" states exist elsewhere in the collector (states currently
      collapsed into a boolean or an empty string) has **not** been surveyed. This feature fixes the one
      that was observed; a systematic sweep of the document's error states would be its own slice.

## Notes

- CHK020–CHK021 are deliberately unchecked. CHK021 in particular is the honest admission that this is a
  targeted fix to an observed symptom, not proof that the class is exhausted.
- The reviewer for this change must be of a different model lineage from the author.
