# Feature Specification: Absent-Upstream Branch Must Not Read as Drift

**Feature Branch**: `003-absent-branch`

**Created**: 2026-10-07

**Status**: Draft — awaiting owner review before implementation

**Input**: Owner observation, 2026-10-07: the status-bar chip showed a sha-drift warning (`△`) on
`hermes-ci-plugin / 002-impl / #4` **after** PR #4 had been merged. Reported as *"What do you see in
this image?"* — the warning was a false positive.

**Amends**: `001`'s **FR-007**. See [Amendment to 001](#amendment-to-001).

## Context

The chip is meant to warn when the CI it displays belongs to a commit other than the one checked out
(`001` FR-007, "sha drift"). It fired on a branch that had been **merged and deleted on the remote** —
the opposite of drift.

The chain, verified stage by stage:

1. GitHub deleted the head branch on merge (the repo's *automatically delete head branches* setting).
   The local branch survives, so the checkout is *"branch exists locally, gone upstream"*.
2. The collector resolves the branch's commit by **name** (`object(expression: "<branch>")`). With no
   remote ref that resolves to `null`, so the local head SHA comes back **empty**.
3. `headMatches` is computed as `bool(head_sha) and pr.head === head_sha`. An empty local head makes it
   `false` — "drifted" — even though the PR is merged and its head is contained in `main`.

A checkout whose upstream branch has vanished is **not** evidence of drift. Reporting it as drift tells
the user the opposite of the truth, at a glance, which is the same failure class as the fallback defect
`002` removed: a confident wrong answer.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - A merged-and-deleted branch reads as merged, not as drift (Priority: P1)

A developer merges a PR (so the remote head branch is deleted, while their local branch remains) and
switches back to that session. The chip shows no drift warning. It conveys that the branch is no longer
on the remote, and the PR chip shows it merged.

**Why this priority**: this is the observed defect. A warning that fires on the correct, finished state
trains the user to ignore the warning that matters.

**Independent Test**: on a checkout whose branch exists locally but has no remote ref, with a merged PR
on that branch name, confirm the chip shows no drift badge and states the branch is not on the remote.

**Acceptance Scenarios**:

1. **Given** a local branch with no remote ref and a PR for that branch, **When** the collector reports
   it, **Then** the local head SHA is reported as absent and `headMatches` is **unknown (`null`)** — not
   `false`.
2. **Given** that state, **When** the chip renders, **Then** it shows **no** sha-drift badge.
3. **Given** that state, **When** the row's detail renders, **Then** it describes the branch as absent
   from the remote rather than reporting "no checks".
4. **Given** a branch that genuinely differs from its PR's head, **When** the chip renders, **Then** the
   sha-drift badge **still** appears — the fix narrows the warning, it does not remove it.
5. **Given** a branch present on the remote and matching its PR, **When** the chip renders, **Then**
   nothing changes from today's behaviour.

---

### User Story 2 - The distinction survives the compact transport (Priority: P1)

The chip reads the sweep in `--compact` mode. Whatever the collector decides about drift must survive
that compaction intact, or the fix never reaches the UI.

**Why this priority**: the compact projection currently coerces the value, so a collector-only fix would
be invisible in the exact surface the defect was reported on.

**Independent Test**: take a repo entry with an unknown `headMatches`, compact it, and confirm the
unknown survives as `null` rather than collapsing to `false`.

**Acceptance Scenarios**:

1. **Given** a repo entry whose PR has `headMatches: null`, **When** it is compacted for transport,
   **Then** the compacted entry still reports `null` — a tri-state MUST NOT be flattened to a boolean.

### Edge Cases

- **Branch absent upstream, no PR at all.** Unknown; no drift badge; the absent state is still described.
- **Branch absent upstream, PR closed (not merged).** Unknown; the PR chip carries "closed", which is the
  useful signal. No drift badge.
- **Detached HEAD.** Already handled (`001`); the branch name is empty, so this feature's path is not
  entered.
- **Gitea.** The same shape exists on the Gitea path (`pulls?state=all` compared against a possibly-empty
  `head_sha`), so the defect is forge-independent and MUST be fixed on both.
- **A branch whose upstream exists but was force-pushed.** A genuine mismatch — the existing drift
  behaviour is correct here and MUST be preserved.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: When the local branch has no upstream ref — so its head commit cannot be resolved — the
  collector MUST report the local head SHA as absent and `headMatches` as **unknown (`null`)**. It MUST
  NOT report `false`.
- **FR-002**: `headMatches` MUST be a **tri-state**: `true` (matching), `false` (a proven mismatch), or
  `null` (not determinable). Every producer of the field MUST preserve all three.
- **FR-003**: Any transport projection of a repo entry (compact mode included) MUST preserve `null`
  rather than coercing it to a boolean.
- **FR-004**: The sha-drift badge MUST appear **only** on a proven mismatch (`false`). It MUST NOT appear
  for `null` or `true`.
- **FR-005**: When the branch is absent upstream, the UI MUST describe that state in words (in the checks
  or detail slot) instead of reporting "no checks", so the state is neither silent nor misleading.
- **FR-006**: Genuine drift detection MUST be unchanged: an established mismatch still reports `false` and
  still shows the badge.
- **FR-007**: The fix MUST apply to both forge paths (GitHub and Gitea), which share the shape.

### Key Entities

- **Branch result** (unchanged shape, one field gains a third state): head SHA, check state, counts, the
  individual check contexts, the PR, and a truncation flag. `headSha` may be **empty** to mean *"the
  branch is not on the remote"* — a state that previously had no name.
- **Pull request** (unchanged except semantics): `headMatches` becomes tri-state; `null` means the
  comparison could not be made, which is distinct from a failed comparison.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: In the reproduced state (local branch, no remote ref, merged PR), `headMatches` is `null`
  and the rendered chip contains no drift badge — asserted against a fixture of that exact state.
- **SC-002**: The compact projection preserves `null` for `headMatches` — asserted directly, because the
  chip is the surface the defect was reported on.
- **SC-003**: A genuine mismatch still yields `false` and still renders the badge — a positive control, so
  the fix cannot pass by simply never warning.
- **SC-004**: Every new assertion is demonstrated to fail against the current code (constitution §VI).
- **SC-005**: The collector's `--selftest` covers the tri-state, so the rule is enforced offline in CI on
  the oldest supported Python.

## Assumptions

- The repo setting *automatically delete head branches* stays on, so absent-upstream will keep occurring;
  it is the normal state after a merge, not an anomaly.
- Resolving a branch's commit by name is the right lookup; the fix is to interpret an empty result
  honestly, not to look up the PR's head instead (that would hide a genuine mismatch).
- The PR's own `state` (merged / closed) remains the user-facing signal for what happened to the work;
  this feature's job is only to stop the drift warning lying.

## Out of Scope

- `001`'s Principle VI gap (**T043–T046**: compact row-shedding, the Gitea fold, collector-command
  persistence). **Adjacent but separate** — this defect came from that untested-tolerance family, and
  closing one gap does not close the others. `003` adds only the assertions this feature needs.
- Any change to what "drift" means for a force-pushed branch.
- Gitea PR state beyond what already exists.

## Amendment to 001

| Artefact | Change |
| --- | --- |
| `spec.md` FR-007 | **Refined, not replaced.** Was: *"MUST detect a PR whose head has moved past the local checkout and report it as `sha drift`."* Now additionally requires that drift be reported **only when a mismatch is established**, and that an unresolvable local head be reported as unknown rather than as drift. |
| `spec.md` Key Entities → Pull request | The entity text gains the tri-state note for `headMatches`. |
| `spec.md` Edge Cases | Gains the absent-upstream case, which previously had no entry and therefore no specified behaviour. |
| `tasks.md` | New tasks; the record notes this is the fifth defect cycle. |

**Why**: the original requirement was not wrong, it was **incomplete** — it said when to warn, and said
nothing about a local head that cannot be resolved. That silence is what the code filled with `false`.
