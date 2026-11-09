// The post-sync-only checks, drawn from the runbook's Step 3 and the previous syncs' logs.
//
// Each check returns `{ status, summary, details }` (see lib/checks.mjs for the shared ones); the
// driver owns the check's title, its remediation text and its place in the report. Split out of
// post-sync.mjs only so that file stays a readable driver.

import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { readDeletionManifest } from './expected-deletions.mjs'
import {
  compareIdentityBaseline,
  describeComparison,
  readIdentityBaseline
} from './identity-baseline.mjs'
import { BACKUP_REF, UPSTREAM_REF, foreignTipFailure, pinnedUpstreamBase } from './sync-range.mjs'
import {
  STATUS,
  changedNames,
  git,
  gitText,
  headText,
  pnpmCommand,
  repoRoot,
  run,
  splitNul,
  tailText,
  toolExists,
  toolPath
} from './run.mjs'

import { isSweepCandidate, orphanForkFiles } from './orphan-sweep.mjs'

// What can carry an import specifier. Kept broad on purpose: a config script or a test importing a
// fork module keeps it alive, so scanning only `src/` would report live files as orphans.
const SOURCE_FILE = /\.[cm]?[jt]sx?$/

export const FORK_SLUG = 'nplez1/orca'
export const BUILDER_CONFIG = './config/electron-builder.config.cjs'

// The upstream main repo. Not a substring test: `stablyai/orca-hourly` and its daily and adhoc
// siblings are different repositories, kept on purpose in `release-channel.ts` because the fork
// routes every channel to its own repo rather than deleting the dev-channel names. It matches the
// slug as a string, so an `owner: 'stablyai', repo: 'orca'` object form would not be caught; nothing
// in the updater writes one, and a regex guessing at it would be the kind of pattern nobody reads.
export const UPSTREAM_SLUG = /stablyai\/orca(?![\w-])/
// The tree upstream keeps reorganising: `updater/lifecycle/`, `updater/releases/` and four more
// levels appeared in the 2026-11-08 sync, which is how a top-level-only glob stopped finding them.
export const FEED_TREE = 'src/main/updater'
// The update feed must keep naming the fork: without it an update check resolves upstream releases
// and a fork install "upgrades" to a build carrying none of the fork's patches. These are the files
// that hold or derive the repo, so a loss here is a lost feed; a generic helper naming no repo is not.
export const FEED_FILES = [
  'src/main/updater-release-targets.ts',
  'src/main/updater/lifecycle/updater-setup.ts',
  'src/main/updater/releases/updater-prerelease-feed.ts',
  'src/main/updater/releases/updater-release-readiness.ts',
  'src/shared/release-channel.ts'
]

/** True when one of `file`'s relative imports resolves to a file that carries the slug. */
function importsHolder(file, text, holders) {
  const dir = path.posix.dirname(file)
  for (const match of text.matchAll(/from\s+'(\.{1,2}\/[^']+)'/g)) {
    const specifier = match[1]
    for (const candidate of [specifier, `${specifier}.ts`, `${specifier}/index.ts`]) {
      if (holders.has(path.posix.normalize(path.posix.join(dir, candidate)))) {
        return true
      }
    }
  }
  return false
}

/**
 * The feed classification, as a pure function of the file list and their text (`null` = absent).
 *
 * Two findings fail: an anchor that no longer names the fork, and any file in the tree that names
 * upstream's repo. A generic helper that names no repo at all is normal — most of them never touch
 * a release URL — so it is counted rather than listed line by line.
 */
export function classifyFeedFiles({ files, anchors, textOf }) {
  const absent = []
  const upstream = []
  const missing = []
  const silent = []
  const holders = new Set()
  const texts = new Map()
  for (const file of files) {
    const text = textOf(file)
    texts.set(file, text)
    if (text === null) {
      absent.push(file)
      continue
    }
    if (text.includes(FORK_SLUG)) {
      holders.add(file)
    }
    for (const line of text.split('\n')) {
      if (UPSTREAM_SLUG.test(line)) {
        upstream.push(`${file}: ${line.trim()}`)
      }
    }
  }
  // The slug may be held once and derived everywhere else, so a file that imports a file which does
  // carry it is satisfied through that constant — the alternative is a copy of the literal that can
  // drift, which is what this check exists to prevent.
  for (const file of anchors) {
    const text = texts.get(file) ?? null
    if (text === null) {
      missing.push(`${file}: missing from the tree`)
      if (!absent.includes(file)) {
        absent.push(file)
      }
    } else if (!holders.has(file) && !importsHolder(file, text, holders)) {
      missing.push(`${file}: no reference to ${FORK_SLUG}`)
    }
  }
  for (const file of files) {
    if (!anchors.includes(file) && !holders.has(file)) {
      silent.push(file)
    }
  }
  return { absent, upstream, missing, silent, scanned: files.length }
}

/** Every tracked file under the updater tree, plus the anchors that live outside it. */
function feedFiles() {
  const listing = gitText(['ls-files', '-z', '--', FEED_TREE])
  const tracked = listing === null ? [] : splitNul(listing)
  if (tracked.length === 0) {
    return null
  }
  return [...new Set([...FEED_FILES, ...tracked])].sort()
}

export function updaterFeed() {
  const files = feedFiles()
  if (files === null) {
    return {
      status: STATUS.failed,
      summary: `${FEED_TREE}/ has no tracked files, so the updater cannot be scanned`,
      details: []
    }
  }
  const result = classifyFeedFiles({
    files,
    anchors: FEED_FILES,
    textOf: (file) => {
      try {
        return readFileSync(path.join(repoRoot(), file), 'utf8')
      } catch {
        return null
      }
    }
  })
  const helpers = files.filter((file) => path.posix.basename(file).startsWith('updater-'))
  const details = [
    `${result.scanned} file(s) scanned: ${FEED_TREE}/ plus ${FEED_FILES.length} anchor(s), ${helpers.length} updater-*.ts helper(s)`,
    ...(result.silent.length === 0
      ? []
      : [`${result.silent.length} file(s) name no repository, expected for a generic helper`]),
    // No `updater-*.ts` at any depth means upstream moved the updater again, which is the state that
    // made a top-level-only glob scan nothing and report a pass.
    ...(helpers.length === 0
      ? [`${FEED_TREE}/ has no updater-*.ts at any depth: upstream may have moved the updater`]
      : []),
    ...result.upstream.map((line) => `  ! ${line}`),
    ...result.missing.map((line) => `  ! ${line}`)
  ]
  if (result.upstream.length > 0) {
    return {
      status: STATUS.failed,
      summary: `${result.upstream.length} line(s) in the scanned files name upstream's repository`,
      details
    }
  }
  return {
    status: result.missing.length > 0 ? STATUS.failed : STATUS.passed,
    summary:
      result.missing.length > 0
        ? `${result.missing.length} feed anchor(s) lost the fork reference`
        : `feed override still points at the fork (${result.scanned} file(s) scanned)`,
    details
  }
}

export function localizationVerifiers() {
  const details = []
  let failed = false
  for (const script of ['verify:localization-runtime-catalog', 'verify:localization-extraction']) {
    const result = run(pnpmCommand(), ['run', script], { cwd: repoRoot() })
    if (!result.ok) {
      failed = true
    }
    details.push(
      `pnpm run ${script}: ${result.ok ? 'ok' : `FAILED (exit ${result.code ?? 'did not run'})`}`
    )
    if (!result.ok) {
      details.push(...tailText(`${result.stdout}\n${result.stderr}`, 15).map((line) => `  ${line}`))
    }
  }
  return {
    status: failed ? STATUS.failed : STATUS.passed,
    summary: failed
      ? 'at least one verifier failed'
      : 'runtime catalog and extraction verifiers both pass',
    details
  }
}

export function builderConfig() {
  if (!existsSync(path.join(repoRoot(), 'config/electron-builder.config.cjs'))) {
    return {
      status: STATUS.failed,
      summary: 'config/electron-builder.config.cjs is missing',
      details: []
    }
  }
  const result = run('node', ['-e', `require('${BUILDER_CONFIG}')`], { cwd: repoRoot() })
  return {
    status: result.ok ? STATUS.passed : STATUS.failed,
    summary: result.ok
      ? `require('${BUILDER_CONFIG}') is clean`
      : `require failed (exit ${result.code ?? 'did not run'})`,
    details: result.ok ? [] : tailText(`${result.stdout}\n${result.stderr}`, 20)
  }
}

/**
 * Fork-only modules under `src/` that nothing imports. The sync cannot see these: no conflict marker
 * points at a file upstream does not have, so a fork module whose last caller was removed upstream
 * simply stops being read. Reported rather than failed — deleting is a judgement about product code,
 * and the allowlist below is for entries loaded by path, which no import scan can prove alive.
 */
export function unreferencedForkModules({ allowlist = [] } = {}) {
  const tracked = splitNul(gitText(['ls-files', '-z']))
  const upstream = new Set(splitNul(gitText(['ls-tree', '-r', '--name-only', '-z', UPSTREAM_REF])))
  if (upstream.size === 0) {
    return {
      status: STATUS.unavailable,
      summary: `${UPSTREAM_REF} is not fetched, so fork-only files cannot be told from upstream's`,
      details: ['run: git fetch upstream']
    }
  }
  const candidates = tracked.filter((file) => !upstream.has(file) && isSweepCandidate(file))
  const readable = tracked.filter((file) => SOURCE_FILE.test(file))
  const sources = new Map()
  for (const file of readable) {
    try {
      sources.set(file, readFileSync(path.join(repoRoot(), file), 'utf8'))
    } catch {
      // An unreadable file proves nothing either way; leaving it out can only add a false orphan.
    }
  }
  const orphans = orphanForkFiles({ sources, forkOnly: candidates, allowlist })
  return {
    status: orphans.length === 0 ? STATUS.passed : STATUS.info,
    summary:
      orphans.length === 0
        ? `${candidates.length} fork-only module(s) under src/, all referenced`
        : `${orphans.length} fork-only module(s) nothing imports`,
    details: orphans.map((file) => `  ? ${file}`)
  }
}

/**
 * The identity sweep as a gate: a fixable finding fails, and so does a report-only finding the frozen
 * baseline has never seen. Without the second half the row passed on any tree at all — there are
 * hundreds of report-only findings, so `fixable === 0` was the whole verdict.
 */
export function identitySweep() {
  const sweep = 'identity-sweep.mjs'
  if (!toolExists(sweep)) {
    return {
      status: STATUS.unavailable,
      summary: `${sweep} is not yet available (not present in this worktree)`,
      details: []
    }
  }
  const result = run('node', [toolPath(sweep), '--json'], { cwd: repoRoot() })
  let report = null
  try {
    report = JSON.parse(result.stdout)
  } catch {
    report = null
  }
  if (report === null) {
    // An unreadable report is a failed check, never "no violations".
    return {
      status: STATUS.failed,
      summary: `${sweep} --json produced no readable report (exit ${result.code ?? 'did not run'})`,
      details: headText(`${result.stdout}\n${result.stderr}`, 20)
    }
  }
  const fixable = report.counts?.fixable ?? 0
  const fixableDetails = (report.fixable ?? [])
    .slice(0, 30)
    .map((hit) => `  ! ${hit.file}:${hit.line}  ${hit.text} -> ${hit.to}`)
  const { baseline, problem } = readIdentityBaseline(repoRoot())
  if (baseline === null) {
    return {
      status: STATUS.failed,
      summary: `the report-only baseline cannot be read: ${problem}`,
      details: [
        'an unreadable baseline is not "no new findings"; regenerate it with',
        '  node local/sync/identity-sweep.mjs --baseline-init --accept "<why>"'
      ]
    }
  }
  const comparison = compareIdentityBaseline({ baseline, reportOnly: report.reportOnly ?? [] })
  const details = [...fixableDetails, ...describeComparison(comparison)]
  if (fixable > 0) {
    return {
      status: STATUS.failed,
      summary: `${fixable} fixable violation(s) (${sweep})`,
      details
    }
  }
  if (!comparison.clean) {
    const counts = [
      comparison.appeared.length > 0 ? `${comparison.appeared.length} new` : null,
      comparison.grown.length > 0 ? `${comparison.grown.length} grown` : null,
      comparison.shrunk ? 'the total shrank' : null
    ].filter(Boolean)
    return {
      status: STATUS.failed,
      summary: `report-only findings moved against the frozen baseline: ${counts.join(', ')} (${sweep})`,
      details
    }
  }
  return {
    status: STATUS.passed,
    summary: `no fixable violations, ${comparison.total} report-only at baseline (${sweep})`,
    details
  }
}

// The pre-sync tip and the pinned upstream base live in lib/sync-range.mjs: they are the input every
// check below shares, and the check that they belong to THIS merge is what makes them safe to use.

export { lostContent } from './lost-content.mjs'

// ---- deleted modules -------------------------------------------------------------------------

// Extensions a deleted file has to have to be carrying behaviour of its own. A deleted `.json`,
// `.md` or `.snap` is a removal a reviewer can see; a deleted module is where a unique side effect
// can disappear without any conflict marker or type error.
const CODE_EXTENSIONS = new Set(['.ts', '.tsx', '.mjs'])
// Tests, spec files, and the fixture/mock trees are not the module a caller imports.
const NOT_A_MODULE = /(^|[.-])(test|spec)\.|[.-](test|tests|fixture|fixtures)$/
const NOT_A_MODULE_DIR = new Set(['__fixtures__', '__mocks__', '__tests__'])

// Repo-relative paths, so the posix flavour is the right one on every platform.
export function isDeletedCodeModule(file) {
  const ext = path.posix.extname(file)
  if (!CODE_EXTENSIONS.has(ext) || file.endsWith('.d.ts')) {
    return false
  }
  const segments = file.split('/')
  if (segments.some((segment) => NOT_A_MODULE_DIR.has(segment))) {
    return false
  }
  return !NOT_A_MODULE.test(segments.at(-1))
}

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/
// Words that follow `export` in a declaration but are never the declared name themselves.
const NOT_A_NAME = new Set([
  'abstract',
  'async',
  'class',
  'const',
  'declare',
  'default',
  'enum',
  'export',
  'extends',
  'from',
  'function',
  'implements',
  'interface',
  'let',
  'namespace',
  'type',
  'var'
])
// Ordered: `const enum` before `const`, which would otherwise record the word `enum` as the name.
const DECLARED_EXPORTS = [
  [/\bexport\s+(?:declare\s+)?const\s+enum\s+([A-Za-z_$][\w$]*)/g, 'type'],
  [
    /\bexport\s+(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/g,
    'function'
  ],
  [/\bexport\s+(?:declare\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/g, 'class'],
  [/\bexport\s+(?:declare\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g, 'const'],
  [/\bexport\s+(?:declare\s+)?(?:type|interface|enum|namespace)\s+([A-Za-z_$][\w$]*)/g, 'type']
]
const EXPORT_CLAUSE = /\bexport\s+(?:type\s+)?\{([^}]*)\}/g
// `export default` has no name a caller could import; only a named form is searchable.
const DEFAULT_EXPORT =
  /\bexport\s+default\s+(?:async\s+)?(?:function\s*\*?\s*|class\s+)?([A-Za-z_$][\w$]*)?/g

// A parser, not a compiler: it reads the names a caller would import, so the live-tree search
// below has something to look for. It says nothing about how the module behaved.
export function exportInventory(source) {
  const text = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')
  const found = new Map()
  const record = (name, kind) => {
    if (typeof name !== 'string' || !IDENTIFIER.test(name) || NOT_A_NAME.has(name)) {
      return
    }
    if (!found.has(name)) {
      found.set(name, kind)
    }
  }
  for (const [pattern, kind] of DECLARED_EXPORTS) {
    for (const match of text.matchAll(pattern)) {
      record(match[1], kind)
    }
  }
  for (const match of text.matchAll(EXPORT_CLAUSE)) {
    for (const item of match[1].split(',')) {
      // `X` and `X as Y` both export the alias: that is the name a caller imports.
      const [local, alias] = item
        .replace(/\btype\s+/, '')
        .trim()
        .split(/\s+as\s+/)
      record(alias ?? local, 're-export')
    }
  }
  for (const match of text.matchAll(DEFAULT_EXPORT)) {
    if (match[1] === undefined) {
      if (!found.has('default')) {
        found.set('default', 'default')
      }
      continue
    }
    record(match[1], 'default')
  }
  return [...found]
    .map(([name, kind]) => ({ name, kind, anonymous: name === 'default' }))
    .sort((a, b) => (a.name < b.name ? -1 : 1))
}

// The deletions this sync made, with the exported surface of each deleted fork-only module. The
// modified-file scan above cannot see any of this: a deleted file is not in `--diff-filter=M`, and
// a module whose behaviour had a unique side effect is exactly what an "upstream supersedes it"
// call gets wrong.
//
// This proves a scan over deleted paths and export names. It does not prove that no behaviour was
// lost: an export still referenced by a shim, or behaviour that reached the fork through a path
// with no exported name, is outside what it can see.

/**
 * Deletions a reviewer has judged superseded, from `local/sync/expected-deletions.json`.
 *
 * A deleted module legitimately leaves no reference to its exports behind when its behaviour moved
 * into a live module under a different name, so the export scan needs a way to record that verdict
 * rather than failing forever on a supersession someone already checked.
 *
 * `base` is the pinned upstream base: an entry bound to a blob upstream no longer has is a question
 * again, and an entry neither side has any more is prunable.
 */
function readExpectedDeletions(base = null) {
  const file = path.join(repoRoot(), 'local/sync/expected-deletions.json')
  let text = null
  try {
    text = readFileSync(file, 'utf8')
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) {
      return {
        acknowledged: {},
        prunable: [],
        failure: `${file} could not be read: ${error instanceof Error ? error.message : String(error)}`
      }
    }
  }
  const at = (ref) =>
    ref === null ? null : new Set(splitNul(gitText(['ls-tree', '-r', '--name-only', '-z', ref])))
  // Why the shared reader: the manifest's shape is `deletions[]` with a per-entry status, and a second
  // reader with its own idea of it is how this check read the retired `acknowledged` key for a week and
  // reported FAILED on every run.
  const manifest = readDeletionManifest({
    text,
    presentAtHead: at('HEAD') ?? new Set(),
    presentUpstream: at(base),
    upstreamBlobOf: (entryPath) =>
      base === null
        ? null
        : gitText(['rev-parse', '--verify', '--quiet', [base, entryPath].join(':')])
  })
  const acknowledged = {}
  for (const entry of manifest.entries) {
    // `pending-decision` acknowledges nothing, and neither does one the binding reopened.
    if (entry.status === 'expected-deletion') {
      acknowledged[entry.path] = { reason: entry.reason }
    }
  }
  return { acknowledged, prunable: manifest.prunable, failure: manifest.failure }
}

export function deletedForkModules(tip, source, problem = null) {
  if (problem !== null) {
    return foreignTipFailure(
      problem,
      'the scan would read the wrong tip and report clean, so it refuses instead'
    )
  }
  if (!tip) {
    return {
      status: STATUS.unavailable,
      summary: `no pre-sync tip: ${BACKUP_REF} is absent and no state file names one`,
      details: [
        'the exported surface of a deleted module can only be read at the pre-sync tip, so this is not a pass'
      ]
    }
  }
  const pinned = pinnedUpstreamBase(tip, source)
  if (pinned.base === null) {
    return {
      status: STATUS.failed,
      summary: `cannot pin the upstream base: ${pinned.problem}`,
      details: [
        'without the pinned base every deleted path reads as fork-only, which is the wrong answer to publish'
      ]
    }
  }
  const base = pinned.base
  const oldBase = gitText(['merge-base', tip, base])
  if (!oldBase) {
    return {
      status: STATUS.failed,
      summary: `no merge base between ${tip.slice(0, 10)} and the pinned base ${base.slice(0, 10)}`,
      details: []
    }
  }
  // Renames off on both sides, deliberately: git pairs a deletion with a similar addition and reports
  // the pair as `R`, which drops the deleted path from the set this classifier reads. Two paths were
  // lost that way — `filesystem-text-search-handler.ts` from our side, and
  // `terminal-file-link-detection-ranges.ts` from upstream's, which then read as a fork-only deletion
  // with a lost export when upstream had simply renamed the file.
  const upstreamChanged = changedNames(['--no-renames', oldBase, base])
  // Renames off here too: see the note above.
  const deleted = changedNames(['--no-renames', '--diff-filter=D', tip, 'HEAD'])
  if (upstreamChanged === null || deleted === null) {
    return {
      status: STATUS.failed,
      summary: `git diff --name-only failed for ${tip.slice(0, 10)}..HEAD`,
      details: [
        'the deleted and upstream-touched sets are unknown, so the scan cannot report clean'
      ]
    }
  }
  const upstreamFiles = new Set(upstreamChanged)
  const forkOnly = []
  const upstreamDeleted = []
  const stillUpstream = []
  for (const file of deleted) {
    if (git(['cat-file', '-e', `${base}:${file}`]).ok) {
      stillUpstream.push(file)
    } else if (upstreamFiles.has(file)) {
      upstreamDeleted.push(file)
    } else {
      forkOnly.push(file)
    }
  }
  const details = [
    `pre-sync tip: ${tip.slice(0, 10)} from ${source}`,
    `deleted between that tip and HEAD, with renames off: ${deleted.length} path(s)`,
    `upstream deleted it too (upstream touched the path in this range and it is gone at the pinned base): ${upstreamDeleted.length}`,
    ...upstreamDeleted.slice(0, 30).map((file) => `  - ${file}`),
    ...(stillUpstream.length === 0
      ? []
      : [
          `still at the pinned base, so the deletion is ours alone: ${stillUpstream.length}`,
          ...stillUpstream.slice(0, 30).map((file) => `  - ${file}`)
        ]),
    `fork-only by construction (absent at the pinned base, untouched upstream in this range): ${forkOnly.length}`,
    ...forkOnly.slice(0, 30).map((file) => `  - ${file}`)
  ]
  const scanFailures = []
  const unreferenced = []
  const acknowledgedUnreferenced = []
  const expectations = readExpectedDeletions(base)
  if (expectations.failure !== null) {
    scanFailures.push(expectations.failure)
  }
  const acknowledgedPaths = Object.keys(expectations.acknowledged)
  // Why presence rather than this sync's deleted set: the manifest settles deletions from every past
  // sync, so asking which of them this one range deleted reads all 22 settled entries as stale on
  // every run. A deletion that is *back* is the thing worth reporting.
  const staleAcknowledgements = acknowledgedPaths.filter((file) =>
    existsSync(path.join(repoRoot(), file))
  )
  const modules = forkOnly.filter(isDeletedCodeModule)
  for (const file of modules) {
    const content = gitText(['show', `${tip}:${file}`])
    if (content === null) {
      // The tip resolves and it is the tip's own HEAD-side path, so a `git show` miss is the probe
      // failing, not an empty module.
      scanFailures.push(`${file}: git show ${tip.slice(0, 10)}:${file} failed`)
      continue
    }
    const exported = exportInventory(content)
    if (exported.length === 0) {
      details.push(`  ${file} — no exported name to cross-check`)
      continue
    }
    details.push(`  ${file} — exported surface at ${tip.slice(0, 10)}:`)
    for (const { name, kind, anonymous } of exported) {
      if (anonymous) {
        details.push(`      default (anonymous, ${kind}) — no name to search for`)
        continue
      }
      // `local/sync/` is excluded because this tool and the ledger name these modules by
      // construction; counting that as a caller would manufacture the clean answer.
      const result = git(['grep', '-l', '-F', '-e', name, 'HEAD', '--', ':!local/sync'])
      if (!result.ok && result.code !== 1) {
        scanFailures.push(
          `${file}: git grep for ${name} exited ${result.code ?? 'without running'} — ${tailText(result.stderr, 2).join(' ')}`
        )
        continue
      }
      const hits = result.ok
        ? result.stdout
            .split('\n')
            .filter(Boolean)
            .map((line) => line.replace(/^HEAD:/, ''))
        : []
      if (hits.length === 0) {
        const ack = expectations.acknowledged[file]
        if (ack) {
          acknowledgedUnreferenced.push(`${file}: ${name}`)
          details.push(
            `      ~ ${name} (${kind}) — no reference left, acknowledged: ${ack.reason || 'no reason recorded'}`
          )
        } else {
          unreferenced.push(`${file}: ${name}`)
          details.push(
            `      ! ${name} (${kind}) — no reference in the live tree: its caller left with it`
          )
        }
      } else {
        details.push(
          `      ${name} (${kind}) — ${hits.length} reference(s): ${hits.slice(0, 3).join(', ')}`
        )
      }
    }
  }
  if (staleAcknowledgements.length > 0) {
    details.push(
      `acknowledged deletions that are present again (stale entries in local/sync/expected-deletions.json): ${staleAcknowledgements.length}`
    )
    for (const file of staleAcknowledgements) {
      details.push(`  ? ${file}`)
    }
  }
  for (const file of expectations.prunable) {
    details.push(`  ? ${file} — in the manifest, but neither side has it any more: prune the entry`)
  }
  if (acknowledgedUnreferenced.length > 0) {
    details.push(
      `acknowledged as superseded, so not counted against the scan: ${acknowledgedUnreferenced.length}`
    )
  }
  details.push(
    `scanned ${modules.length} deleted fork-only code module(s) for names the live tree no longer references`
  )
  details.push(
    'this is a scan of deleted paths and export names, not proof that no behaviour was lost'
  )
  if (scanFailures.length > 0) {
    return {
      status: STATUS.failed,
      summary: `the exported surface could not be read for ${scanFailures.length} deleted path(s)`,
      details: [...scanFailures.map((line) => `  ! ${line}`), ...details]
    }
  }
  return {
    status: unreferenced.length === 0 ? STATUS.passed : STATUS.failed,
    summary:
      unreferenced.length === 0
        ? `clear scan: no unreviewed unreferenced export among ${modules.length} deleted fork-only module(s)`
        : `${unreferenced.length} export(s) of deleted fork-only module(s) have no surviving reference`,
    details:
      unreferenced.length === 0
        ? details
        : [...unreferenced.map((line) => `  ! ${line}`), ...details]
  }
}
