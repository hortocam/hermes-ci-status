# Implementation Plan: CI Status Readout

**Branch**: `001-ci-status-readout` | **Date**: 2026-10-06 | **Spec**: [spec.md](./spec.md)

**Baseline note**: this plan documents the architecture of the **already-merged** implementation
(`main` @ `f46c299`), reconstructed from the code, so that future slices plan against a recorded
design rather than a remembered one.

## Summary

Two halves, one boundary. A **collector** (`ci_status.py`, stdlib-only Python) does all git and forge
work on the machine that hosts the backend and emits a single JSON document. A **desktop plugin**
(`plugin.js`, plain ESM) renders that document as a status-bar chip and a browsable page, reaching the
collector only through the app's own `shell.exec` RPC.

The design is dominated by three host facts, each of which the code has already been burned by:

1. **No build step** — the plugin is loaded uncompiled, so UI is `jsx()` calls and geometry must be
   inline styles (Tailwind never scans a disk plugin).
2. **A 4000-character transport ceiling** on `shell.exec` stdout — hence `--compact`, row-shedding and
   per-repo detail as a second call.
3. **The app's cwd atom is not per-session** — the chip must follow `session.info` events, keyed by
   session id, rather than reading the app's live cwd alone.

## Technical Context

**Language/Version**: Desktop — JavaScript, plain ES modules (Node engine floor from the app, 22+).
Collector — Python 3.9+ (CI matrix pins the floor at 3.9 and the present at 3.13).

**Primary Dependencies**: Desktop — `@hermes/plugin-sdk`, `react`, `react/jsx-runtime` (all provided by
the host). Collector — **standard library only**.

**Storage**: none. The plugin persists exactly one value (the collector command) through the host's
plugin storage; the collector writes nothing.

**Testing**: `node test/run.mjs` — a self-contained harness that rewrites the plugin's three import
specifiers to local stubs, imports the real module, and asserts on registered surfaces, rendered trees
and the transport. `python3 ci_status.py --selftest` — offline unit checks with no network.

**Target Platform**: The Hermes desktop app (Electron, macOS/Linux/Windows) for the UI; any host
running the backend with `git` and (for GitHub) the `gh` CLI.

**Project Type**: a distributable **desktop plugin** — two files plus a test harness, installed from a
Git URL or by copying two files to their two homes.

**Performance Goals**: a sweep of a realistic checkout tree (9+ repos) completes within bounded call
timeouts and fits the 4000-character transport budget in compact mode.

**Constraints**: read-only; no third-party Python dependency; no build step; theme tokens for colour;
inline styles for geometry; a total RAG vocabulary so no state renders invisibly.

**Scale/Scope**: one user, one machine, a handful to a few dozen repositories.

## Constitution Check

*GATE: re-checked after design.*

| Principle | Status | Note |
| --- | --- | --- |
| I. A plugin, never a patch | ✅ | No Hermes source file is touched; both halves live outside the install tree. |
| II. The published surface only | ✅ | Uses `routes`, `sidebarNav`, `palette`, `statusBar.right`, `host.request`, `ctx.onEvent`. No DOM reach-in. The deck gap is documented, not hacked. |
| III. One boundary | ✅ | All I/O in the collector; the plugin only calls it. |
| IV. Read-only, no secrets | ✅ | Verified: nothing writes; no token is emitted. |
| V. Theme tokens; inline geometry | ✅ | Enforced by a CI guard (no hardcoded colour) and by the harness (geometry not applied as a class). |
| VI. Harness is the gate | ⚠️ partial | The harness carries assertions for the three historical defects, each verified to fail against its bug. **Gap:** see Complexity Tracking. |
| VII. Tolerant by construction | ✅ | Forge failure, no-remote, truncation and per-repo exceptions all report in words. |
| VIII. Documented surface | ✅ | README documents both halves, install, config, SDK seams and the deck boundary. |

## Project Structure

### Documentation (this feature)

```
specs/001-ci-status-readout/
├── spec.md          # the baseline contract (this feature)
├── plan.md          # this file
├── data-model.md    # the JSON document + entities
├── checklists/
│   └── requirements.md
└── tasks.md         # the phased task breakdown (complete — baseline)
```

### Source Code (repository root)

```
plugin.js                 # the desktop half — the whole UI, one file
ci_status.py              # the collector — stdlib only
test/
  run.mjs                 # plugin harness (node, no deps)
  harness-sdk.mjs         # SDK stub + collector fixtures
examples/config.json      # a config to copy into ~/.hermes/ci-status/
.github/workflows/ci.yml  # collector (3.9, 3.13) · plugin harness · docs guards
README.md                 # install, config, design notes
```

**Structure Decision**: a flat two-file layout, deliberately. The plugin loader reads one file from a
folder named for the plugin `id`, and the collector is copied to a scripts directory by hand; neither
has a package boundary to gain from, and a `package.json` would break the "no build step" promise the
CI explicitly guards. Tests live in `test/` because they are shipped with the repo, not installed.

## Complexity Tracking

| Item | Why | Simpler alternative rejected | 
| --- | --- | --- |
| Two output modes (`--json` and `--json --compact`) | The transport keeps only the last 4000 chars, so a full sweep cannot cross the boundary intact. | A single mode that pages — rejected: it multiplies round-trips on every poll; compact + a second detail call is one extra call only when a row is expanded. |
| Row-shedding loop in compact mode | A large sweep must still return *parseable* JSON naming every repo with CI. | "Let it truncate" — rejected: the client sees a JSON syntax error and the user learns nothing about which repos were lost. |
| Per-session cwd atom fed by `session.info` | The app deliberately leaves its cwd atom on the previous conversation. | Reading `host.state.cwd` alone — rejected: it produced a chip that appeared frozen on the session you had just left (the reported defect). |
| Inline-style geometry via a `COLUMNS` table | Tailwind never scans a disk plugin, so arbitrary-value utilities have no rule. | Class-based widths — rejected: they silently collapse; this shipped once and produced a header 24px off its columns. |
| GraphQL (not `gh run list`) for GitHub | One query per branch yields the rollup, the suites and the PR together. | Two `gh` invocations — rejected: doubles the process spawns per repo per sweep. |

**Open gap (Principle VI).** The harness asserts the three historical defects, but it does **not**
currently assert: (a) the compact row-shedding loop actually sheds and reports `omitted`; (b) the Gitea
path at all; (c) the settings-persistence round-trip. These are the next slice's TDD work — recorded
here so the gap is owned rather than assumed closed.

## Phase Plan (for the next slice)

- **S1 — Close the harness gap**: negative-controlled tests for row-shedding, the Gitea fold, and
  command persistence (principle VI compliance).
- **S2 — Community-contribution polish**: whatever the owner scopes next, planned in a fresh spec
  directory numbered `002-`.
