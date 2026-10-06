# hermes-ci-status

A **CI status readout** for the [Hermes Agent](https://github.com/NousResearch/hermes-agent)
desktop app: the check state (and pull request) of the branch each of your
checkouts is actually on, as a RAG dot in the status bar and a browsable page.

If you have used Claude Code's cloud sessions, you have seen a branch, its
context folders, and a CI indicator in the UI. Hermes already surfaces the branch
and the working directory — the composer's coding row does that today. What it
does **not** show anywhere is the CI state of the branch you are on. This plugin
adds exactly that third panel.

```
  ● understudy   wt/slice-2-handoff   #18   ⟳ Running
```

## Why this is a plugin, not a patch

Hermes Desktop is contribution-driven: every surface in the window — panes,
routes, status-bar items, palette commands — registers into one central registry,
and core registers its surfaces exactly the way a plugin does. This plugin writes
into that same registry through the published `@hermes/plugin-sdk`. It touches
**no Hermes source file**, so `hermes update` cannot clobber it and there is
nothing to re-apply after an upgrade.

Concretely, the two halves live outside the install tree and are never rewritten
by an update:

| Piece | Lives at | Owned by |
| --- | --- | --- |
| Desktop half (UI) | `$HERMES_HOME/desktop-plugins/hermes-ci-status/plugin.js` | you |
| Collector | `$HERMES_HOME/scripts/ci_status.py` | you |

`hermes update` operates on the source checkout (`git fetch` + fast-forward,
`reset --hard origin/<branch>` at worst) and never walks the home directory. The
plugin root is an app-level, user-writable folder the loader watches; the update
path has no reference to it at all.

## What you get

**Status-bar chip** — the repo under the focused chat's workspace, its branch, a
RAG dot for its check state, and the branch's PR. Click to open the page.

**Full page** (sidebar → **CI**, or `/ci`) — one row per repo:

| | Repository | Branch | Checks | Pull request | Forge |
| --- | --- | --- | --- | --- | --- |
| ● | understudy | `wt/slice-2-handoff` | 1 running | ⟳ #18 `review` | github |
| ● | kalshi-dashboard | `main` | 1 passed | — | github |
| ● | soundscape-factory | `main` | 1 failed | — | gitea |

Expand a row to see every check by name, its conclusion, and a link to the run.

RAG language, mapped onto Hermes' own tones:

| State | Meaning |
| --- | --- |
| 🟢 `success` | every check passed |
| 🔴 `failure` | at least one check failed or errored |
| 🟠 `pending` | checks queued or in progress (**red and pending beat green**) |
| ⚪ `neutral` | only skipped/neutral checks |
| ⚪ `none` | no checks reported on this head |
| ⚪ `unknown` | the forge could not be reached — the reason is in the tooltip |

Extra signals the chip and rows carry: `review` (a review is required),
`conflict` (the PR is not mergeable), and `sha drift` — the PR's head has moved
past your checkout, i.e. the CI you are looking at is somebody else's commit.

## How it works

```
┌─────────────────────────────┐        ┌──────────────────────────────┐
│ Hermes Desktop (your Mac)   │        │ Hermes backend (this host)   │
│                             │  RPC   │                              │
│ plugin.js  ─── shell.exec ──┼───────►│ ci_status.py                 │
│   chip + /ci page           │        │   ├── git (branch, remote)   │
└─────────────────────────────┘        │   ├── gh  (GitHub)           │
                                       │   └── REST (Gitea)           │
                                       └──────────────────────────────┘
```

The plugin does no filesystem or network work of its own. It invokes the
collector through the desktop's own `shell.exec` RPC — inheriting that door's
safety model — and renders the JSON that comes back. The collector is stdlib-only
Python that shells out to `git` and `gh` and talks to Gitea over `urllib`.

**One constraint shapes the whole transport.** `shell.exec` keeps only the *last
4000 characters* of a command's stdout. A full sweep of a real `~/projects` tree
does not fit, so the collector has a `--compact` mode that fits inside the
budget, and per-check detail is a second, narrower `--repo <path>` call. If a
response is still too large the plugin says so in plain words rather than
reporting a JSON syntax error.

## Install

**1. The collector** goes on the machine that runs the **backend** (where your
repos are checked out):

```bash
mkdir -p ~/.hermes/scripts
cp ci_status.py ~/.hermes/scripts/ci_status.py
chmod +x ~/.hermes/scripts/ci_status.py
~/.hermes/scripts/ci_status.py --selftest          # offline, should print "selftest ok"
~/.hermes/scripts/ci_status.py                     # a human-readable sweep
```

**2. The plugin** goes on the machine running the **desktop app** — that is where
the loader reads `desktop-plugins/` from. Same machine in the common local case:

```bash
mkdir -p ~/.hermes/desktop-plugins/hermes-ci-status
cp plugin.js ~/.hermes/desktop-plugins/hermes-ci-status/plugin.js
```

Then in the app: **⌘K → Reload desktop plugins**. The folder name must equal the
plugin `id` (`hermes-ci-status`).

> **Remote backends:** the desktop half is app-level and is read from the *local*
> Electron process, never the remote host. Put `plugin.js` on the machine running
> the app, and `ci_status.py` on the machine running the backend. Nothing needs
> to be copied between them.

### Or install from this repo

The desktop can install a desktop-only plugin straight from a Git URL — this repo
is laid out for it (a root `plugin.js`, repo name = plugin id). In the app:
**Capabilities → Plugins → Install from Git**, or visit:

```
hermes://plugin/install?repo=OWNER/hermes-ci-status&enable=1
```

If the plugin has to live on a *different* machine from the one you install on,
copy `plugin.js` across by hand as in step 2.

## Configuration

`~/.hermes/ci-status/config.json` — every field optional:

```json
{
  "repos": ["/absolute/path/to/a/repo"],
  "auto_scan": true,
  "scan_root": "~/projects",
  "forges": { "git.example.com": "https://git.example.com" },
  "tea_config": "~/.config/tea/config.yml"
}
```

- `repos` — always watched, in addition to anything discovery finds.
- `auto_scan` (default `true`) — union in the immediate git children of `scan_root`.
- `scan_root` (default `~/projects`) — where to look.
- `forges` — pin a Gitea API base per host, when autodetection gets it wrong.
- `tea_config` — where to read `tea` logins from, if not the default.

The plugin reads none of this; it only needs to know how to *invoke* the
collector, which is editable at runtime under the page's ⚙ gear and persisted
per plugin.

### Forges

- **GitHub** — via the `gh` CLI. It must be installed and authenticated
  (`gh auth status`). Check rollups are read with a single GraphQL query per
  branch, folding check *suites* into job-level results.
- **Gitea** — via its REST API. A token is read from `GITEA_TOKEN` or, failing
  that, from the `tea` CLI's own login store. Gitea's *git* host and its *API*
  host are often different addresses (a reverse proxy in front of a LAN
  service); the collector tries the configured value, every `tea` login, the
  remote host, then the usual dev port, and keeps the first that answers.

A repo with no `origin` remote is reported as **skipped**, not failed — a scratch
checkout is not a broken pipeline.

## A note for anyone extending this

**Column widths are inline styles, not Tailwind classes — this is deliberate, and
copying the usual "just use a class" instinct here will break the table.**

The desktop builds its stylesheet with Tailwind v4, which emits a rule only for
classes it finds while scanning source. A disk plugin lives *outside* the app's
project tree (`$HERMES_HOME/desktop-plugins/`), and the build never scans it. So
from inside a plugin:

- **Arbitrary-value geometry has no rule at all.** `w-[11.5rem]` compiles to
  nothing, and the element silently falls back to content-sizing. This is how an
  early version of this table ended up with a header whose labels bunched at
  ~50px while the data spread the full width.
- **Only classes core already uses are safe** — the `text-[0.7rem]` scale,
  `flex-1`, `min-w-0`, `truncate`, `gap-2`, `shrink-0`, and so on. Core uses those
  in dozens of files, so their rules exist in the shipped stylesheet.
- **A bare `size-*` is worse still**: it is an inline box, and `display: inline`
  ignores width/height, so it collapses to zero.

Geometry therefore rides on inline styles (`COLUMNS`, near the top of
`plugin.js`), which no build step can drop. Typography and layout verbs stay
classes. `test/run.mjs` enforces the split: it fails if a cell sizes itself with
a class in the geometry namespace, and if a header and row disagree about a
column. Both rules are verified to fail against the bugs they were written for.

## Development

No build step, no `npm install`, no dependencies. The plugin is plain ESM that
the app loads uncompiled, so:

- UI is `jsx()` / `jsxs()` **calls**, not JSX syntax.
- Only `@hermes/plugin-sdk`, `react` and `react/jsx-runtime` resolve as imports.

```bash
node test/run.mjs          # plugin harness — stubs the SDK, executes the real plugin
python3 ci_status.py --selftest   # collector unit checks, no network
```

The harness copies `plugin.js` into a scratch dir with its three import
specifiers rewritten to local stubs, then imports it for real. That means the
plugin's own top-level code, `register()` and every component actually execute —
a `jsx()` call referencing an identifier that was never imported throws exactly
as it would in the app. It has already earned its keep, catching a
`repo.headSha` / `branch.headSha` mix-up that read `undefined` and rendered
nothing.

## Layout

```
plugin.js                 the desktop half — the whole UI, one file
ci_status.py              the collector — stdlib only
test/run.mjs              plugin harness (node, no deps)
test/harness-sdk.mjs      SDK stub + collector fixtures
examples/config.json      a config you can copy into ~/.hermes/ci-status/
```

## Caveats

- **The chip follows the focused session's workspace.** It matches `cwd` against
  the watched repo roots; on a workspace belonging to no watched repo it falls
  back to the repo with the most urgent CI and *says* that it is doing so.
- **The collector polls forges on a timer.** The sweep refetches every 30s while
  a surface is mounted, and React Query dedupes the chip and the page into one
  call. Each repo costs a couple of forge round-trips per sweep.
- **Read-only.** Nothing here writes to a repository, a PR, or a forge. It is a
  readout, not a gate — Hermes' own Kanban PR-acceptance gate is a separate,
  much stricter thing.
- Not affiliated with Nous Research. MIT licensed.
