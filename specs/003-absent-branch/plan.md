# Implementation Plan: Absent-Upstream Branch Must Not Read as Drift

**Branch**: `003-absent-branch` | **Date**: 2026-10-07 | **Spec**: [spec.md](./spec.md)

**Baseline note**: a delta on `001`/`002` (`main` @ `3887644`). No architectural change: `headMatches`
gains a third state, and three places that handle it must stop coercing it to a boolean.

## Summary

Make `headMatches` a genuine **tri-state** and stop treating *"cannot determine"* as *"drifted"*.

Three edits, all small, all in existing code:

1. **Collector, GitHub path** — when the branch resolves to no commit, report `headMatches: null`.
2. **Collector, Gitea path** — same shape, same fix (the defect is forge-independent).
3. **Plugin, compact projection** — preserve `null` instead of `bool(...)`.

The UI needs no change to its *render* logic, which already gates the badge on `=== false`; it does need
the absent state described in words (FR-005).

## Technical Context

**Language/Version**: Collector — Python 3.9+ (unchanged). Desktop — plain ESM (unchanged).

**Primary Dependencies**: unchanged. **Storage**: none. 

**Testing**: `python3 ci_status.py --selftest` gains tri-state coverage (offline, in CI on 3.9 and 3.13);
`node test/run.mjs` gains a fixture of the exact reproduced state.

**Scope**: one field's semantics across two collectors paths and one projection, plus assertions.

## Constitution Check

*GATE: re-checked after design.*

| Principle | Status | Note |
| --- | --- | --- |
| I. A plugin, never a patch | ✅ | Both halves stay outside the install tree. |
| II. The published surface only | ✅ | No new SDK surface; no DOM reach-in. |
| III. One boundary | ✅ | The fix stays in the collector; the plugin only stops destroying the value in transit. |
| IV. Read-only, no secrets | ✅ | Nothing writes; no token is touched. |
| V. Theme tokens; inline geometry | ✅ | No styling change. |
| VI. Harness is the gate | ✅ | SC-001…SC-004, each negative-controlled; the collector rule also lands in `--selftest` so CI enforces it offline. |
| VII. Tolerant by construction | ✅ | **Strengthened**: an unresolvable head becomes a *named* state rather than a false one, which is the same move `002` made for the workspace. |
| VIII. Documented surface | ✅ | README's caveats gain the absent-upstream behaviour; `001`'s FR-007 and Key Entities are refined in the same change. |

**No violations.** No Complexity Tracking entry: this *removes* a coercion rather than adding a concept.

## Design

### The tri-state

| Value | Meaning | Badge? |
| --- | --- | --- |
| `true` | local head resolved and equals the PR's head | no |
| `false` | local head resolved and **differs** from the PR's head | **yes — drift** |
| `null` | local head **could not be resolved** (no upstream ref); no comparison was made | no |

The critical property: `null` is **not** a softened `false`. It asserts that no comparison happened,
which is why the badge must not fire.

### Why not "use the PR's head when the branch is absent"

That is the tempting shortcut and it is wrong: it would make a genuinely drifted branch *look aligned*
whenever the lookup failed, converting a loud false positive into a silent false negative. A warning that
cannot fire is worse than one that fires wrongly — so the comparison stays honest and its *absence* is
reported instead.

### Where the empty head comes from

`object(expression: "<branch>")` resolves a branch **by name**; with the remote ref deleted it returns
`null`. `head_sha` is therefore `""`, and `bool(head_sha)` folds that into `false`.

Detection is straightforward: a `probe` already knows whether the upstream ref exists. Simplest correct
rule — `headMatches` is `None` whenever `head_sha` is empty, and the comparison runs only when it is not.

### The projection is not incidental

`_compact_pr` currently does `"headMatches": bool(pr.get("headMatches"))`, which maps `None → False`. A
collector-only fix would therefore be **invisible on the chip** — the very surface the defect was
reported on — while passing every collector-level test. This is why SC-002 asserts the projection
directly rather than trusting the collector's output.

## Project Structure

```
specs/003-absent-branch/{spec,plan,tasks}.md + checklists/requirements.md
ci_status.py        three edits + selftest coverage
plugin.js           describe the absent state (FR-005)
test/run.mjs        fixture of the reproduced state + projection assertion
README.md           caveats
specs/001-.../      FR-007, Key Entities, Edge Cases refined
```

## Complexity Tracking

None. The change deletes a coercion and adds a third state to a field that already needed one.
