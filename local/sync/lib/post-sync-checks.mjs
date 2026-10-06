// The post-sync-only checks, drawn from the runbook's Step 3 and the previous syncs' logs.
//
// Each check returns `{ status, summary, details }` (see lib/checks.mjs for the shared ones); the
// driver owns the check's title, its remediation text and its place in the report. Split out of
// post-sync.mjs only so that file stays a readable driver.

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import {
  STATUS,
  changedNames,
  git,
  gitText,
  headText,
  pnpmCommand,
  readSyncState,
  refExists,
  repoRoot,
  run,
  tailText,
  toolExists,
  toolPath
} from './run.mjs'

export const FORK_SLUG = 'nplez1/orca'
export const UPSTREAM_REF = 'upstream/main'
export const BACKUP_REF = 'backup/nplez1-main-pre-sync'
export const BUILDER_CONFIG = './config/electron-builder.config.cjs'
// The update feed must keep naming the fork: without it an update check resolves upstream
// releases and a fork install "upgrades" to a build carrying none of the fork's patches.
const FEED_FILES = ['src/main/updater-prerelease-feed.ts', 'src/shared/release-channel.ts']
const FEED_GLOB = { dir: 'src/main/updater', prefix: 'updater-' }

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

function feedFiles() {
  const dir = path.join(repoRoot(), FEED_GLOB.dir)
  if (!existsSync(dir)) {
    return null
  }
  const glob = readdirSync(dir)
    .filter((name) => name.startsWith(FEED_GLOB.prefix) && name.endsWith('.ts'))
    .sort()
    .map((name) => `${FEED_GLOB.dir}/${name}`)
  return [...FEED_FILES, ...glob]
}

export function updaterFeed() {
  const files = feedFiles()
  if (files === null) {
    return { status: STATUS.failed, summary: `${FEED_GLOB.dir}/ does not exist`, details: [] }
  }
  const details = []
  const missing = []
  const scanFailures = []
  const globbed = files.filter((file) => !FEED_FILES.includes(file))
  for (const file of files) {
    const present = existsSync(path.join(repoRoot(), file))
    const grepped = present ? git(['grep', '-n', '-F', '-e', FORK_SLUG, '--', file]) : null
    // git grep exits 1 for "no match", which is the finding this check wants; any other non-zero
    // status is the scan failing and must not read as a missing reference.
    if (grepped && !grepped.ok && grepped.code !== 1) {
      scanFailures.push(
        `${file}: git grep exited ${grepped.code ?? 'without running'} — ${tailText(grepped.stderr, 2).join(' ')}`
      )
      continue
    }
    const hits = grepped?.ok ? grepped.stdout.split('\n').filter(Boolean) : []
    if (hits.length > 0) {
      details.push(...hits)
      continue
    }
    // The runbook greps the whole file list in one command, so a generic `updater-*.ts` helper
    // that never names a repo is normal and only reported. A missing reference in the two files
    // that hold the fork's feed override is the failure this check exists for.
    if (FEED_FILES.includes(file)) {
      missing.push(file)
      details.push(`${file}: no reference to ${FORK_SLUG}${present ? '' : ' (file is missing)'}`)
    } else {
      details.push(`${file}: no reference, expected for a generic updater helper`)
    }
  }
  if (globbed.length === 0) {
    details.push(
      `${FEED_GLOB.dir}/${FEED_GLOB.prefix}*.ts is empty: upstream may have moved the updater`
    )
  }
  const failed = scanFailures.length > 0
  return {
    status: failed || missing.length > 0 ? STATUS.failed : STATUS.passed,
    summary: failed
      ? `the fork-reference scan could not run for ${scanFailures.length} file(s)`
      : missing.length === 0
        ? `feed override still points at the fork (${globbed.length} ${FEED_GLOB.prefix}*.ts helper(s) scanned)`
        : `${missing.length} feed override file(s) lost the fork reference`,
    details: [...scanFailures.map((line) => `  ! ${line}`), ...details]
  }
}

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
  const reportOnly = report.counts?.reportOnly ?? 0
  return {
    status: fixable === 0 ? STATUS.passed : STATUS.failed,
    summary:
      fixable === 0
        ? `no fixable violations, ${reportOnly} report-only (${sweep})`
        : `${fixable} fixable violation(s) (${sweep})`,
    details: [
      `${reportOnly} report-only finding(s) are informational and need a decision, not a rewrite`,
      ...(report.fixable ?? [])
        .slice(0, 30)
        .map((hit) => `  ! ${hit.file}:${hit.line}  ${hit.text} -> ${hit.to}`)
    ]
  }
}

// The pre-sync tip is what "ours" means for the checks below. The state file is written by
// `pre-sync.mjs --prepare`; the backup ref covers a sync prepared by hand from the runbook.
export function resolvePreSyncTip() {
  const { state, source, file } = readSyncState()
  if (state?.oldTip && refExists(`${state.oldTip}^{commit}`)) {
    return { tip: state.oldTip, source: `${source} (${file})` }
  }
  const backup = gitText(['rev-parse', '--verify', '--quiet', `refs/heads/${BACKUP_REF}`])
  return backup ? { tip: backup, source: `ref ${BACKUP_REF}` } : { tip: null, source: null }
}

// The upstream base this sync recorded, i.e. `pre-sync.mjs --prepare`'s newBase. The red-flag scan
// must not compare against the moving `upstream/main`: upstream keeps advancing after the sync, and
// the set of files it "touched in this range" would change under the check.
//
// With no state file the only records left are the backup ref, which names the pre-sync TIP, and the
// merged tree itself, so the base is derived from HEAD: `merge-base(HEAD, upstream/main)` is a commit
// in HEAD's own history, so it does not move as upstream advances. Deriving it from the pre-sync tip
// instead yields the PREVIOUS sync's base and collapses the upstream range to nothing.
export function pinnedUpstreamBase(tip, source) {
  const { state, source: stateSource, file } = readSyncState()
  if (state?.newBase) {
    const resolved = gitText(['rev-parse', '--verify', '--quiet', `${state.newBase}^{commit}`])
    return resolved
      ? { base: resolved, source: `${stateSource} (${file})` }
      : {
          base: null,
          source: null,
          problem: `the state file records new base ${state.newBase}, which does not resolve to a commit`
        }
  }
  const derived = gitText(['merge-base', 'HEAD', UPSTREAM_REF])
  return derived
    ? {
        base: derived,
        source: `merge-base(HEAD, ${UPSTREAM_REF}) (no state file${source ? `; tip from ${source}` : ''})`
      }
    : {
        base: null,
        source: null,
        problem: `no recorded base: no state file, and no merge base between HEAD and ${UPSTREAM_REF}`
      }
}

// Runbook Step 3.1, the check that catches the dropped-merge-commit trap: a MODIFIED file that
// upstream never touched in this sync's range means the replay moved content it did not own. A path
// upstream does not have at all is fork-only by construction, and expected here. This is a red-flag
// scan over modified files — it does not prove that no content was lost anywhere else.
export function lostContent(tip, source) {
  if (!tip) {
    return {
      status: STATUS.unavailable,
      summary: `no pre-sync tip: ${BACKUP_REF} is absent and no state file names one`,
      details: []
    }
  }
  const pinned = pinnedUpstreamBase(tip, source)
  if (pinned.base === null) {
    return {
      status: STATUS.failed,
      summary: `cannot pin the upstream base: ${pinned.problem}`,
      details: [
        'the scan compares against the base pre-sync recorded; without it the answer is unknown, not clean'
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
  const upstreamChanged = changedNames([oldBase, base])
  const modified = changedNames(['--diff-filter=M', tip, 'HEAD'])
  // A failed diff has to read as a failed check: an empty result set looks exactly like "nothing
  // modified here", which is the clean answer this scan must not invent.
  if (upstreamChanged === null || modified === null) {
    const range =
      upstreamChanged === null
        ? `${oldBase.slice(0, 10)}..${base.slice(0, 10)}`
        : `${tip.slice(0, 10)}..HEAD`
    return {
      status: STATUS.failed,
      summary: `git diff --name-only failed for ${range}`,
      details: ['the modified/upstream-touched sets are unknown, so the scan cannot report clean']
    }
  }
  const upstreamFiles = new Set(upstreamChanged)
  const redFlags = []
  const forkOnly = []
  for (const file of modified.filter((name) => !upstreamFiles.has(name))) {
    // The pinned base resolves, so a cat-file miss means the path is absent there (fork-only
    // by construction), not that the probe failed.
    if (git(['cat-file', '-e', `${base}:${file}`]).ok) {
      redFlags.push(file)
    } else {
      forkOnly.push(file)
    }
  }
  return {
    // A review pointer, not a verdict. The runbook calls a modified file upstream never touched a
    // "red flag", and it is one — the merge's own resolutions legitimately touch such files (a
    // barrel re-point after an extraction, for instance), so failing here would make this gate
    // permanently red and therefore ignored. Deletions, which can be proven unreferenced, still
    // fail; this lists what a reviewer should look at.
    status: STATUS.info,
    summary:
      redFlags.length === 0
        ? `red-flag scan clear (modified files only); ${forkOnly.length} fork-only file(s) listed below`
        : `${redFlags.length} modified file(s) upstream never touched in this range — review them, not proven lost`,
    details: [
      `pre-sync tip: ${tip.slice(0, 10)} from ${source}`,
      `pinned upstream base: ${base.slice(0, 10)} from ${pinned.source}`,
      `old base (merge-base of that tip and the pinned base): ${oldBase.slice(0, 10)}`,
      `${modified.length} file(s) modified here, ${upstreamFiles.size} file(s) upstream touched`,
      `red flags (the pinned base knows the path but upstream did not touch it in this range): ${redFlags.length}`,
      ...(redFlags.length === 0 ? [] : redFlags.slice(0, 30).map((file) => `  ! ${file}`)),
      `fork-only by construction (path absent at the pinned base), expected here: ${forkOnly.length}`,
      ...forkOnly.slice(0, 30).map((file) => `  - ${file}`)
    ]
  }
}

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
 */
function readExpectedDeletions() {
  const file = path.join(repoRoot(), 'local/sync/expected-deletions.json')
  if (!existsSync(file)) {
    return { acknowledged: {}, stale: [], failure: null }
  }
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    const acknowledged = parsed?.acknowledged
    if (acknowledged === null || typeof acknowledged !== 'object') {
      return { acknowledged: {}, stale: [], failure: `${file} has no \`acknowledged\` object` }
    }
    return { acknowledged, stale: [], failure: null }
  } catch (error) {
    return {
      acknowledged: {},
      stale: [],
      failure: `${file} could not be parsed: ${error instanceof Error ? error.message : String(error)}`
    }
  }
}

export function deletedForkModules(tip, source) {
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
  const upstreamChanged = changedNames([oldBase, base])
  // Renames off, deliberately: git pairs a deletion with a similar addition and reports the pair as
  // `R`, which removes the deleted path from `--diff-filter=D` — the one entry this scan exists to
  // list. `filesystem-text-search-handler.ts` disappeared from the list exactly that way.
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
  const expectations = readExpectedDeletions()
  if (expectations.failure !== null) {
    scanFailures.push(expectations.failure)
  }
  const acknowledgedPaths = Object.keys(expectations.acknowledged)
  const deletedSet = new Set(deleted)
  const staleAcknowledgements = acknowledgedPaths.filter((file) => !deletedSet.has(file))
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
            `      ~ ${name} (${kind}) — no reference left, acknowledged as superseded by ${ack.supersededBy ?? 'an unnamed replacement'}`
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
      `acknowledged deletions no longer deleted (stale entries in local/sync/expected-deletions.json): ${staleAcknowledgements.length}`
    )
    for (const file of staleAcknowledgements) {
      details.push(`  ? ${file}`)
    }
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
