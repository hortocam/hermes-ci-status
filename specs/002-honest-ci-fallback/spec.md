# Feature Specification: Honest CI Fallback

**Feature Branch**: `002-honest-ci-fallback`

**Created**: 2026-10-07

**Status**: Draft — awaiting owner review before implementation

**Input**: Owner request, 2026-10-07: *"When I switch to the Kanban board, the plugin loads the default
(worst item) because there isn't any project state associated. Is there a path to fix that…"* followed by
*"for now, the honest fallback fix."*

**Supersedes**: `specs/001-ci-status-readout/spec.md` **FR-013** and **US1 acceptance scenario 3**, and
the `"Most urgent" ordering` assumption. See [Amendment to 001](#amendment-to-001) below.

## Context

`001-ci-status-readout` specifies that when the focused workspace matches no watched repository, the chip
**falls back to the repository with the most urgent CI state and discloses the fallback in its tooltip**
(FR-013, US1#3). That behaviour has since been shown to be harmful in practice.

The app's `cwd` atom is not a per-session fact: when a surface has no workspace — the Kanban board,
Artifacts, any full page — the app leaves the atom holding the last conversation's folder. A
"most urgent" fallback therefore reported a real repository's CI on a surface that had no relationship to
it. The owner observed exactly this: on the Kanban board the chip named the worst repo with nothing
justifying it, which is indistinguishable from a correct answer at a glance.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - No false answer on a surface with no workspace (Priority: P1)

A developer switches to the Kanban board (or any full page). The chip does not name a repository,
because there is no repository under what they are looking at. It states that plainly, and remains a
route into the CI page.

**Why this priority**: a status readout that can be confidently wrong is worse than one that abstains —
the entire value of the glance is that it can be trusted without checking. This is the whole change.

**Independent Test**: from a session whose workspace is a watched repository, open the Kanban board and
confirm the chip names no repository, says so, and still opens the CI page when clicked.

**Acceptance Scenarios**:

1. **Given** a surface with no matching workspace, **When** the chip renders, **Then** it names **no**
   repository from the sweep, and its tooltip states that there is no repository under this view.
2. **Given** the same state, **When** the chip renders, **Then** it still identifies itself and is still
   clickable through to the CI page — it is never a blank or a dead dot.
3. **Given** a focused session whose workspace *does* match a watched repository, **When** the chip
   renders, **Then** it names that repository, its branch, its CI state and its PR exactly as before.
4. **Given** the chip was showing the no-workspace state, **When** the user switches back to a session
   in a watched repository, **Then** the chip re-points to that repository.

---

### User Story 2 - The CI page remains the inventory (Priority: P1)

A developer on a surface with no workspace still wants to see every repository's state. Clicking the
abstaining chip opens the CI page, which is unchanged and still lists every watched repository.

**Why this priority**: without this the change would trade a false answer for no answer at all. The page
is what makes abstaining acceptable — the information is always one click away.

**Independent Test**: from the no-workspace state, click the chip and confirm the page opens listing
every watched repository with its row intact.

**Acceptance Scenarios**:

1. **Given** the no-workspace chip, **When** it is clicked, **Then** the CI page opens.
2. **Given** the page is open, **When** it renders, **Then** every watched repository still has its row —
   no row is suppressed on the grounds that the workspace does not match.

### Edge Cases

- **Genuinely no watched repositories at all.** The chip abstains, indistinguishable from the
  no-workspace case. Acceptable: both mean "nothing to report here", and the page explains which.
- **A workspace that is a *subdirectory* of a watched repository.** Still a match — the existing
  most-specific-root rule is unchanged.
- **The app's cwd atom is empty** (a fresh draft). No match, so the chip abstains. Previously it would
  have guessed.
- **A stale cwd from a just-closed session.** No positive match, so the chip abstains rather than
  asserting a repository that may not be the focused one.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: When no watched repository owns the focused workspace, the chip MUST name no repository
  from the sweep. There MUST be no "most urgent" (or any other) repository fallback.
- **FR-002**: In that state the chip MUST state in words that there is no repository under this view, and
  MUST distinguish this case from a collector error.
- **FR-003**: The chip MUST remain visible and actionable in that state — it MUST NOT render nothing —
  and clicking it MUST open the CI page.
- **FR-004**: The chip MUST resolve a repository **only** on a positive match between the focused
  workspace and a watched repository root (a subdirectory matching the most specific root counts).
- **FR-005**: The CI page MUST continue to list every watched repository, including when the chip is
  abstaining. Row visibility MUST NOT depend on the focused workspace.
- **FR-006**: The change MUST NOT alter the chip's matched-workspace behaviour: repository, branch, CI
  state, PR chip, sha-drift badge and session-following all render exactly as specified in `001`.
- **FR-007**: The `mostUrgent` ordering MUST be removed from the implementation, not merely bypassed, so
  no dead ordering rule survives to be reinstated by accident.

### Key Entities

Unchanged from `001` — this change alters **which** repo entry the chip selects, not the document shape.
The `Repo entry`, `Branch result`, `Check context`, `Pull request` and `Document` entities are as
defined in `specs/001-ci-status-readout/data-model.md`.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: On a surface with no matching workspace, the chip names zero repositories from the sweep —
  verified by an assertion over the rendered tree against a multi-repo fixture.
- **SC-002**: The abstaining chip is still clickable and still identifies itself — verified by an
  assertion that fails if the chip renders `null`.
- **SC-003**: A matching workspace still resolves its repository — asserted in the same suite, so the
  abstention cannot over-reach into the working case.
- **SC-004**: Every new assertion is demonstrated to fail against the defect it guards (constitution
  §VI): reinstating the most-urgent fallback fails SC-001's assertion; rendering `null` in the
  no-workspace state fails SC-002's.
- **SC-005**: The full CI page row count is unchanged by this feature for a given sweep.

## Assumptions

- The app continues to expose nothing that identifies a "current project" for a non-chat surface; the
  workspace atoms remain a Sessions/Bot-Mode signal only. If that ever changes, a *positive* workspace
  source for pages would supersede this abstention — the correct fix then is a real signal, not a guess.
- Abstaining is preferred to guessing because a glanceable status must be trustworthy without
  verification; the owner explicitly chose this over the alternative.
- A project ↔ board link (`projects.board_slug`) exists and could eventually inform a board's CI, but it
  is **out of scope here**: it is inferential, lossy, and the profiles it implies have no forge
  credential on this host.

## Out of Scope

- Per-card CI on the Kanban board (each card's `completion_contract` PR → its checks). A separate,
  genuinely useful feature; not a fallback fix.
- A CI surface inside the composer status deck. `001` records the SDK boundary: no seam targets the deck.
- Any write action, gating, or new forge support.

## Amendment to 001

`001`'s baseline is the merged revision at `f46c299`. This feature changes that behaviour, so `001`'s
record MUST be corrected in the same change rather than left to drift (constitution §Documented Surface,
§Governance):

| Artefact | Change |
| --- | --- |
| `spec.md` FR-013 | **Replaced.** Was: fall back to the most urgent repository and disclose it. Now: name no repository, state it plainly, stay actionable. |
| `spec.md` US1 scenario 3 | **Replaced** with the abstention scenario. |
| `spec.md` Assumptions | The `"Most urgent" ordering` bullet is **removed** — the ordering no longer exists. |
| `tasks.md` T023 | **Amended**, not deleted: records that the fallback was specified, implemented, and then removed as harmful when a false answer was observed in use. |
| `tasks.md` | New tasks for this feature's implementation and negative controls. |
| `checklists/requirements.md` | CHK004's precedence rule is unaffected; a note is added recording that FR-013 was superseded and why. |

**Why**: the constitution forbids leaving an artefact describing behaviour the code does not have. The
rationale for removing the fallback belongs next to the requirement that used to demand it, so the next
reader does not reinstate it as an obvious improvement.
