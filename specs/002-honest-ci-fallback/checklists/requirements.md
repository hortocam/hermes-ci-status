# Requirements Checklist: Honest CI Fallback

**Purpose**: Requirements-quality review of `002-honest-ci-fallback`. This is a **reviewer-owned**
artifact — `[x]` means the criterion was reviewed and satisfied *as a requirement*, not that
implementation is complete. An author ticking their own checklist is a self-report.
**Created**: 2026-10-07
**Feature**: [spec.md](../spec.md)

## Requirement Quality

- [x] CHK001 Every requirement is a testable MUST; no "should", "prefer" or "consider"
- [x] CHK002 No `[NEEDS CLARIFICATION]` markers remain open
- [x] CHK003 Requirements state WHAT and WHY; implementation specifics stay in `plan.md`
- [x] CHK004 The abstention is stated as a *prohibition* on naming a repo (FR-001), not merely "show
      nothing" — a prohibition cannot be satisfied by a differently-named guess
- [x] CHK005 FR-007 requires **deletion** of the heuristic, not disuse. This is the requirement that
      prevents the defect returning, so it is stated as its own MUST rather than a note
- [x] CHK006 FR-005 protects the CI page explicitly, because abstaining is only acceptable while the
      inventory remains reachable
- [x] CHK007 Out-of-scope items are named (per-card CI, deck surface, project↔board inference) with the
      reason each is excluded

## Change Control

- [x] CHK008 The supersession of `001` FR-013 is declared in this spec, not left implicit
- [x] CHK009 Every `001` artefact that this feature falsifies is enumerated with the specific edit
      (§Amendment to 001), so the correction is checkable rather than aspirational
- [x] CHK010 T023 is amended rather than deleted, preserving the record that the fallback was deliberate
      before it was removed — the same treatment `001` gave its three defect cycles
- [x] CHK011 The reason for removal travels with the requirement it replaces, so a future reader does not
      reinstate the fallback as an obvious improvement

## Constitution Compliance

- [x] CHK012 §VI: SC-001 and SC-002 name the defeat each assertion must be shown to catch; T011–T013 are
      the negative controls, not optional extras
- [x] CHK013 §VII is *strengthened*, not merely preserved: the no-workspace state becomes a rendered
      vocabulary entry instead of a silent, possibly-wrong value (the "vanishing chip" alternative was
      rejected on this principle)
- [x] CHK014 §II: no new SDK surface is depended on; the change uses only areas and atoms already used by
      `001`
- [x] CHK015 §Governance: each rejected alternative is recorded with its reason, so the design is
      auditable against the simpler options
- [x] CHK016 Principles I–VIII all pass with no Complexity Tracking entry required, because this change
      *removes* complexity

## Consistency & Ambiguity

- [x] CHK017 The entities are explicitly unchanged from `001`'s data-model; no document-shape change is
      implied anywhere in this feature
- [x] CHK018 No success criterion is unfalsifiable; each maps to an assertion or an observable count
- [x] CHK019 The abstention state is unambiguously distinguished from the collector-error state in both
      the requirements (FR-002) and the design (§Abstention state)

## Gaps Recorded (not satisfied — owned elsewhere)

- [ ] CHK020 `001`'s Principle VI gap (T043–T046: compact row-shedding, Gitea fold, command persistence)
      remains open. This feature does not close it and its materials say so, so the gap cannot be read as
      closed by association.
- [ ] CHK021 The Kanban board itself still has no workspace source. This feature makes the chip abstain
      there rather than be wrong; it does not give the board a workspace, and the spec's Assumptions and
      Out of Scope say so plainly.

## Notes

- CHK020–CHK021 are deliberately unchecked: they are adjacent problems this change does not solve. A
  change that quietly implies it fixed them would be the drift the constitution prohibits.
- The reviewer for this change must be of a different model lineage from the author (constitution
  §Independent review).
