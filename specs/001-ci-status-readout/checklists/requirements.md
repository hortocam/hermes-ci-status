# Requirements Checklist: CI Status Readout

**Purpose**: Baseline requirements-quality review of `001-ci-status-readout`, written against the
**merged** revision. This is a reviewer-owned artifact: `[x]` means the criterion was reviewed and is
satisfied *as a requirement*. It is not a claim that implementation work is complete.
**Created**: 2026-10-06
**Feature**: [spec.md](../spec.md)

## Requirement Quality

- [x] CHK001 Every functional requirement is stated as a testable MUST, not a "should" or a hope
- [x] CHK002 No `[NEEDS CLARIFICATION]` markers remain unresolved (the baseline is derived from shipped behaviour, so none are open)
- [x] CHK003 Requirements describe WHAT and WHY, not HOW — framework names appear only under Constraints, where the constraint *is* the technology
- [x] CHK004 The precedence rule ("failure and pending beat green") is stated explicitly (FR-006) rather than implied
- [x] CHK005 Each constraint that the CI actually enforces has a corresponding requirement (FR-021 no build, FR-022 stdlib-only, FR-024 read-only, FR-025 id contract)
- [x] CHK006 Every success criterion is measurable or observable, with no unfalsifiable phrasing
- [x] CHK007 Out-of-scope items are named (write actions, gating, non-git VCS, other forges, composer-deck surface)

## Coverage Against Implementation

- [x] CHK008 Each of the five user stories maps to a registered surface or component in `plugin.js`
- [x] CHK009 The transport's 4000-character ceiling is captured as a first-class constraint (FR-011), matching the code's row-shedding loop
- [x] CHK010 The theme-token rule (FR-017) matches a real CI guard, not just prose
- [x] CHK011 The geometry rule (FR-018) matches the `COLUMNS` inline-style design
- [x] CHK012 The three historical defects each appear as a resolved task in `tasks.md` (T024, T030/T031, T034) so the record is honest about the iterations

## Consistency & Ambiguity

- [x] CHK013 Entity names in `data-model.md` match the JSON keys the collector actually emits
- [x] CHK014 The RAG vocabulary in `spec.md` and `plan.md` is identical and total
- [x] CHK015 The id/folder/repo naming contract (FR-025) is consistent across spec, plan and README

## Gaps Recorded (not satisfied — owned by the next slice)

- [ ] CHK016 The harness does not yet assert the compact row-shedding loop (T043)
- [ ] CHK017 The Gitea path has no test coverage (T044)
- [ ] CHK018 Collector-command persistence has no round-trip test (T045)
- [ ] CHK019 There is no demo document (`demo.md`); the constitution does not require one for this plugin, but a runnable walkthrough would strengthen the human checkpoint

## Notes

- CHK016–CHK019 are deliberately left unchecked: they are the honest gaps, carried into the next slice rather than silently assumed closed.
- This checklist is the reviewer's, not the author's — an author ticking their own checklist is a self-report.
