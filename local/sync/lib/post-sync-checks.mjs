// The post-sync-only checks, drawn from the runbook's Step 3 and the previous syncs' logs.
//
// Each check returns `{ status, summary, details }` (see lib/checks.mjs for the shared ones); the
// driver owns the check's title, its remediation text and its place in the report. Split out of
// post-sync.mjs only so that file stays a readable driver.

import { existsSync, readdirSync } from 'node:fs'
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

// The pre-sync tip is what "ours" means for the lost-content check. The state file is written by
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
    status: redFlags.length === 0 ? STATUS.passed : STATUS.failed,
    summary:
      redFlags.length === 0
        ? `red-flag scan clear (modified files only); ${forkOnly.length} fork-only file(s) listed below`
        : `${redFlags.length} modified file(s) upstream never touched in this range`,
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
