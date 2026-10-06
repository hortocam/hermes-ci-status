/**
 * Self-contained stub of `@hermes/plugin-sdk` plus the collector fixtures, for
 * the hermes-ci-status plugin harness.
 *
 * It has NO imports on purpose: the harness copies it beside a rewritten
 * plugin.mjs, and `plugin.mjs → harness-sdk.mjs` must not loop back into the
 * harness driver (a top-level await would then never settle).
 *
 * The stub is deliberately thin — it does not re-implement React Query. The
 * driver sets `control.queryResult` to stand in for `useQuery`'s return, and
 * captures every `options` object so the real `queryFn` the plugin wrote can be
 * invoked directly.
 */

// ── fixtures: the exact shapes ci_status.py emits ────────────────────────────

/** `ci_status.py --json --compact` across a real ~/projects tree. */
export const SWEEP = {
  errors: [],
  generatedAt: 1791230350.2,
  ghReady: true,
  repos: [
    {
      branch: 'wt/slice-2-handoff',
      branches: {
        'wt/slice-2-handoff': { checkState: 'pending', n: { pending: 1, total: 1 }, ok: true, pr: null },
        main: { checkState: 'success', n: { passed: 1, total: 1 }, ok: true, pr: null }
      },
      error: null,
      hasCi: true,
      host: 'github',
      name: 'understudy',
      path: '/home/hermes/projects/understudy',
      pr: {
        draft: false,
        headMatches: true,
        mergeable: 'MERGEABLE',
        n: 18,
        review: 'REVIEW_REQUIRED',
        state: 'open',
        title: 'docs(slice-2): hand-off brief',
        url: 'https://github.com/hortocam/understudy/pull/18'
      },
      skipped: false,
      slug: 'hortocam/understudy',
      state: 'pending',
      url: 'https://github.com/hortocam/understudy'
    },
    {
      branch: 'main',
      branches: { main: { checkState: 'failure', n: { failed: 1, total: 1 }, ok: true, pr: null } },
      error: null,
      hasCi: true,
      host: 'gitea',
      name: 'soundscape-factory',
      path: '/home/hermes/projects/soundscape-factory',
      pr: null,
      skipped: false,
      slug: 'hortocam/soundscape-factory',
      state: 'failure',
      url: 'https://git.hortocam.com/hortocam/soundscape-factory'
    },
    {
      branch: 'main',
      branches: {},
      error: 'no origin remote',
      hasCi: false,
      host: 'none',
      name: 'finance-tracker',
      path: '/home/hermes/projects/finance-tracker',
      pr: null,
      skipped: true,
      slug: '',
      state: 'none',
      url: ''
    }
  ]
}

/** `ci_status.py --json --repo <path>` — full per-check detail. */
export const DETAIL = {
  errors: [],
  generatedAt: 1791230351,
  ghReady: true,
  repos: [
    {
      branches: {
        'wt/slice-2-handoff': {
          branch: 'wt/slice-2-handoff',
          checkState: 'pending',
          contexts: [
            { conclusion: 'SUCCESS', name: 'build', status: 'COMPLETED', type: 'check', url: 'https://x/build' },
            { conclusion: null, name: 'test', status: 'IN_PROGRESS', type: 'check', url: 'https://x/test' }
          ],
          counts: { failed: 0, neutral: 0, passed: 1, pending: 1, skipped: 0, state: 'pending', total: 2 },
          headSha: '0d45bb123771abca18ffd17b36999b7499c5e2e2',
          ok: true,
          pr: null,
          truncated: false
        }
      },
      currentBranch: 'wt/slice-2-handoff',
      defaultBranch: 'main',
      hasCiConfig: true,
      host: 'github',
      name: 'understudy',
      pr: { headMatches: true, n: 18, state: 'open', title: 'brief', url: 'u' },
      root: '/home/hermes/projects/understudy',
      slug: 'hortocam/understudy',
      url: 'https://github.com/hortocam/understudy'
    }
  ]
}

/** A document the size of a truncated RPC response: valid JSON, cut mid-object. */
export const TRUNCATED_STDOUT = '{"repos":[{"name":"trunc'

// ── control plane the driver holds ───────────────────────────────────────────

export const control = {
  calls: { haptic: 0, navigate: [], notify: [], open: [], shellExec: [] },
  /** Stands in for `useQuery`'s return for the next render. */
  queryResult: { data: SWEEP, error: null, isError: false, isFetching: false, isLoading: false, refetch: () => {} },
  /** Every options object the plugin hands to `useQuery`, in order. */
  queries: [],
  /** Set to a function to override `host.request` (e.g. to fake truncation). */
  requestOverride: null,
  /** Registered i18n bundles, by plugin id. */
  i18nBundle: {},
  /** Active UI locale the i18n stub resolves against. */
  locale: 'en',
  /** Move the focused workspace the chip resolves against. */
  setCwd: value => {
    atomState.cwd = value
  }
}

const atomState = { cwd: '/home/hermes/projects/understudy' }

export const shellResult = command =>
  command.includes('--repo')
    ? { code: 0, stderr: '', stdout: JSON.stringify(DETAIL) }
    : { code: 0, stderr: '', stdout: JSON.stringify(SWEEP) }

/** A nanostore-shaped atom. `get()` re-reads its initialiser when that is a
 *  function, so `control.setCwd` can move the focused workspace between renders
 *  without a real store. */
export const atom = initial => {
  let value = initial
  return {
    get: () => (typeof value === 'function' ? value() : value),
    listen: () => () => {},
    set: next => {
      value = typeof next === 'function' ? next(value) : next
    },
    subscribe: () => () => {}
  }
}

export const host = {
  navigate: to => control.calls.navigate.push(to),
  notify: payload => control.calls.notify.push(payload),
  request: async (method, params) => {
    if (method !== 'shell.exec') {
      throw new Error(`the plugin called ${method}; only shell.exec is allowed`)
    }
    control.calls.shellExec.push(params.command)
    if (control.requestOverride) {
      return control.requestOverride(params)
    }
    return shellResult(params.command)
  },
  state: { cwd: atom(() => atomState.cwd), gateway: atom(() => 'open') }
}

export const usePluginI18n = id => (key, ...args) => {
  const bundles = control.i18nBundle[id] || {}
  // Resolution order the real helper uses: the app's active locale, then the
  // plugin's own `en`, then the raw key. The harness runs as `en`.
  const table = bundles[control.locale] || bundles.en || {}
  const value = table[key]
  if (typeof value === 'function') return value(...args)
  return value !== undefined ? value : key
}

export const useQuery = options => {
  control.queries.push(options)
  return control.queryResult
}

export const useValue = store => (store && typeof store.get === 'function' ? store.get() : store)

// ── plain component names ────────────────────────────────────────────────────

export const Badge = 'Badge'
export const Button = 'Button'
export const Codicon = 'Codicon'
export const CopyButton = 'CopyButton'
export const EmptyState = 'EmptyState'
export const PALETTE_AREA = 'PALETTE_AREA'
export const ROUTES_AREA = 'ROUTES_AREA'
export const SIDEBAR_NAV_AREA = 'SIDEBAR_NAV_AREA'
export const STATUSBAR_AREAS = { left: 'statusBar.left', right: 'statusBar.right' }
export const Separator = 'Separator'
export const Skeleton = 'Skeleton'
export const StatusDot = 'StatusDot'
export const Tip = 'Tip'
export const cn = (...parts) => parts.filter(Boolean).join(' ')
export const haptic = () => {
  control.calls.haptic += 1
}
