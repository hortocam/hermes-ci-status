# Implementation Plan: Honest CI Fallback

**Branch**: `002-honest-ci-fallback` | **Date**: 2026-10-07 | **Spec**: [spec.md](./spec.md)

**Baseline note**: this is a **delta** on `001-ci-status-readout` (`main` @ `f876fe5`), not a fresh
feature. The architecture is unchanged; the change is which repo entry the chip selects, and the removal
of a heuristic that produced false answers.

## Summary

Remove the chip's "most urgent repository" fallback and replace it with an explicit abstention. The
change is deliberately small in code and load-bearing in meaning: the chip may resolve a repository
**only** on a positive workspace match, and otherwise says so in words while remaining a route into the
CI page.

No collector change. No document-shape change. No new SDK surface. The CI page is untouched — it is what
makes abstaining acceptable, because the inventory is one click away.

## Technical Context

**Language/Version**: Desktop — plain ES modules (uncompiled, Node 22+ host). Collector — Python 3.9+
(**unchanged by this feature**).

**Primary Dependencies**: `@hermes/plugin-sdk`, `react`, `react/jsx-runtime` — host-provided, unchanged.

**Storage**: none added. The plugin still persists exactly one value (the collector command).

**Testing**: `node test/run.mjs` — new assertions added; `python3 ci_status.py --selftest` unchanged.

**Target Platform**: the Hermes desktop app + any backend host — unchanged.

**Project Type**: distributable desktop plugin — two files plus harness.

**Constraints**: all of `001`'s constraints still bind (§V theme tokens / inline geometry, §VII tolerant
by construction, §IV read-only). This feature adds no exception.

**Scale/Scope**: two source files (`plugin.js`, `test/run.mjs`) plus the `001` artefact corrections.

## Constitution Check

*GATE: re-checked after design.*

| Principle | Status | Note |
| --- | --- | --- |
| I. A plugin, never a patch | ✅ | No source-tree change; both halves stay outside the install tree. |
| II. The published surface only | ✅ | Uses only `statusBar.right`, `host.state.focusedSessionId`, `host.state.cwd`, `ctx.onEvent`. No new reach-in, no DOM. |
| III. One boundary | ✅ | The collector is not touched; no I/O is added to the plugin. |
| IV. Read-only, no secrets | ✅ | The change removes UI behaviour; nothing is written, no token is involved. |
| V. Theme tokens; inline geometry | ✅ | The abstaining chip uses existing tokens (`--ui-text-quaternary`, muted `StatusDot`); no geometry is added. CI guard still passes. |
| VI. Harness is the gate | ✅ | Two negative-controlled assertions added (SC-001, SC-002) plus a positive control (SC-003). |
| VII. Tolerant by construction | ✅ | **Strengthened**: the no-workspace state is now a rendered vocabulary entry rather than a silent, possibly-wrong value. The chip is never blank. |
| VIII. Documented surface | ✅ | README gains the abstention behaviour and the corrected FR-013 rationale; `001` artefacts corrected in the same change. |

**No violations.** No Complexity Tracking entry is required: this change *removes* complexity (a rank
table and a sort) rather than adding it.

## Design

### Selection rule

```
repo = repoForCwd(repos, focusedWorkspace)     // positive match only
if (!repo) → render the abstention chip and stop
```

- `focusedWorkspace` resolution is **unchanged** from `001`: the focused session's own `cwd` from
  `session.info` (keyed by session id), falling back to the app's live cwd atom.
- `repoForCwd` is **unchanged**: a path-prefix match taking the most specific root on ties.
- `visibleRepos` is unchanged; the skipped (no-forge) filter still applies before matching.

### Abstention state

A dimmed, inert-looking chip — a muted `StatusDot` plus the literal `CI` — whose tooltip explains that
there is no repository under this view and that CI follows the workspace of the chat you are in. It is a
`button` that navigates to the CI page.

Rejected alternatives, with reasons (constitution §Governance requires the simpler alternative be named):

| Alternative | Why rejected |
| --- | --- |
| Render `null` (hide the chip entirely) | A vanishing chip reads as "the plugin broke". The state is real information, and §VII's vocabulary is meant to be total. |
| Show the repo count instead ("CI · 9 repos") | Invents a fact the chip is not about; the count belongs to the page header, which already has it. |
| Keep a fallback but mark it "(guessed)" | Still a guess presented as a status; a glance cannot be trusted, which is the defect. |
| Add a per-page workspace source | Correct long-term, but no such seam exists (recorded in `001`). Guessing under a different label is the same bug. |

### Removal, not bypass

The `mostUrgent` helper and its rank table MUST be **deleted**. Left in place and merely unused, it
readily returns as an obvious "improvement" — which is precisely how this defect arrived, since `001`
specified the fallback deliberately.

## Project Structure

### Documentation (this feature)

```
specs/002-honest-ci-fallback/
├── spec.md          # this feature's contract (the delta)
├── plan.md          # this file
└── checklists/
    └── requirements.md
```

`data-model.md` and `tasks.md` for `002` are added by the implement step. `001`'s `spec.md` and
`tasks.md` are corrected in the same change (see spec §Amendment to 001).

### Source Code (repository root) — files this feature touches

```
plugin.js        # remove mostUrgent; abstention chip; i18n string
test/run.mjs     # negative controls for both new assertions + a positive control
README.md        # document the abstention and correct the deck/fallback note
specs/001-.../   # FR-013, US1#3, assumption, T023 (corrected)
```

## Complexity Tracking

None. This feature reduces code and removes a heuristic; there is no complexity to justify.

## Open gap carried forward

`001`'s Principle VI gap (T043–T046: compact row-shedding, the Gitea fold, command persistence) is
**unaffected and still open**. It is not closed by this feature and must not be reported as closed. It is
the next slice's work.
