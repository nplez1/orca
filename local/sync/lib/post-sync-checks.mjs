// The post-sync-only checks, drawn from the runbook's Step 3 and the previous syncs' logs.
//
// Each check returns `{ status, summary, details }` (see lib/checks.mjs for the shared ones); the
// driver owns the check's title, its remediation text and its place in the report. Split out of
// post-sync.mjs only so that file stays a readable driver.

import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { citedGuards as extractCitedGuards, missingCitedGuards } from './cited-guards.mjs'
import {
  compareDeletedForkTests,
  describeComparison as describeDeletedForkTests,
  forkModifiedTests,
  readBaseline as readDeletedForkTestsBaseline
} from './deleted-fork-tests.mjs'
import {
  compareIdentityBaseline,
  describeComparison,
  readIdentityBaseline
} from './identity-baseline.mjs'
import { LOCALES_DIR, localeDriftReport } from './locale-drift.mjs'
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

// Runbook Step 3.1, the check that catches the dropped-merge-commit trap: a MODIFIED file that
// upstream never touched in this sync's range means the replay moved content it did not own. A path
// upstream does not have at all is fork-only by construction, and expected here. This is a red-flag
// scan over modified files — it does not prove that no content was lost anywhere else.
export function lostContent(tip, source, problem = null) {
  if (problem !== null) {
    return foreignTipFailure(
      problem,
      'the scan would compare the wrong range and report clean, so it refuses instead'
    )
  }
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
// ---- cited guards ----------------------------------------------------------------------------

/**
 * Every test path and package script LOCAL-PATCHES.md cites, resolved against the tree.
 *
 * The ledger is the only record of why each fork patch exists, and its citations are how a reader
 * checks one. Nothing read them, so the 2026-11-08 sync moved 14 cited tests into upstream's
 * owner-scoped directories, retired 16 more, and dropped the `rebuild:mac:relaunch-installed` script
 * without anything going red. This is the row that reads them.
 */
export function citedGuards() {
  const file = path.join(repoRoot(), 'LOCAL-PATCHES.md')
  let markdown = null
  try {
    markdown = readFileSync(file, 'utf8')
  } catch {
    return {
      status: STATUS.failed,
      summary: 'LOCAL-PATCHES.md could not be read',
      details: [file]
    }
  }
  const tracked = gitText(['ls-files', '-z'])
  if (tracked === null) {
    return {
      status: STATUS.failed,
      summary: 'git ls-files failed, so no citation can be resolved',
      details: []
    }
  }
  let scripts = null
  try {
    scripts = JSON.parse(readFileSync(path.join(repoRoot(), 'package.json'), 'utf8')).scripts
  } catch {
    return {
      status: STATUS.failed,
      summary: 'package.json could not be read, so no script citation can be resolved',
      details: []
    }
  }
  const cited = extractCitedGuards(markdown)
  const result = missingCitedGuards({
    cited,
    tracked: splitNul(tracked),
    scripts: scripts ?? {}
  })
  const details = [
    `${result.checkedPaths} cited test path(s) and ${result.checkedScripts} cited script(s) resolved`,
    ...result.missingPaths.map((file) => `  ! ${file} — cited, but no tracked file matches`),
    ...result.missingScripts.map(
      (name) => `  ! ${name} — cited, but package.json has no such script`
    )
  ]
  const missing = result.missingPaths.length + result.missingScripts.length
  return {
    status: missing === 0 ? STATUS.passed : STATUS.failed,
    summary:
      missing === 0
        ? `every guard LOCAL-PATCHES.md cites still exists (${result.checkedPaths} path(s), ${result.checkedScripts} script(s))`
        : `${missing} guard(s) LOCAL-PATCHES.md cites no longer exist`,
    details
  }
}

// ---- locale tombstones -----------------------------------------------------------------------

/**
 * `src/renderer/src/i18n/locales/` must be upstream's, byte-for-byte.
 *
 * LOCAL-PATCHES.md § local(i18n) says so and nothing enforced it, so the 2026-11-08 sync deleted
 * three keys from all 11 catalogs — the twelve highest-churn paths in the tree — which is 11 files
 * that will conflict again on the next sync for no reason at all. The fork's own strings and its
 * orphan tombstones live in `i18n/fork/*.json`.
 */
export function localeDrift() {
  const base = gitText(['merge-base', 'HEAD', UPSTREAM_REF])
  if (!base) {
    return {
      status: STATUS.unavailable,
      summary: `${UPSTREAM_REF} is not fetched, so the locale ruler cannot be placed`,
      details: ['run: git fetch upstream']
    }
  }
  const changed = changedNames([base, 'HEAD', '--', LOCALES_DIR])
  if (changed === null) {
    return {
      status: STATUS.failed,
      summary: `git diff ${base.slice(0, 10)}..HEAD failed for ${LOCALES_DIR}/`,
      details: ['an unreadable diff is not an empty one']
    }
  }
  const report = localeDriftReport({ base, changed })
  return {
    status: report.clean ? STATUS.passed : STATUS.failed,
    summary: report.detail,
    details: [
      ...report.files.map((file) => `  ! ${file}`),
      ...(report.clean
        ? []
        : [
            'restore the file to upstream and tombstone the key in src/renderer/src/i18n/fork/<lang>.json:',
            '  git checkout <upstream-base> -- src/renderer/src/i18n/locales/'
          ])
    ]
  }
}

// ---- fork-modified tests upstream deleted ----------------------------------------------------

/**
 * Fork-modified test files that are gone at HEAD after the sync.
 *
 * Invisible to every other row: `deletedForkModules` skips tests on purpose, and `lostContent` only
 * sees files still modified at HEAD. The gate is a baseline bound to this sync's range, so the next
 * sync reports its own set instead of inheriting this one's.
 */
export function upstreamDeletedForkTests(tip, source, problem = null) {
  if (problem !== null) {
    return foreignTipFailure(
      problem,
      'the scan would read the wrong range and report clean, so it refuses instead'
    )
  }
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
      details: ['without it the set is unmeasurable, which is not the same as empty']
    }
  }
  const oldBase = gitText(['merge-base', tip, pinned.base])
  if (!oldBase) {
    return {
      status: STATUS.failed,
      summary: `no merge base between ${tip.slice(0, 10)} and the pinned base ${pinned.base.slice(0, 10)}`,
      details: []
    }
  }
  // `M` only, renames off: a file the fork added cannot have been retired by upstream, and a rename
  // pair drops the old path from the set this classifier reads.
  const changed = changedNames(['--no-renames', '--diff-filter=M', oldBase, tip])
  const listing = gitText(['ls-tree', '-r', '--name-only', '-z', 'HEAD'])
  if (changed === null || listing === null) {
    return {
      status: STATUS.failed,
      summary: `git could not read ${oldBase.slice(0, 10)}..${tip.slice(0, 10)} or the HEAD tree`,
      details: []
    }
  }
  const { modified, gone } = forkModifiedTests({
    changed,
    presentAtHead: new Set(splitNul(listing))
  })
  const { baseline, problem: baselineProblem } = readDeletedForkTestsBaseline(repoRoot())
  if (baseline === null) {
    return {
      status: STATUS.failed,
      summary: `the deleted-test baseline cannot be read: ${baselineProblem}`,
      details: [
        'an unreadable baseline is not "nothing was lost"; regenerate it with',
        '  node local/sync/lib/deleted-fork-tests.mjs --baseline-init --accept "<why>"'
      ]
    }
  }
  const comparison = compareDeletedForkTests({
    baseline,
    gone,
    range: { base: pinned.base, tip }
  })
  return {
    status: comparison.clean ? STATUS.passed : STATUS.failed,
    summary: comparison.clean
      ? `${gone.length} fork-modified test file(s) gone at HEAD, all recorded for this range`
      : `${comparison.appeared.length} fork-modified test file(s) gone at HEAD and not recorded`,
    details: [
      `${modified.length} test file(s) the fork modified between ${oldBase.slice(0, 10)} and the pre-sync tip`,
      ...describeDeletedForkTests(comparison, { total: gone.length })
    ]
  }
}
