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
  const cwd = useValue(host.state.cwd)
  const generation = useValue($generation)

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
        className:
          'group flex items-center gap-2 border-b border-(--ui-stroke-tertiary) px-3 py-1.5 hover:bg-(--chrome-action-hover)',
        children: [
          jsx('button', {
            'aria-expanded': expanded,
            'aria-label': `${expanded ? 'Collapse' : 'Expand'} ${repo.name}`,
            className:
              'flex size-4 shrink-0 items-center justify-center text-(--ui-text-quaternary) hover:text-foreground',
            onClick: () => {
              haptic('tap')
              onToggle(repo.path)
            },
            type: 'button',
            children: jsx(Codicon, { name: expanded ? 'chevron-down' : 'chevron-right', size: '0.8rem' })
          }),
          jsx(StatusDot, { tone: style.tone }),
          jsx('span', { className: 'min-w-[8rem] shrink-0 truncate font-medium', children: repo.name }),
          jsx('span', {
            className: cn('min-w-[9rem] max-w-[14rem] shrink-0 truncate font-mono text-[0.7rem]', style.colour),
            title: repo.branch,
            children: repo.branch || '(detached)'
          }),
          jsx('span', {
            className: 'w-[11rem] shrink-0 truncate text-[0.7rem] text-(--ui-text-tertiary)',
            children: countsLabel(branch || repo)
          }),
          jsxs('span', {
            className: 'flex min-w-0 flex-1 items-center gap-1.5',
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
          jsx('span', { className: 'shrink-0 text-[0.65rem] text-(--ui-text-quaternary)', children: repo.host }),
          jsxs('span', {
            className:
              'flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100',
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
                  // Column header, so the two free-text columns cannot be
                  // mistaken for one another.
                  jsxs('div', {
                    className:
                      'flex shrink-0 items-center gap-2 border-b border-(--ui-stroke-tertiary) px-3 py-1 text-[0.6rem] font-semibold uppercase tracking-wider text-(--ui-text-quaternary)',
                    children: [
                      jsx('span', { className: 'size-4 shrink-0' }),
                      jsx('span', { className: 'size-1.5 shrink-0' }),
                      jsx('span', { className: 'min-w-[8rem] shrink-0', children: t('colRepo') }),
                      jsx('span', { className: 'min-w-[9rem] shrink-0', children: t('colBranch') }),
                      jsx('span', { className: 'w-[11rem] shrink-0', children: t('colChecks') }),
                      jsx('span', { className: 'min-w-0 flex-1', children: t('colPr') }),
                      jsx('span', { className: 'shrink-0', children: t('colForge') })
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
        colForge: 'Forge',
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
