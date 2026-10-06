/**
 * Runtime harness for the hermes-ci-status desktop plugin.
 *
 * The plugin is plain ESM that the desktop app loads uncompiled, so the honest
 * way to test it without Electron is to execute the real file: this harness
 * copies plugin.js into a scratch dir with its three import specifiers
 * (`@hermes/plugin-sdk`, `react`, `react/jsx-runtime`) rewritten to local stubs,
 * then imports and drives it.
 *
 * The plugin's own top-level code, `register()` and every component render for
 * real — only the SDK's implementations are stubbed. If a jsx() call references
 * an identifier that was not imported, or a contribution payload has the wrong
 * shape, this throws exactly as the app would.
 *
 * Run:  node ~/.hermes/desktop-plugins/hermes-ci-status/test/run.mjs
 */
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { control, DETAIL, SWEEP, TRUNCATED_STDOUT } from './harness-sdk.mjs'

const HERE = path.dirname(new URL(import.meta.url).pathname)
const PLUGIN_SRC = path.join(HERE, '..', 'plugin.js')
const SCRATCH = path.join(HERE, '.scratch')

/** Every element the resolver passed through, so a test can still reach a
 *  component element (and its props) after `nodes()` has invoked it. Declared
 *  up here because `nodes()` is called long before the helpers section. */
const seenElements = []

/** The most recent element whose component function is named `name`. */
function elementOf(name) {
  return seenElements.filter(n => typeof n.__type === 'function' && n.__type.name === name).pop()
}

// ── materialise the plugin against the stubs ─────────────────────────────────

rmSync(SCRATCH, { force: true, recursive: true })
mkdirSync(SCRATCH, { recursive: true })

// A ONE-WAY import: plugin.mjs must reach the SAME harness-sdk instance the
// driver holds, so the rewrite points straight at it by relative path rather
// than copying it. (A copy would give the plugin and the driver two separate
// `control` objects, and cross-module state would silently diverge.)
writeFileSync(
  path.join(SCRATCH, 'react.mjs'),
  'export const useMemo = fn => fn()\n' +
    "export const useState = initial => [typeof initial === 'function' ? initial() : initial, () => {}]\n"
)

writeFileSync(
  path.join(SCRATCH, 'jsx-runtime.mjs'),
  'export const jsx = (type, props, key) => ({ __type: type, key, props: props || {} })\n' +
    'export const jsxs = (type, props, key) => ({ __type: type, key, props: props || {} })\n' +
    "export const Fragment = 'Fragment'\n"
)

const rewritten = readFileSync(PLUGIN_SRC, 'utf8')
  .replace(/from '@hermes\/plugin-sdk'/g, "from '../harness-sdk.mjs'")
  .replace(/from 'react\/jsx-runtime'/g, "from './jsx-runtime.mjs'")
  .replace(/from 'react'/g, "from './react.mjs'")

writeFileSync(path.join(SCRATCH, 'plugin.mjs'), rewritten)

const mod = await import(pathToFileURL(path.join(SCRATCH, 'plugin.mjs')).href)
const plugin = mod.default

// ── contract ─────────────────────────────────────────────────────────────────

assert.ok(plugin, 'the module default-exports a plugin')
assert.equal(plugin.id, 'hermes-ci-status', 'id matches the folder name (the loader requires it)')
assert.equal(plugin.name, 'CI Status', 'plugin has a human name')
assert.equal(typeof plugin.register, 'function', 'register() is a function')

const contributions = []
plugin.register({
  // `ctx.i18n.register` takes the bundles WITHOUT the plugin id — the host
  // namespaces them — so the harness supplies that keying itself.
  i18n: { register: bundles => Object.assign(control.i18nBundle, { 'hermes-ci-status': bundles }) },
  onDispose: () => {},
  register: contribution => contributions.push(contribution),
  registerMany: list => list.forEach(c => contributions.push(c)),
  storage: { get: () => '', set: () => {} }
})

// No import may escape the three allowed specifiers.
const specifiers = [...readFileSync(PLUGIN_SRC, 'utf8').matchAll(/from\s+'([^']+)'/g)].map(m => m[1])
assert.deepEqual(
  [...new Set(specifiers)].sort(),
  ['@hermes/plugin-sdk', 'react', 'react/jsx-runtime'],
  'the plugin imports only the specifiers a disk plugin may resolve'
)

const bundle = control.i18nBundle['hermes-ci-status']
assert.ok(bundle, 'registered its own i18n bundle')
assert.ok(Object.keys(bundle.en).length >= 18, 'i18n bundle carries the full page vocabulary')
assert.equal(typeof bundle.en.chipAria, 'function', 'interpolated strings are functions')

const areas = contributions.map(c => c.area)
assert.deepEqual(
  areas.slice().sort(),
  ['PALETTE_AREA', 'PALETTE_AREA', 'ROUTES_AREA', 'SIDEBAR_NAV_AREA', 'statusBar.right'].sort(),
  `contribution areas: ${areas.join(', ')}`
)

const route = contributions.find(c => c.area === 'ROUTES_AREA')
const nav = contributions.find(c => c.area === 'SIDEBAR_NAV_AREA')
const chip = contributions.find(c => c.area === 'statusBar.right')
const palette = contributions.filter(c => c.area === 'PALETTE_AREA')

assert.equal(route.data.path, '/ci', 'route path')
assert.equal(nav.data.path, '/ci', 'sidebar nav targets the route')
assert.equal(nav.data.label, 'CI', 'sidebar nav label')
assert.equal(nav.data.codicon, 'pulse', 'sidebar nav glyph')
assert.equal(chip.order, 160, 'chip has an explicit order')
assert.equal(palette.length, 2, 'two palette commands registered')
assert.ok(palette.every(c => c.data.id && c.data.label && typeof c.data.run === 'function'),
  'every palette command has id, label and run()')

// ── the chip ─────────────────────────────────────────────────────────────────

control.queryResult = { data: SWEEP, error: null, isError: false, isFetching: false, isLoading: false, refetch: () => {} }
const chipTree = nodes(chip.render())
assert.match(text(chipTree), /understudy/, 'chip names the repo under the focused cwd')
assert.match(text(chipTree), /wt\/slice-2-handoff/, 'chip shows the branch')
assert.match(text(chipTree), /#18/, 'chip shows the PR number')
assert.ok(!text(chipTree).includes('soundscape-factory'), 'chip prefers the focused repo over the urgent one')

const chipTip = find(chipTree, 'Tip')
assert.ok(chipTip, 'the chip is wrapped in a Tip')
assert.match(String(chipTip.props.label), /Running/, 'tooltip states the RAG verdict')
assert.match(String(chipTip.props.label), /understudy · wt\/slice-2-handoff/, 'tooltip carries repo + branch')

// A workspace on no watched repo falls back to the most urgent, and says so.
control.setCwd('/tmp/nowhere')
const fbTree = nodes(chip.render())
assert.match(text(fbTree), /soundscape-factory/, 'falls back to the most urgent failing repo')
assert.match(String(find(fbTree, 'Tip').props.label), /No repo under this chat/, 'the fallback is disclosed')
control.setCwd('/home/hermes/projects/understudy')

// A collector failure must surface its reason, not a dead chip.
control.queryResult = { data: undefined, error: new Error('collector exploded'), isError: true, isFetching: false, isLoading: false, refetch: () => {} }
const errTip = find(nodes(chip.render()), 'Tip')
assert.ok(errTip, 'the error chip renders')
assert.match(String(errTip.props.label), /collector exploded/, 'the error chip carries the reason')

// ── the page ─────────────────────────────────────────────────────────────────

control.queryResult = { data: SWEEP, error: null, isError: false, isFetching: false, isLoading: false, refetch: () => {} }
const pageTree = nodes(route.render())
const pageText = text(pageTree)
assert.match(pageText, /CI status/, 'page title renders')
assert.match(pageText, /2 repos watched/, 'header counts only the watched repos')
assert.match(pageText, /understudy/, 'page lists understudy')
assert.match(pageText, /soundscape-factory/, 'page lists the failing gitea repo')
assert.match(pageText, /finance-tracker/, 'the skipped repo still appears')
assert.match(pageText, /Checked out but not watched/, 'the skipped section is labelled')
assert.match(pageText, /Repository/, 'column headers render')

// `nodes()` resolves the rows, so assert on their CONTENT — the counts, the PR,
// the RAG colours — rather than on the component node itself.
const pageNodes = nodes(pageTree)
const rowText = text(pageTree)
assert.match(rowText, /1 running/, 'understudy row reports one running check')
assert.match(rowText, /1 failed/, 'soundscape row reports one failing check')
assert.match(rowText, /review/, 'a REVIEW_REQUIRED PR renders its badge')
assert.match(rowText, /github/, 'the forge column names the host')
assert.match(rowText, /gitea/, 'the forge column names the gitea host')
assert.ok(!rowText.includes('build'), 'collapsed rows do not render their check list')

// The RAG map: one StatusDot per repo row, toned from the collector's state.
const tones = pageNodes
  .filter(n => n.__type === 'StatusDot' && n.props && n.props.tone)
  .map(n => n.props.tone)
assert.ok(tones.includes('warn'), 'a pending repo renders a warn dot')
assert.ok(tones.includes('bad'), 'a failing repo renders a bad dot')

// ── one row rendered in full ─────────────────────────────────────────────────

// Collapsed, so CiRow rendered its header only — assert on what it emitted.
const collapsedRowText = text(nodes(route.render()))
assert.match(collapsedRowText, /understudy/, 'the focused repo has a row')
assert.match(String(SWEEP.repos[0].pr.url), /pull\/18$/, 'the fixture PR URL is wired through')

// ── transport contract ───────────────────────────────────────────────────────

// Render BOTH surfaces so every useQuery the plugin has is registered, then
// pick the sweep and the detail queries out of the capture by their keys.
control.queries = []
control.calls.shellExec.length = 0
// `render()` only builds the element — nodes() invokes the component, and that
// is what registers a useQuery. Capture through the resolver.
nodes(chip.render())
nodes(route.render())

const sweepQuery = control.queries.find(
  q => Array.isArray(q.queryKey) && q.queryKey[1] === 'sweep'
)
assert.ok(sweepQuery, 'the sweep query registered')
assert.deepEqual(sweepQuery.queryKey.slice(0, 2), ['hermes-ci-status', 'sweep'], 'sweep query key')
assert.equal(sweepQuery.refetchInterval, 30_000, 'poll cadence is a sane 30s')

const doc = await sweepQuery.queryFn()
assert.equal(doc.repos.length, 3, 'queryFn returned the sweep')
assert.equal(control.calls.shellExec.length, 1, 'exactly one collector call')
assert.match(control.calls.shellExec[0], /--json --compact$/, 'the sweep asks for compact JSON')

// An over-budget payload must fail with the explainable error, not a JSON
// syntax complaint nobody can act on.
control.requestOverride = () => ({ code: 0, stderr: '', stdout: TRUNCATED_STDOUT })
let thrown = null
try {
  await sweepQuery.queryFn()
} catch (e) {
  thrown = e
}
assert.ok(thrown, 'a truncated payload throws')
assert.match(thrown.message, /cut off in transit/, 'the truncation is explained')
control.requestOverride = null

// A non-zero exit with no stdout must carry the collector's own stderr.
control.requestOverride = () => ({ code: 2, stderr: 'Traceback: boom', stdout: '' })
let exitErr = null
try {
  await sweepQuery.queryFn()
} catch (e) {
  exitErr = e
}
assert.ok(exitErr, 'a failed collector throws')
assert.match(exitErr.message, /Traceback: boom/, 'the collector stderr is surfaced')
control.requestOverride = null

// ── expansion: the row's detail is fetched, not preloaded ────────────────────

function findRow(repoName) {
  return seenElements
    .filter(n => typeof n.__type === 'function' && n.__type.name === 'CiRow')
    .filter(n => n.props && n.props.repo && n.props.repo.name === repoName)
    .pop()
}

// A collapsed page must not have asked the collector for anything.
control.calls.shellExec.length = 0
control.queries = []
control.requestOverride = null
nodes(route.render())
assert.equal(control.calls.shellExec.length, 0, 'a collapsed page shells out for nothing')
assert.equal(
  control.queries.filter(q => Array.isArray(q.queryKey) && q.queryKey[1] === 'repo').length,
  0,
  'no per-repo detail query until a row expands'
)

// Expanding the focused row fetches its checks in a second, narrower call.
control.requestOverride = () => ({ code: 0, stderr: '', stdout: JSON.stringify(DETAIL) })
nodes(route.render())
const rowEl = findRow('understudy')
assert.ok(rowEl, 'found the row element for the focused repo')

// React Query would hand the detail document to the mounted RepoChecks; stand
// in for that, then render the row expanded.
control.queryResult = { data: DETAIL, error: null, isError: false, isFetching: false, isLoading: false, refetch: () => {} }
const expandedTree = text(rowEl.__type({ ...rowEl.props, expanded: true }))
assert.match(expandedTree, /build/, 'an expanded row lists its checks')
assert.match(expandedTree, /test/, 'an expanded row lists every check')
assert.match(expandedTree, /head 0d45bb1237/, 'the expanded row shows the head SHA')

const detailQuery = control.queries.filter(q => Array.isArray(q.queryKey) && q.queryKey[1] === 'repo')[0]
assert.ok(detailQuery, 'expanding a row registers a per-repo detail query')
const detailDoc = await detailQuery.queryFn()
assert.equal(detailDoc.repos[0].branches['wt/slice-2-handoff'].contexts.length, 2, 'detail carries the checks')
assert.match(control.calls.shellExec[0], /--repo/, 'the detail call names exactly one repo')
assert.match(control.calls.shellExec[0], /understudy/, 'the detail call names the right repo')

control.requestOverride = null

// ── column alignment: the regression the harness used to miss ────────────────

// The harness proved the plugin *renders*; it did not prove the header lines up
// with the rows. It now does: extract the ordered width tokens from the header's
// cells and from a row's cells and require them to agree. This is the assertion
// that would have caught the original bug, where the header's two glyph spacers
// were inline `size-*` boxes (zero-width, since `display: inline` ignores
// width/height) while the rows' real glyphs kept their space — shifting every
// label ~24px left of its own column.

/** Width-bearing classes: the ones that decide where a column starts. */
function widthTokens(className) {
  return String(className || '')
    .split(/\s+/)
    .filter(t => /^-?(w|min-w|max-w|flex-1|basis)-?/.test(t))
    .sort()
    .join(' ')
}

/** Direct children elements of a node's `children`. */
function childElements(node) {
  const kids = node && node.props && node.props.children
  const list = Array.isArray(kids) ? kids : kids ? [kids] : []
  return list.filter(n => n && typeof n === 'object' && n.__type !== undefined)
}

control.queryResult = { data: SWEEP, error: null, isError: false, isFetching: false, isLoading: false, refetch: () => {} }
control.setCwd('/tmp/nowhere') // so the header renders without the fallback banner
nodes(route.render())
control.setCwd('/home/hermes/projects/understudy')

// The header is the flex container holding the 'Repository' label.
const headerEl = seenElements.find(
  n => childElements(n).some(c => c.props && c.props.children === 'Repository')
)
assert.ok(headerEl, 'found the column header')

const rowElForAlign = findRow('understudy')
assert.ok(rowElForAlign, 'found a row to compare against')
const rowTree = rowElForAlign.__type(rowElForAlign.props)
const rowContainer = childElements(rowTree)[0]
assert.ok(rowContainer, 'the row renders a container')

const headerCells = childElements(headerEl)
const rowCells = childElements(rowContainer)
assert.equal(headerCells.length, 7, 'the header has one cell per column')
assert.ok(rowCells.length >= 7, 'the row has at least one cell per column')

for (let i = 0; i < headerCells.length; i++) {
  const h = widthTokens(headerCells[i].props.className)
  const r = widthTokens(rowCells[i].props.className)
  assert.equal(
    h,
    r,
    `column ${i} ('${headerCells[i].props.children}') header [${h}] must match row [${r}]`
  )
}

// And no cell may lean on a bare `size-*`: that is an inline box, so it has no
// width at all and silently collapses. This is the exact shape of the old bug.
for (const [label, cells] of [['header', headerCells], ['row', rowCells]]) {
  for (const cell of cells) {
    const cls = String(cell.props.className || '')
    if (/\bsize-\S+/.test(cls)) {
      assert.match(
        cls,
        /\b(flex|grid|inline-block|block)\b/,
        `${label} cell uses a bare \`size-*\` without a display class: "${cls}"`
      )
    }
  }
}

// ── render-tree helpers ──────────────────────────────────────────────────────

function nodes(node, out = []) {
  if (!node || typeof node !== 'object') return out
  if (Array.isArray(node)) {
    node.forEach(n => nodes(n, out))
    return out
  }
  if (node.__type !== undefined) {
    seenElements.push(node)
    // A function component: call it with its props, exactly as React would, and
    // walk the tree it returns. This is what makes assertions on CiChip/CiPage
    // real rather than shallow — a broken jsx() call inside one throws here.
    const rendered = typeof node.__type === 'function' ? node.__type(node.props || {}) : node
    if (rendered && rendered !== node) {
      if (Array.isArray(rendered)) rendered.forEach(n => nodes(n, out))
      else if (rendered.__type !== undefined) nodes(rendered, out)
      else if (typeof rendered === 'string' || typeof rendered === 'number') out.push({ __type: 'span', props: { children: rendered } })
      return out
    }
    out.push(node)
    nodes(node.props && node.props.children, out)
  }
  return out
}

/** Every visible string in a resolved tree. */
function text(node) {
  return nodes(node)
    .map(n => {
      if (typeof n.__type === 'function') return ''
      const children = n.props && n.props.children
      if (typeof children === 'string' || typeof children === 'number') return String(children)
      if (Array.isArray(children)) {
        return children
          .filter(c => typeof c === 'string' || typeof c === 'number')
          .map(String)
          .join(' ')
      }
      return ''
    })
    .filter(Boolean)
    .join(' | ')
}

/** First node with the given component type or host tag. */
function find(node, type) {
  return nodes(node).find(n => n.__type === type)
}

console.log('PLUGIN HARNESS: all assertions passed')
console.log('  contributions :', areas.join(', '))
console.log('  i18n keys     :', Object.keys(bundle.en).length)
console.log('  collector cmds:', control.calls.shellExec.length ? control.calls.shellExec.join(' ; ') : '(none this pass)')

rmSync(SCRATCH, { force: true, recursive: true })
