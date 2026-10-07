# Feature Specification: CI Status Readout

**Feature Branch**: `001-ci-status-readout`

**Created**: 2026-10-06

**Status**: Baseline — documents behaviour already implemented on `main` (commits `b4b34c4`..`f46c299`)

**Input**: Baseline of the existing `hermes-ci-status` plugin. This spec is written **from the merged
revision**, not ahead of it: it captures what the shipped code does today so that later slices extend a
recorded contract instead of an assumed one.

## Purpose

A developer working across several checkouts cannot see, in the Hermes desktop app, whether the branch
they are on is passing. Claude Code's cloud sessions show a branch, its context folders and a CI
colour; Hermes shows the branch and the working directory but nothing about the checks. This feature
adds that missing signal: the check state (and pull request) of the branch each checkout is actually
on, as a glanceable status-bar chip and a browsable page.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Glanceable CI state for the focused chat (Priority: P1)

A developer is chatting in a session whose workspace is a git checkout. The status-bar chip names that
repository and its current branch, shows a red/amber/green dot for the branch's checks, and shows the
pull request the branch belongs to. When they switch to a session in a different repository, the chip
follows them.

**Why this priority**: this is the feature's entire reason to exist — the glance. Without it the user
still has to leave the app to learn whether their branch is green.

**Independent Test**: focus a session whose workspace is a watched repository and confirm the chip
names that repo and its branch, with a dot matching the branch's check state; switch to a session in a
different watched repository and confirm the chip re-points.

**Acceptance Scenarios**:

1. **Given** a focused session whose workspace is a watched repository, **When** the sweep completes,
   **Then** the chip names that repository, its branch, its CI dot and its PR number (if any).
2. **Given** two watched repositories and a session focused on the second, **When** the user switches
   sessions, **Then** the chip follows the newly focused session's workspace rather than remaining on
   the previous one.
3. **Given** a focused session whose workspace belongs to no watched repository, **When** the sweep
   completes, **Then** the chip names **no** repository, states in words that there is no repository
   under this view, and remains clickable through to the CI page.
   *(Superseded by `002-honest-ci-fallback`. The former behaviour — falling back to the most urgent CI
   state and disclosing it — was removed: on a surface with no workspace the app leaves its `cwd` atom
   on the last conversation, so the "fallback" named a real repository's CI where none was justified,
   which at a glance is indistinguishable from a correct answer. See `002`'s §Amendment to 001.)*
4. **Given** the collector cannot be reached, **When** the chip renders, **Then** it shows an explicit
   error affordance naming the reason, and clicking it opens the page — never a blank chip.

---

### User Story 2 - Browse every watched repository (Priority: P1)

A developer opens the CI page (sidebar → **CI**, or `/ci`) and sees one row per watched repository:
check state, repository, branch, a counts summary, the pull request and its badges, and the forge host.

**Why this priority**: the chip answers "am I green right now"; the page answers "what is the state of
this machine", which is what the user asks when the chip is not the repository they care about.

**Independent Test**: open the page and confirm each watched repository has a row with the state,
branch, counts, PR and forge columns populated, and that checkouts with no forge appear separately as
"not watched".

**Acceptance Scenarios**:

1. **Given** several watched repositories, **When** the page opens, **Then** each has one row with a
   state dot, repository name, branch, a counts summary, a PR cell and a forge host.
2. **Given** a branch whose PR requires review, **When** the row renders, **Then** it carries a
   `review` badge; **Given** a PR that is not mergeable, **Then** it carries a `conflict` badge.
3. **Given** a PR whose head has moved past the local checkout, **When** the row renders, **Then** it
   carries a `sha drift` badge, because the checks shown belong to somebody else's commit.
4. **Given** a checkout with no forge remote, **When** the page renders, **Then** it appears under
   "Checked out but not watched" with its reason, rather than as a broken row.

---

### User Story 3 - Inspect a repository's individual checks (Priority: P2)

A developer expands a row and sees every check by name, its conclusion, a link to the run, and the head
commit the checks belong to.

**Why this priority**: the row says *how many* passed; the expansion says *which* failed, which is the
next question and the one that saves a context switch.

**Independent Test**: expand a row and confirm each check is listed by name with a conclusion and an
external link, and that the head SHA is shown.

**Acceptance Scenarios**:

1. **Given** a collapsed row, **When** the user expands it, **Then** each check on the branch is listed
   by name, with its conclusion and a link to the run.
2. **Given** a repository with CI configured but no checks on this branch, **When** the row expands,
   **Then** the reason is stated in words, distinguishing "no pipeline configured" from "no checks
   reported".

---

### User Story 4 - Reach the change on the forge (Priority: P2)

A developer clicks the PR chip, a check's link, or a row's hover icons and lands on the right page of
GitHub or Gitea.

**Why this priority**: the readout must not be a dead end; acting on what it shows shouldn't require
hunting for the URL.

**Independent Test**: from a row, click the PR chip and each hover icon and confirm the correct forge
URL opens externally.

**Acceptance Scenarios**:

1. **Given** a row with a PR, **When** the PR chip is clicked, **Then** the PR page opens externally.
2. **Given** a row, **When** the hover icons are used, **Then** the forge's pull-requests page, its
   actions page and the repository page each open externally.

---

### User Story 5 - Configure where the collector lives (Priority: P3)

A developer on a machine that is not the author's opens the page's settings row and changes the command
used to invoke the collector, which persists across restarts.

**Why this priority**: the install is two halves on two machines; the invocation is a machine fact the
plugin cannot assume. This makes the plugin usable by someone else without a code change.

**Independent Test**: change the collector command in the settings row, restart the app, and confirm the
new value is used and survives.

**Acceptance Scenarios**:

1. **Given** the settings row, **When** a new collector command is applied, **Then** subsequent sweeps
   use it and it persists across restarts; **Given** Reset, **Then** the default is restored.

---

### Edge Cases

- **Forge unreachable.** Reported in words on the affected repo; the rest of the sweep is unaffected.
- **CLI not installed or not authenticated.** The GitHub path reports it explicitly (`gh unavailable or
  not authenticated`), and the page header notes `gh not authenticated`.
- **Repository with no remote.** Reported as *skipped* / "no origin remote" — a scratch checkout is not
  a broken pipeline.
- **Response truncated by the transport.** The transport keeps only the last 4000 characters; when the
  payload is cut, the UI states that plainly and tells the user how to narrow the watch list, rather
  than reporting a JSON syntax error.
- **Detached HEAD.** The current branch renders as `(detached)` without failing the row.
- **A repository with no CI configuration at all.** Distinguished from "pipeline exists but nothing has
  run", so the user does not read "no checks" as "not wired up".
- **One repository raising an exception.** The sweep continues; the failing repo carries the error.
- **Over-large sweep.** Rows are shed (skipped checkouts first) until the payload fits, and the count
  shed is disclosed in the header.

## Requirements *(mandatory)*

### Functional Requirements

**Collection**

- **FR-001**: The system MUST discover watched repositories from an explicit list unioned with the
  immediate git children of a scan root (auto-scan on by default), and MUST de-duplicate them by
  resolved path.
- **FR-002**: The system MUST determine each repository's current branch and default branch, tolerating
  a detached HEAD.
- **FR-003**: The system MUST resolve the forge (GitHub, Gitea) from the repository's `origin` remote
  URL, supporting `https`, `ssh`, `git+ssh` and scp-like forms.
- **FR-004**: The system MUST fetch, per (repository, branch), the check rollup **folded to
  individual jobs/checks** and the pull request that branch belongs to.
- **FR-005**: For GitHub, the system MUST obtain the rollup through a single GraphQL query per branch,
  folding check suites into job-level results; for Gitea, through its REST API.
- **FR-006**: The system MUST classify every check set into exactly one of `success`, `failure`,
  `pending`, `neutral`, `none`, `unknown`, with **failure and pending taking precedence over success**.
- **FR-007**: The system MUST detect a PR whose head has moved past the local checkout and report it as
  `sha drift`.
- **FR-008**: The system MUST report the PR's review decision and mergeability so the UI can badge
  `review` and `conflict`.
- **FR-009**: The system MUST report a repository with no forge as *skipped* with a reason, never as a
  failure.
- **FR-010**: The system MUST bound every network call with a timeout and MUST return a well-formed
  document even when nothing answers.
- **FR-011**: The system MUST offer a compact output mode sized to the transport budget, shedding and
  disclosing rows rather than emitting unparseable output.

**Presentation**

- **FR-012**: The system MUST present a status-bar chip showing the focused session's repository,
  branch, CI state and PR, and MUST follow the focused session when the user switches.
- **FR-013**: When no watched repository matches the focused workspace, the chip MUST name **no**
  repository from the sweep — there is no "most urgent" (or any other) fallback — MUST state in words
  that there is no repository under this view, and MUST remain visible and clickable through to the CI
  page. *(Superseded by `002-honest-ci-fallback`, which removed the fallback this requirement used to
  demand. The ordering rule lived in `mostUrgent`, deleted so it cannot be reinstated by accident.)*
- **FR-014**: The system MUST present a full page listing every watched repository with columns for
  state, repository, branch, checks, pull request and forge host.
- **FR-015**: The system MUST allow a row to be expanded to list each check by name, conclusion and run
  link, plus the head commit.
- **FR-016**: The system MUST open forge URLs externally (PR, checks, repository) and MUST NOT navigate
  the app itself to them.
- **FR-017**: The system MUST render every state through the app's theme tokens and MUST NOT hardcode
  colour.
- **FR-018**: The system MUST keep table column geometry identical between the header and every row, so
  a cell can never drift from its label.
- **FR-019**: The system MUST allow the collector invocation to be edited at runtime and persisted, and
  MUST default it to a sane value.
- **FR-020**: The system MUST report the age of its data implicitly through a periodic refresh, and MUST
  expose a manual refresh.

**Constraints**

- **FR-021**: The desktop half MUST be plain ESM loaded uncompiled, with no bundler, no transpiler and
  no `package.json`.
- **FR-022**: The collector MUST be stdlib-only Python (3.9+) with no third-party dependency.
- **FR-023**: The plugin MUST perform no filesystem or network I/O of its own; all such work belongs to
  the collector, reached through the app's own `shell.exec` RPC.
- **FR-024**: The system MUST be read-only: nothing may write to a repository, PR, branch or forge.
- **FR-025**: The plugin id, the `desktop-plugins/` folder name and the repository name MUST be the
  same string (`hermes-ci-status`).

### Key Entities

- **Repo entry**: one watched working copy — name, root path, forge host, slug, remote, URL, current
  branch, default branch, dirty flag, whether it has CI config, its per-branch results, and any error.
- **Branch result**: the outcome for one (repo, branch) — head SHA, check state, counts
  (passed/failed/pending/skipped/neutral), the individual check contexts, the PR, and a truncation flag.
- **Check context**: one check — name, type (job or legacy status), status, conclusion, and the URL to
  its run.
- **Pull request**: number, state, draft flag, title, URL, mergeability, review decision, head SHA, and
  whether that head matches the local checkout.
- **Document**: the single JSON payload the collector emits — generation time, whether the GitHub CLI is
  ready, the repo entries, and errors.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A developer can determine the CI state of the branch they are on without leaving the
  desktop app, in a single glance, for every watched repository.
- **SC-002**: Switching the focused session re-points the chip to that session's repository within one
  refresh cycle.
- **SC-003**: The sweep of a realistic checkout tree (9+ repositories) fits within the transport budget
  and still names every repository that has CI, disclosing any it had to shed.
- **SC-004**: No sweep of reachable, authenticated forges takes longer than the sum of its bounded
  call timeouts; a single unreachable forge degrades that repository alone.
- **SC-005**: The plugin installs and runs with no `npm install`, no build step and no Python
  dependency beyond the standard library.
- **SC-006**: The plugin survives a host-app upgrade with no re-apply step and no source-tree change.
- **SC-007**: Every non-trivial harness assertion is demonstrably able to fail against the defect it
  guards.

## Assumptions

- The user has at least one git checkout on the machine running the **backend**, and the app is either
  on the same machine or the two halves are installed separately as documented.
- Forge access is available: the `gh` CLI authenticated for GitHub, and a token (env or `tea` login)
  for Gitea. Absent these, the affected rows report the gap rather than failing.
- The app's `shell.exec` RPC remains the transport, with its 4000-character stdout ceiling.
- The SDK's contribution areas used here exist and remain supported: `routes`, `sidebarNav`, `palette`,
  `statusBar.right`.
- ~~"Most urgent" ordering is failure → pending → success → neutral → none → unknown.~~
  **Removed by `002-honest-ci-fallback`** — the ordering no longer exists in the code. `mostUrgent` and
  its rank table were deleted outright rather than left unused, because an unused helper is how a
  removed heuristic returns as an obvious improvement.
- Out of scope for this slice: any write action, any gating or blocking, non-git VCS, forges other than
  GitHub and Gitea, and a dedicated composer-deck surface (recorded separately; the SDK exposes no seam
  for it).
