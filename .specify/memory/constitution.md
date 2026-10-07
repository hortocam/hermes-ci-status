# Hermes CI Status Constitution

## Core Principles

### I. A Plugin, Never a Patch

The readout MUST reach the application **only** through the published plugin SDK. No Hermes source
file is ever modified, vendored, or forked, and no build step is added to the host application. A
`hermes update` — which runs `git fetch` and `reset --hard` on the source checkout — MUST never be
able to clobber this plugin or require a re-apply step. Everything the plugin owns lives outside the
install tree (the desktop half under `$HERMES_HOME/desktop-plugins/`, the collector under
`$HERMES_HOME/scripts/`).

*Rationale:* the product's whole value is that it costs the user nothing to keep. The moment it
touches the source tree it becomes a patch with a maintenance tax that grows every release, and the
first update that wipes it is indistinguishable from the plugin being broken.

### II. The Published Surface Only

The plugin MUST use only the seams the SDK documents — registered areas, `host.request`,
`ctx.onEvent`, the exported components. It MUST NOT reach into the DOM, import a private module,
depend on internal atom names, or assume the host's markup. Where the app exposes no seam for a
desired surface, that surface is **not available** and the design adapts to the nearest supported
one; the gap is documented, not hacked around.

*Rationale:* an unsupported reach-in is a plugin that breaks on the next markup change and takes the
user's trust with it. A supported seam that looks slightly different is worth more than a DOM
injection that looks perfect today.

### III. One Boundary: Stdlib Collector, One Transport

All filesystem and network work happens in the **collector** — stdlib-only Python (3.9+),
non-interactive, no prompts, no writes, every network call bounded by a timeout. The plugin performs
**no** filesystem or network I/O itself: it invokes the collector through the desktop's own
`shell.exec` RPC and renders the one JSON document that comes back. The document's shape is a
contract, versioned with the plugin and asserted by the harness.

*Rationale:* one boundary to audit and one safety model inherited from the app beats two
half-boundaries. The app's `shell.exec` door already carries the host's permission story; borrowing
it is why this plugin needs no privileged capability of its own.

### IV. Read-Only and Non-Destructive (NON-NEGOTIABLE)

Nothing here writes to a repository, a pull request, a branch, or a forge. No secrets — tokens, keys,
credentials — are printed, logged, echoed in tooltips, or included in the JSON document. The
readout **reports**; it never gates, blocks, or acts. Token material is read only from the
environment or the CLI's own store, and only by the collector.

*Rationale:* a status indicator the user trusts to be inert has to be *provably* inert. The moment a
readout can mutate state or leak a credential, every glance at it carries a risk the user never
signed up for.

### V. Theme Tokens Only — Geometry Is Inline

Colour MUST come from the app's theme variables (`--ui-*`, `--chrome-*`), never a hardcoded hex,
`rgb()`, or `hsl()` value, so the UI repaints with the skin. Layout geometry (widths) MUST ride on
**inline styles**; only classes the host already uses may be applied as classes. Arbitrary-value
utilities and bare `size-*` MUST NOT be relied on for geometry.

*Rationale:* a disk plugin lives outside the app's project tree, so Tailwind v4 — which emits a rule
only for classes it finds while scanning source — never sees it. An arbitrary-value utility compiles
to nothing and silently collapses, which is exactly how an earlier table acquired a header whose
labels bunched at ~50px while the data spread the full width. Geometry that no build step can drop is
the fix; the rule is not a style preference, it is load-bearing.

### VI. The Harness Is the Gate (NON-NEGOTIABLE)

TDD is mandatory: a failing assertion exists before the code that satisfies it (red → green →
refactor). Every non-trivial assertion MUST be **verified to fail against the bug it was written
for** — a negative control, not merely a green run. The harness MUST stay runnable with nothing but
Node (`node test/run.mjs`): no `npm install`, no dependencies, no build. It stubs the SDK and
executes the real plugin, so a `jsx()` call referencing an unimported identifier throws exactly as it
would in the app.

*Rationale:* this plugin has three times shipped a wrong **assumption** rather than a coding error —
that `min-w-*` applied, that `$currentCwd` tracked focus, that `statusCheckRollup.contexts` was
populated. Each was invisible to inspection and obvious to a test. An assertion never seen to fail
is a second description of the code, not a test of it.

### VII. Tolerant by Construction

An unreachable forge, a repo with no remote, a truncated response, a missing CLI, or a broken
response from one repository MUST be reported in words and MUST NOT crash the sweep or blank the
surface. The vocabulary is **total**: every state maps to a rendered result, so an unknown state
still paints as *something* rather than an invisible chip. A failure of one part never hides the
health of the rest.

*Rationale:* this is a thing on a status bar, watched at a glance. A readout whose own failure mode is
a blank or a raw parser error is worse than no readout, because silence reads as "nothing is wrong".

### VIII. Documented Surface

Every SDK area, collector flag, and configuration key the project uses MUST be documented in the
README in the **same change** that introduces it. The README's layout table is part of the product
and MUST stay true to the tree. A new capability without its documentation is incomplete work.

*Rationale:* the README is how a stranger installs this on a machine that is not the author's, and it
is the only map of which half goes where. Undocumented surface is surface nobody else can use.

## Additional Constraints

- **Stack.** The desktop half is plain **ESM loaded uncompiled** — UI is `jsx()` / `jsxs()` **calls**,
  not JSX syntax, and only `@hermes/plugin-sdk`, `react` and `react/jsx-runtime` resolve as imports.
  The collector is **stdlib-only Python, 3.9+**. The test harness is Node (the app's engine floor is
  Node 22). No bundler, no transpiler, no `package.json`.
- **Transport budget.** The app's `shell.exec` RPC keeps only the **last 4000 characters** of a
  command's stdout. A full sweep of a real checkout tree does not fit, so the sweep has a `--compact`
  mode sized to the budget and per-check detail is a second, narrower call. Overflow MUST be handled
  by shedding and disclosing, never by silently returning JSON the client cannot parse.
- **Naming contract.** The plugin `id`, the `desktop-plugins/` folder name, and the repository name
  are the same string (`hermes-ci-status`). The loader keys on `id`, and "Install from Git" derives
  the folder name from the repo name — a drift between them is a silent no-load.
- **Distribution.** Public repository, MIT licensed. Installable from a Git URL. Both halves are
  documented with their target machine, because the desktop half belongs to the machine running the
  app and the collector to the machine running the backend.
- **Prohibited.** Direct pushes to `main`; force-pushes to `main`; hardcoded colour; DOM reach-in;
  arbitrary-value Tailwind utilities relied on for geometry; committing tokens or machine-local
  state; merging without a clean review (see below); fabricated evidence of a run that did not happen.

## Development Workflow & Quality Gates

- **Spec-first.** No implementation code for a change until that change's `spec.md`, `plan.md` and
  `tasks.md` exist. The **spec** and **plan** are human checkpoints: the project owner approves each
  before implementation runs.
- **GitHub Flow.** One change per branch (`NNN-feature-name` from Spec Kit numbering, or
  `wt/<description>` for agent tasks). `main` is protected: PR required, **1 approving review**, the
  CI status checks required and strict, force pushes and deletions off. Every change to `main` arrives
  as a merged pull request.
- **TDD.** Red before green, per Principle VI. Test and implementation land in the same change.
- **Independent review.** The reviewer MUST come from a **different model lineage** than the author.
  The reviewer runs a Spec Kit converge cycle against the delivered branch and opens the pull request
  only when converge comes back clean.
- **Single merge authority.** The coordinator is the only actor that merges to `main`. Authors and
  reviewers never merge, and no one approves their own work.
- **CI is law.** A red check blocks merge. A local pass is not evidence; the check on the pull request
  is. CI runs the collector's offline selftest on the oldest supported Python, the plugin harness on
  Node 22, and the docs/contract guards.
- **Evidence over summary.** A change is "done" only when verified against the remote: a branch pushed
  for that work, a real open pull request, CI green, a clean converge. Worker self-reports are claims,
  not proof.

## Governance

This constitution supersedes other practices, conventions, and instructions in this repository. Where
a conflict exists, this document wins and the other artefact is corrected.

- **Amendments.** Amendments **extend** the document; they never replace it. History stays present in
  every version, and every amendment records its **Why** so the reasoning travels with the rule.
- **Adoption.** There is no ratification hurdle in a one-human, many-agent shop: an amendment is
  adopted when the project owner approves it.
- **Versioning.** MAJOR: a principle is removed or redefined. MINOR: a principle or section is added,
  or guidance is materially expanded. PATCH: clarifications, wording, typos.
- **Compliance.** Every pull request verifies compliance with these principles; the plan's
  Constitution Check is the gate, and any violation is justified in Complexity Tracking or the change
  does not proceed. Complexity MUST be justified against a simpler alternative that was rejected and
  why.
- **Runtime guidance.** `specs/` holds the feature specifications that refine this document; the
  README is the user-facing guide; `.specify/memory/constitution.md` is this document and the only
  authoritative copy.

**Version**: 1.0.0 | **Ratified**: 2026-10-06 | **Last Amended**: 2026-10-06
