/**
 * hermes-ci-status — a CI/RAG readout for the Hermes desktop, driven by the git
 * repos this host actually has checked out.
 *
 * Why it exists: Claude Code's cloud sessions show a branch, its context folders
 * and a CI status colour in the UI. Hermes already surfaces the branch and the
 * cwd (the composer's coding row); this plugin adds the missing third panel —
 * the check state of the branch you are on, plus the PR that branch belongs to.
 *
 * How it gets data: a small stdlib-only collector
 * (`~/.hermes/scripts/ci_status.py`) does the git/forge work and prints one JSON
 * document. The plugin reaches it through the desktop's own `shell.exec` RPC, so
 * it inherits that door's safety model instead of poking at the filesystem
 * itself. `shell.exec` keeps only the last 4000 characters of stdout, which is
 * why the sweep is fetched in `--compact` mode and per-repo detail is a second,
 * narrower call.
 *
 * Configuration: `~/.hermes/ci-status/config.json` (watched repos, scan root,
 * forge base URLs) belongs to the collector. The plugin only needs to know how
 * to invoke it, which is overridable from the page's settings row.
 *
 * Plain ESM, loaded uncompiled — UI is jsx() calls, not JSX syntax. Only
 * `@hermes/plugin-sdk`, `react` and `react/jsx-runtime` resolve.
 */

import {
  Badge,
  Button,
  Codicon,
  CopyButton,
  EmptyState,
  PALETTE_AREA,
  ROUTES_AREA,
  SIDEBAR_NAV_AREA,
  STATUSBAR_AREAS,
  Separator,
  Skeleton,
  StatusDot,
  Tip,
  atom,
  cn,
  haptic,
  host,
  usePluginI18n,
  useQuery,
  useValue
} from '@hermes/plugin-sdk'
import { useMemo, useState } from 'react'
import { jsx, jsxs } from 'react/jsx-runtime'

const ID = 'hermes-ci-status'
const PAGE_PATH = '/ci'

/**
 * THE column metrics for the CI table — shared by the header and every row, so
 * the two can never drift apart.
 *
 * GEOMETRY IS INLINE, NOT TAILWIND — this is load-bearing, do not "tidy" it
 * back into classes. A disk plugin lives outside the app's project tree, and
 * the desktop builds its stylesheet with Tailwind v4, which emits a rule only
 * for classes it finds while scanning source. It never scans
 * `$HERMES_HOME/desktop-plugins/`, so from a plugin's point of view:
 *
 *   - arbitrary-value utilities (`w-[11.5rem]`) have NO RULE AT ALL — they
 *     silently do nothing, which is why the first version of this table had a
 *     header whose labels bunched at ~50px while the data spread the full width;
 *   - only classes CORE also uses (the `text-[0.7rem]` scale, `flex-1`,
 *     `min-w-0`, `truncate`, `gap-2`, …) have real CSS and are safe.
 *
 * Widths are geometry, so they ride on inline styles, which no build step can
 * drop. Each entry is `{ className?, style? }`; use `colProps()` to apply one.
 */
const COLUMNS = {
  expander: { style: { flex: 'none', width: '1rem' } },
  dot: { style: { flex: 'none', width: '0.375rem' } },
  // Definite widths, and on the CELL rather than the content: a cell sized by
  // its content lets one long repo name shove that row's later columns right.
  repo: { style: { flex: 'none', width: '11.5rem' } },
  branch: { style: { flex: 'none', width: '10rem' } },
  checks: { style: { flex: 'none', width: '11rem' } },
  pr: { style: { flex: '1 1 0%', minWidth: 0 } },
  // The forge host, right-aligned because it is the last TEXT column — the
  // label sits flush right with the values beneath it.
  forge: { style: { flex: 'none', width: '3.25rem', textAlign: 'right' } },
  // The hover-revealed remote buttons own their own column. Without this the
  // row carried one more cell than the header, so the row's forge text ended
  // ~55px short of the right edge while the header's label sat flush against
  // it — the misalignment this column exists to fix.
  actions: { style: { flex: 'none', width: '4.5rem' } }
}

/** A COLUMNS entry merged with extra classes — the one way to apply a column. */
const colProps = (key, extraClass) => ({
  className: cn(COLUMNS[key].className, extraClass),
  style: COLUMNS[key].style
})

/** The row gap, matched by the header. `gap-2` between columns, and the row
 *  wraps its PR cell contents in `gap-1.5` internally. */
const ROW_GAP = 'gap-2'

/** Defaults for the collector invocation. Overridable at runtime through the
 *  page's settings row, because "where is python" on somebody else's machine is
 *  not a thing this plugin can assume. */
const DEFAULT_COMMAND = 'python3 $HOME/.hermes/scripts/ci_status.py'

/** RAG → the app's tone vocabulary. Kept total: an unknown state must still
 *  render as *something*, never as an invisible chip. */
const RAG = {
  success: { tone: 'good', colour: 'text-(--ui-green)', icon: 'pass-filled', label: 'Passing' },
  failure: { tone: 'bad', colour: 'text-(--ui-red)', icon: 'error', label: 'Failing' },
  pending: { tone: 'warn', colour: 'text-(--ui-orange)', icon: 'sync', label: 'Running' },
  neutral: { tone: 'muted', colour: 'text-(--ui-text-tertiary)', icon: 'circle-outline', label: 'Neutral' },
  none: { tone: 'muted', colour: 'text-(--ui-text-quaternary)', icon: 'circle-slash', label: 'No checks' },
  unknown: { tone: 'muted', colour: 'text-(--ui-text-tertiary)', icon: 'question', label: 'Unknown' }
}

const rag = state => RAG[state] || RAG.unknown

const PR_RAG = {
  open: { colour: 'text-(--ui-green)', icon: 'git-pull-request', label: 'Open' },
  merged: { colour: 'text-(--ui-purple)', icon: 'git-merge', label: 'Merged' },
  closed: { colour: 'text-(--ui-red)', icon: 'git-pull-request-closed', label: 'Closed' },
  draft: { colour: 'text-(--ui-text-quaternary)', icon: 'git-pull-request-draft', label: 'Draft' }
}

const prRag = pr => (pr && pr.draft ? PR_RAG.draft : PR_RAG[(pr && pr.state) || ''] || PR_RAG.open)

// ── plugin-local state ───────────────────────────────────────────────────────

/** Collector command line, persisted per plugin. */
const $command = atom(DEFAULT_COMMAND)
/** Repo root path whose check detail is expanded, or null. */
const $expanded = atom(null)
/** Bumped to force a refetch of everything. */
const $generation = atom(0)

const COMMAND_KEY = 'command'

/** Set by `register` so components can persist without prop-drilling. */
let pluginCtx = null

function loadStoredCommand(ctx) {
  try {
    const saved = ctx.storage.get(COMMAND_KEY, '')
    if (typeof saved === 'string' && saved.trim()) {
      $command.set(saved.trim())
    }
  } catch {
    // Storage unavailable (a locked-down host): the default still works.
  }
}

function applyCommand(value) {
  const next = String(value === undefined || value === null ? '' : value).trim() || DEFAULT_COMMAND
  $command.set(next)
  try {
    if (pluginCtx) {
      pluginCtx.storage.set(COMMAND_KEY, next === DEFAULT_COMMAND ? '' : next)
    }
  } catch {
    // Non-fatal: the session keeps the value, the next boot falls back.
  }
  $generation.set($generation.get() + 1)
  haptic('tap')
  host.notify({ kind: 'info', message: 'Collector command updated.' })
}

// ── collector transport ──────────────────────────────────────────────────────

/** The collector command plus our flags. `shell.exec` runs its string under
 *  `shell=True`, so the flags are appended textually — the collector owns the
 *  argument grammar, this owns nothing but the order. */
function collectorCommand(extra) {
  const base = $command.get().trim() || DEFAULT_COMMAND
  return extra ? `${base} ${extra}` : base
}

function parseCollectorJson(stdout) {
  const text = String(stdout || '').trim()
  if (!text) {
    throw new Error('The collector returned no output.')
  }
  // `shell.exec` trims stdout to its last 4000 characters. A payload over that
  // loses its HEAD, so a parse failure here is really "response too large" —
  // say that, rather than report a syntax error nobody can act on.
  try {
    return JSON.parse(text)
  } catch {
    throw new Error(
      'The collector\'s output was cut off in transit: the desktop RPC keeps only the last ' +
        '4000 characters of a command\'s stdout. Narrow the watch list in ' +
        '~/.hermes/ci-status/config.json, or open a single repo to fetch its detail alone.'
    )
  }
}

async function runCollector(extra) {
  const command = collectorCommand(extra)
  const result = await host.request('shell.exec', { command })
  const stdout = (result && result.stdout) || ''
  const stderr = (result && result.stderr) || ''
  const code = result ? result.code : undefined

  if (code !== 0 && !stdout.trim()) {
    throw new Error(stderr.trim() || `The collector exited with code ${code}.`)
  }

  const doc = parseCollectorJson(stdout)
  doc.__stderr = stderr.trim() || ''
  doc.__command = command
  return doc
}

// ── helpers ──────────────────────────────────────────────────────────────────

/**
 * Live ``cwd`` per RUNTIME session id, fed by the gateway's ``session.info``
 * event — the same signal the app itself uses to settle a conversation's
 * workspace after a switch.
 *
 * Why not just ``host.state.cwd``: the app deliberately LEAVES that atom holding
 * the previous conversation's folder when a session row has no recorded cwd (its
 * own comment: "the path is deliberately left in place"), then corrects it from
 * this event a beat later. It is the app's workspace for the pane, not a
 * per-session fact, so reading it alone gave a chip that looked frozen — it kept
 * describing the session you had just left.
 *
 * Keyed by session id rather than a single "focused" value on purpose: a
 * background session emits the same event, and a bare assignment would let one
 * hijack the chip while you looked elsewhere.
 */
const $cwdBySession = atom({})

/** Repo rows worth a glance: skip the ones with no forge at all. */
const visibleRepos = doc => ((doc && doc.repos) || []).filter(r => !r.skipped)

/** The repo whose checkout holds the focused chat's workspace, if we have it.
 *  `host.state.cwd` is the live workspace path; a prefix match keeps the chip
 *  honest even when the chat sits in a subdirectory of the repo. */
function repoForCwd(repos, cwd) {
  const path = String(cwd || '').trim()
  if (!path) {
    return null
  }
  let best = null
  for (const repo of repos) {
    const root = String(repo.path || '')
    if (root && (path === root || path.startsWith(root + '/')) && (!best || root.length > best.path.length)) {
      best = repo
    }
  }
  return best
}

/** Which repo deserves the chip when nothing matches the focused workspace:
 *  worst CI first, but only among repos that actually run checks. */
function mostUrgent(repos) {
  const rank = { failure: 0, pending: 1, success: 2, neutral: 3, none: 4, unknown: 5 }
  return (
    repos
      .filter(r => r.hasCi)
      .slice()
      .sort((a, b) => (rank[a.state] ?? 9) - (rank[b.state] ?? 9))[0] || null
  )
}

function countsLabel(entry) {
  const counts = (entry && entry.n) || {}
  const parts = []
  if (counts.failed) parts.push(`${counts.failed} failed`)
  if (counts.pending) parts.push(`${counts.pending} running`)
  if (counts.skipped) parts.push(`${counts.skipped} skipped`)
  if (counts.passed) parts.push(`${counts.passed} passed`)
  if (!parts.length) {
    return entry && entry.hasCi === false ? 'no pipeline' : 'no checks'
  }
  return parts.join(' · ')
}

function openExternal(url) {
  if (!url) {
    return
  }
  const bridge = globalThis.window && globalThis.window.hermesDesktop
  if (bridge && typeof bridge.openExternal === 'function') {
    void bridge.openExternal(url)
  } else {
    host.notify({ kind: 'error', message: 'This window cannot open external links.' })
  }
}

/** Classify one check's conclusion onto a tone. */
function conclusionTone(conclusion, status) {
  const value = String(conclusion || status || '').toUpperCase()
  if (value === 'SUCCESS') return 'good'
  if (['FAILURE', 'ERROR', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE'].includes(value)) return 'bad'
  if (['SKIPPED', 'NEUTRAL', 'STALE'].includes(value)) return 'muted'
  return 'warn'
}

// ── small components ─────────────────────────────────────────────────────────

/** A clickable icon that opens a forge URL. */
function LinkIcon({ icon, label, url, className }) {
  if (!url) {
    return null
  }
  return jsx(Tip, {
    label,
    children: jsx('button', {
      'aria-label': label,
      className: cn(
        'inline-flex items-center justify-center rounded p-0.5 transition-colors',
        'text-(--ui-text-tertiary) hover:bg-(--chrome-action-hover) hover:text-foreground',
        className
      ),
      onClick: event => {
        event.stopPropagation()
        haptic('tap')
        openExternal(url)
      },
      type: 'button',
      children: jsx(Codicon, { name: icon, size: '0.8rem' })
    })
  })
}

/** The branch's PR as a chip that opens it. */
function PrChip({ pr, showNumber = true }) {
  if (!pr || !pr.n) {
    return null
  }
  const style = prRag(pr)
  const drifted = pr.headMatches === false
  const label =
    `#${pr.n} ${pr.title ? pr.title : ''} — ${style.label}` +
    (drifted ? '\nThis PR\'s head has moved past the branch you are on.' : '')

  return jsx(Tip, {
    label,
    children: jsx('button', {
      'aria-label': `Open pull request #${pr.n}`,
      className: cn(
        'inline-flex shrink-0 items-center gap-0.5 text-[0.625rem] leading-none tabular-nums',
        style.colour,
        'hover:underline'
      ),
      onClick: event => {
        event.stopPropagation()
        haptic('tap')
        openExternal(pr.url)
      },
      type: 'button',
      children: jsxs('span', {
        className: 'inline-flex items-center gap-0.5',
        children: [
          jsx(Codicon, { name: style.icon, size: '0.7rem' }),
          jsx('span', { children: showNumber ? `#${pr.n}` : pr.n }),
          drifted ? jsx(Codicon, { name: 'warning', size: '0.65rem', className: 'opacity-70' }) : null
        ]
      })
    })
  })
}

// ── status-bar chip ──────────────────────────────────────────────────────────

/**
 * The chip: the focused chat's repo, its branch, its CI colour and its PR.
 *
 * It shares a query key with the page, so React Query dedupes the two into one
 * collector call no matter which surface mounted first.
 */
function CiChip() {
  const t = usePluginI18n(ID)
  const focusedId = useValue(host.state.focusedSessionId)
  const cwdBySession = useValue($cwdBySession)
  const liveCwd = useValue(host.state.cwd)
  const generation = useValue($generation)

  // The focused chat's OWN workspace when we have heard it, else the app's live
  // workspace (correct on first load, before any session.info has arrived).
  const cwd = (focusedId && cwdBySession[focusedId]) || liveCwd

  const query = useQuery({
    queryKey: [ID, 'sweep', generation],
    queryFn: () => runCollector('--json --compact'),
    refetchInterval: 30_000,
    staleTime: 10_000,
    retry: 1
  })

  const repos = visibleRepos(query.data)
  const focused = repoForCwd(repos, cwd)
  const fallback = useMemo(() => mostUrgent(repos), [repos])
  const repo = focused || fallback

  if (query.isLoading) {
    return jsx(Tip, {
      label: t('chipLoading'),
      children: jsx('button', {
        className: 'inline-flex h-full items-center px-1.5 text-[0.6875rem] text-(--ui-text-quaternary)',
        type: 'button',
        children: jsx(Skeleton, { className: 'h-2.5 w-16' })
      })
    })
  }

  if (query.isError) {
    const message = query.error && query.error.message ? query.error.message : ''
    return jsx(Tip, {
      label: t('chipError') + (message ? `\n${message}` : ''),
      children: jsx('button', {
        className: 'inline-flex h-full items-center gap-1 px-1.5 text-[0.6875rem] text-(--ui-red)',
        onClick: () => host.navigate(PAGE_PATH),
        type: 'button',
        children: jsxs('span', {
          className: 'inline-flex items-center gap-1',
          children: [jsx(Codicon, { name: 'error', size: '0.7rem' }), 'ci']
        })
      })
    })
  }

  if (!repo) {
    return null
  }

  const style = rag(repo.state)
  const drifted = repo.pr && repo.pr.headMatches === false
  const branchEntry = (repo.branches || {})[repo.branch]
  const label =
    `${repo.name} · ${repo.branch || '(detached)'}\n${style.label} — ${countsLabel(branchEntry || repo)}` +
    (repo.pr ? `\nPR #${repo.pr.n} ${prRag(repo.pr).label}` : '') +
    (drifted ? '\nThis PR\'s head has moved past this checkout.' : '') +
    (focused ? '' : '\nNo repo under this chat\'s workspace — showing the most urgent one.')

  return jsx(Tip, {
    label,
    children: jsx('button', {
      'aria-label': t('chipAria', repo.name),
      className: cn(
        'inline-flex h-full max-w-[19rem] items-center gap-1.5 px-1.5 text-[0.6875rem] transition-colors',
        'text-(--ui-text-tertiary) hover:bg-(--chrome-action-hover) hover:text-foreground'
      ),
      onClick: () => {
        haptic('tap')
        $expanded.set(focused ? repo.path : null)
        host.navigate(PAGE_PATH)
      },
      type: 'button',
      children: [
        jsx(StatusDot, { tone: style.tone }),
        jsx('span', { className: 'max-w-[7rem] truncate text-(--ui-text-secondary)', children: repo.name }),
        repo.branch
          ? jsx('span', {
              className: cn('max-w-[8rem] truncate font-mono text-[0.625rem]', style.colour),
              children: repo.branch
            })
          : null,
        repo.pr && repo.pr.n ? jsx(PrChip, { pr: repo.pr }) : null,
        drifted ? jsx(Codicon, { name: 'warning', size: '0.7rem', className: 'text-(--ui-orange)' }) : null
      ]
    })
  })
}

// ── detail: one repo's checks ────────────────────────────────────────────────

function RepoChecks({ root }) {
  const t = usePluginI18n(ID)
  const generation = useValue($generation)
  const query = useQuery({
    queryKey: [ID, 'repo', root, generation],
    queryFn: () => runCollector(`--json --repo ${JSON.stringify(root)}`),
    enabled: Boolean(root),
    staleTime: 10_000,
    retry: 1
  })

  if (query.isLoading) {
    return jsx('div', {
      className: 'flex flex-col gap-1 px-3 py-2',
      children: [0, 1, 2].map(i => jsx(Skeleton, { className: 'h-3 w-full', key: i }))
    })
  }

  if (query.isError) {
    return jsx('div', {
      className: 'px-3 py-2 text-[0.7rem] text-(--ui-red)',
      children: query.error && query.error.message ? query.error.message : t('errorBody')
    })
  }

  const repo = ((query.data && query.data.repos) || [])[0]
  if (!repo) {
    return jsx('div', { className: 'px-3 py-2 text-[0.7rem] text-(--ui-text-tertiary)', children: 'No data.' })
  }

  const branch = (repo.branches || {})[repo.currentBranch]
  const contexts = (branch && branch.contexts) || []

  if (!contexts.length) {
    const note =
      (branch && branch.error && `Collector error: ${branch.error}`) ||
      (branch && branch.noPipeline && 'No CI pipeline is configured for this repository.') ||
      countsLabel(branch || repo)
    return jsx('div', { className: 'px-3 py-2 text-[0.7rem] text-(--ui-text-tertiary)', children: note })
  }

  // `headSha` is a BRANCH field in the collector's document (each branch has its
  // own head), not a repo field — reading it off the repo silently never renders.
  const headSha = (branch && branch.headSha) || ''
  return jsxs('div', {
    className: 'flex flex-col gap-0.5 px-3 py-2',
    children: [
      ...contexts.map(context => {
        const conclusion = String(context.conclusion || context.status || '').toLowerCase()
        return jsxs(
          'div',
          {
            className: 'flex items-center gap-2 text-[0.7rem]',
            children: [
              jsx(StatusDot, { tone: conclusionTone(context.conclusion, context.status) }),
              jsx('span', {
                className: 'min-w-0 flex-1 truncate font-mono text-(--ui-text-secondary)',
                children: context.name
              }),
              jsx('span', { className: 'shrink-0 text-(--ui-text-quaternary)', children: conclusion || 'pending' }),
              jsx(LinkIcon, { icon: 'link-external', label: 'Open this check on the forge', url: context.url })
            ]
          },
          `${context.name}-${conclusion}`
        )
      }),
      headSha
        ? jsx('span', {
            className: 'pt-0.5 font-mono text-[0.6rem] text-(--ui-text-quaternary)',
            children: `head ${headSha.slice(0, 10)}${branch && branch.truncated ? ' · list truncated' : ''}`
          })
        : null
    ]
  })
}

// ── the page ─────────────────────────────────────────────────────────────────

function CiRow({ repo, expanded, onToggle }) {
  const branch = (repo.branches || {})[repo.branch]
  const style = rag(repo.state)
  const pr = repo.pr
  const drifted = pr && pr.headMatches === false

  return jsxs('div', {
    children: [
      jsxs('div', {
        className: cn(
          'group flex items-center border-b border-(--ui-stroke-tertiary) px-3 py-1.5',
          'hover:bg-(--ui-row-hover-background)',
          ROW_GAP
        ),
        children: [
          jsx('button', {
            ...colProps(
              'expander',
              'flex items-center justify-center text-(--ui-text-quaternary) hover:text-foreground'
            ),
            'aria-expanded': expanded,
            'aria-label': `${expanded ? 'Collapse' : 'Expand'} ${repo.name}`,
            onClick: () => {
              haptic('tap')
              onToggle(repo.path)
            },
            type: 'button',
            children: jsx(Codicon, { name: expanded ? 'chevron-down' : 'chevron-right', size: '0.8rem' })
          }),
          // The dot cell carries the shared width too, so a row whose dot is
          // absent (or a theme where the dot is smaller) still lines up.
          jsx('span', {
            ...colProps('dot', 'flex items-center'),
            children: jsx(StatusDot, { tone: style.tone })
          }),
          jsx('span', {
            ...colProps('repo', 'truncate font-medium'),
            title: repo.name,
            children: repo.name
          }),
          jsx('span', {
            ...colProps('branch', cn('truncate font-mono text-[0.7rem]', style.colour)),
            title: repo.branch,
            children: repo.branch || '(detached)'
          }),
          jsx('span', {
            ...colProps('checks', 'truncate text-[0.7rem] text-(--ui-text-tertiary)'),
            title: countsLabel(branch || repo),
            children: countsLabel(branch || repo)
          }),
          jsxs('span', {
            ...colProps('pr', 'flex items-center gap-1.5'),
            children: [
              pr
                ? jsx(PrChip, { pr })
                : jsx('span', { className: 'text-[0.7rem] text-(--ui-text-quaternary)', children: '—' }),
              pr && pr.review === 'REVIEW_REQUIRED'
                ? jsx(Badge, { size: 'xs', variant: 'warn', children: 'review' })
                : null,
              pr && pr.mergeable === 'CONFLICTING'
                ? jsx(Badge, { size: 'xs', variant: 'destructive', children: 'conflict' })
                : null,
              drifted ? jsx(Badge, { size: 'xs', variant: 'outline', children: 'sha drift' }) : null
            ]
          }),
          jsx('span', {
            ...colProps('forge', 'text-[0.65rem] text-(--ui-text-quaternary)'),
            children: repo.host
          }),
          jsxs('span', {
            ...colProps(
              'actions',
              'flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100'
            ),
            children: [
              jsx(LinkIcon, {
                icon: 'git-pull-request',
                label: 'Open the pull requests on the forge',
                url: repo.url ? `${repo.url}/pulls` : ''
              }),
              jsx(LinkIcon, {
                icon: 'beaker',
                label: 'Open the forge\'s actions view',
                url: repo.url ? `${repo.url}/actions` : ''
              }),
              jsx(LinkIcon, { icon: 'repo', label: 'Open the repository', url: repo.url })
            ]
          })
        ]
      }),
      expanded ? jsx(RepoChecks, { root: repo.path }) : null
    ]
  })
}

function CiSettings() {
  const t = usePluginI18n(ID)
  const command = useValue($command)
  const [draft, setDraft] = useState(command)

  return jsxs('div', {
    className: 'flex shrink-0 flex-col gap-1 border-b border-(--ui-stroke-tertiary) px-3 py-2',
    children: [
      jsx('span', { className: 'text-[0.65rem] text-(--ui-text-tertiary)', children: t('commandLabel') }),
      jsxs('div', {
        className: 'flex items-center gap-1.5',
        children: [
          jsx('input', {
            className: cn(
              'min-w-0 flex-1 rounded border border-(--ui-stroke-secondary) bg-transparent px-2 py-1',
              'font-mono text-[0.7rem] text-(--ui-text-secondary) outline-none focus:border-(--ui-accent)'
            ),
            onChange: event => setDraft(event.target.value),
            spellCheck: false,
            value: draft
          }),
          jsx(Button, {
            onClick: () => applyCommand(draft),
            size: 'sm',
            variant: 'secondary',
            children: t('apply')
          }),
          jsx(Button, {
            onClick: () => {
              setDraft(DEFAULT_COMMAND)
              applyCommand(DEFAULT_COMMAND)
            },
            size: 'sm',
            variant: 'ghost',
            children: t('reset')
          })
        ]
      }),
      jsxs('span', {
        className: 'flex items-center gap-1 text-[0.62rem] text-(--ui-text-quaternary)',
        children: [
          jsx('span', { children: t('configHint') }),
          jsx('code', { className: 'font-mono', children: '~/.hermes/ci-status/config.json' }),
          jsx(CopyButton, {
            appearance: 'icon',
            iconClassName: 'size-3',
            label: t('copyConfigHint'),
            text: '~/.hermes/ci-status/config.json'
          })
        ]
      })
    ]
  })
}

function CiPage() {
  const t = usePluginI18n(ID)
  const cwd = useValue(host.state.cwd)
  const generation = useValue($generation)
  const expanded = useValue($expanded)
  const [showSettings, setShowSettings] = useState(false)

  const query = useQuery({
    queryKey: [ID, 'sweep', generation],
    queryFn: () => runCollector('--json --compact'),
    refetchInterval: 30_000,
    staleTime: 10_000,
    retry: 1
  })

  const doc = query.data
  const repos = visibleRepos(doc)
  const skipped = ((doc && doc.repos) || []).filter(r => r.skipped)
  const focused = repoForCwd(repos, cwd)

  return jsxs('div', {
    className: 'flex h-full flex-col overflow-hidden text-xs',
    children: [
      // Header — title, provenance, and the two controls worth having.
      jsxs('div', {
        className: 'flex shrink-0 items-center gap-2 border-b border-(--ui-stroke-tertiary) px-3 py-2',
        children: [
          jsx(Codicon, { name: 'pulse', size: '0.95rem', className: 'text-(--ui-accent)' }),
          jsx('span', { className: 'font-medium', children: t('pageTitle') }),
          doc
            ? jsx('span', {
                className: 'text-[0.65rem] text-(--ui-text-quaternary)',
                children:
                  `${repos.length} ${t('reposWatched')}` +
                  (doc.ghReady === false ? ' · gh not authenticated' : '') +
                  (doc.omitted && doc.omitted.length ? ` · ${doc.omitted.length} omitted` : '')
              })
            : null,
          jsx('span', { className: 'flex-1' }),
          jsxs('span', {
            className: 'flex items-center gap-1',
            children: [
              jsx(Tip, {
                label: t('settingsTip'),
                children: jsx('button', {
                  'aria-label': t('settingsTip'),
                  className: cn(
                    'inline-flex items-center rounded px-1.5 py-0.5 text-[0.65rem] transition-colors',
                    showSettings
                      ? 'bg-(--chrome-action-hover) text-foreground'
                      : 'text-(--ui-text-tertiary) hover:bg-(--chrome-action-hover) hover:text-foreground'
                  ),
                  onClick: () => setShowSettings(!showSettings),
                  type: 'button',
                  children: jsx(Codicon, { name: 'settings-gear', size: '0.8rem' })
                })
              }),
              jsx(Button, {
                onClick: () => {
                  haptic('tap')
                  $generation.set($generation.get() + 1)
                },
                size: 'sm',
                variant: 'ghost',
                children: jsxs('span', {
                  className: 'inline-flex items-center gap-1',
                  children: [
                    jsx(Codicon, { name: 'refresh', size: '0.8rem', spinning: query.isFetching }),
                    t('refresh')
                  ]
                })
              })
            ]
          })
        ]
      }),

      showSettings ? jsx(CiSettings, {}) : null,

      query.isLoading
        ? jsx('div', {
            className: 'flex flex-col gap-1.5 p-3',
            children: [0, 1, 2, 3].map(i => jsx(Skeleton, { className: 'h-5 w-full', key: i }))
          })
        : query.isError
          ? jsx(EmptyState, {
              description:
                (query.error && query.error.message ? query.error.message + ' ' : '') + t('errorBody'),
              icon: 'error',
              title: t('errorTitle')
            })
          : !repos.length
            ? jsx(EmptyState, { description: t('emptyBody'), icon: 'git-branch', title: t('emptyTitle') })
            : jsxs('div', {
                className: 'flex min-h-0 flex-1 flex-col overflow-hidden',
                children: [
                  focused
                    ? null
                    : jsx('div', {
                        className:
                          'shrink-0 border-b border-(--ui-stroke-tertiary) px-3 py-1 text-[0.65rem] text-(--ui-text-quaternary)',
                        children: t('noWorkspaceMatch')
                      }),
                  // Column header. It shares COLUMNS with every row, so the
                  // labels cannot drift off their columns, and it carries its
                  // own surface + rule so it reads as a header rather than as
                  // one more (bold) row.
                  jsxs('div', {
                    className: cn(
                      'flex shrink-0 items-center border-b border-(--ui-stroke-secondary) bg-(--ui-bg-secondary)',
                      'px-3 py-1 text-[0.6rem] font-semibold uppercase tracking-wider text-(--ui-text-tertiary)',
                      ROW_GAP
                    ),
                    children: [
                      // Spacers are `flex-*`, not inline `size-*`: an inline box
                      // ignores width/height entirely, which is what used to
                      // collapse them to zero and shift every label left.
                      jsx('span', { ...colProps('expander'), 'aria-hidden': 'true' }),
                      jsx('span', { ...colProps('dot'), 'aria-hidden': 'true' }),
                      jsx('span', { ...colProps('repo'), children: t('colRepo') }),
                      jsx('span', { ...colProps('branch'), children: t('colBranch') }),
                      jsx('span', { ...colProps('checks'), children: t('colChecks') }),
                      jsx('span', { ...colProps('pr'), children: t('colPr') }),
                      // "Remotes", not "Forge": the column holds host names
                      // (github / gitea), and "Forge" reads as a button label.
                      jsx('span', { ...colProps('forge'), children: t('colRemotes') }),
                      jsx('span', { ...colProps('actions'), 'aria-hidden': 'true' })
                    ]
                  }),
                  jsx('div', {
                    className: 'min-h-0 flex-1 overflow-y-auto',
                    children: [
                      ...repos.map(repo =>
                        jsx(
                          CiRow,
                          {
                            expanded: expanded === repo.path,
                            onToggle: path => $expanded.set($expanded.get() === path ? null : path),
                            repo
                          },
                          repo.path
                        )
                      ),
                      skipped.length
                        ? jsxs('div', {
                            className: 'flex flex-col gap-0.5 px-3 py-2',
                            children: [
                              jsx(Separator, { className: 'mb-1' }),
                              jsx('span', {
                                className:
                                  'text-[0.6rem] font-semibold uppercase tracking-wider text-(--ui-text-quaternary)',
                                children: t('notWatched')
                              }),
                              ...skipped.map(repo =>
                                jsxs(
                                  'div',
                                  {
                                    className: 'flex items-center gap-2 text-[0.68rem] text-(--ui-text-quaternary)',
                                    children: [
                                      jsx(Codicon, { name: 'circle-slash', size: '0.7rem' }),
                                      jsx('span', {
                                        className: 'min-w-0 flex-1 truncate font-mono',
                                        children: repo.path
                                      }),
                                      jsx('span', { className: 'shrink-0', children: repo.error || 'no forge' })
                                    ]
                                  },
                                  repo.path
                                )
                              )
                            ]
                          })
                        : null
                    ]
                  })
                ]
              })
    ]
  })
}

// ── registration ─────────────────────────────────────────────────────────────

export default {
  id: ID,
  name: 'CI Status',
  register(ctx) {
    pluginCtx = ctx
    loadStoredCommand(ctx)

    // Record each session's live workspace as the gateway reports it. This is
    // what lets the chip follow you between sessions: on a switch, the app
    // repoints its own cwd atom and the gateway emits this event for the session
    // you landed on.
    ctx.onEvent('session.info', event => {
      const sid = event && event.session_id
      const cwd = event && event.payload && event.payload.cwd
      if (sid && typeof cwd === 'string' && cwd) {
        $cwdBySession.set({ ...$cwdBySession.get(), [sid]: cwd })
      }
    })

    ctx.i18n.register({
      en: {
        pageTitle: 'CI status',
        reposWatched: 'repos watched',
        refresh: 'Refresh',
        settingsTip: 'Where the collector lives',
        commandLabel: 'Collector command',
        apply: 'Apply',
        reset: 'Reset',
        configHint: 'Watched repos and forge URLs come from the collector\'s own config:',
        copyConfigHint: 'Copy the config path',
        colRepo: 'Repository',
        colBranch: 'Branch',
        colChecks: 'Checks',
        colPr: 'Pull request',
        colRemotes: 'Remotes',
        notWatched: 'Checked out but not watched',
        noWorkspaceMatch:
          'This chat\'s workspace is not one of the watched repositories — showing every repo instead.',
        emptyTitle: 'No repositories to report on',
        emptyBody:
          'Point the collector at your checkouts: write a `repos` list and a `scan_root` into ' +
          '~/.hermes/ci-status/config.json, then refresh.',
        errorTitle: 'Could not read CI status',
        errorBody: 'The collector did not answer. Check the command under the gear, then refresh.',
        chipLoading: 'Reading CI status…',
        chipError: 'CI status unavailable.',
        chipAria: name => `CI status for ${name} — open the CI page`
      }
    })

    ctx.registerMany([
      {
        area: ROUTES_AREA,
        data: { path: PAGE_PATH },
        id: 'page',
        render: () => jsx(CiPage, {})
      },
      {
        area: SIDEBAR_NAV_AREA,
        data: { codicon: 'pulse', label: 'CI', path: PAGE_PATH },
        id: 'nav'
      },
      {
        area: PALETTE_AREA,
        data: {
          id: `${ID}.open`,
          keywords: ['ci', 'checks', 'build', 'pull request', 'branch', 'github actions'],
          label: 'Open CI status',
          run: () => host.navigate(PAGE_PATH)
        },
        id: 'open'
      },
      {
        area: PALETTE_AREA,
        data: {
          id: `${ID}.refresh`,
          keywords: ['ci', 'checks', 'refresh', 'reload'],
          label: 'Refresh CI status',
          run: () => $generation.set($generation.get() + 1)
        },
        id: 'refresh'
      },
      {
        area: STATUSBAR_AREAS.right,
        id: 'chip',
        order: 160,
        render: () => jsx(CiChip, {})
      }
    ])
  }
}
