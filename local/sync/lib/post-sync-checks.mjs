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
  const globbed = files.filter((file) => !FEED_FILES.includes(file))
  for (const file of files) {
    const present = existsSync(path.join(repoRoot(), file))
    const hits = present
      ? (gitText(['grep', '-n', '-F', '-e', FORK_SLUG, '--', file]) ?? '')
          .split('\n')
          .filter(Boolean)
      : []
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
  return {
    status: missing.length === 0 ? STATUS.passed : STATUS.failed,
    summary:
      missing.length === 0
        ? `feed override still points at the fork (${globbed.length} ${FEED_GLOB.prefix}*.ts helper(s) scanned)`
        : `${missing.length} feed override file(s) lost the fork reference`,
    details
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
  const result = run('node', [toolPath(sweep)], { cwd: repoRoot() })
  return {
    status: result.ok ? STATUS.passed : STATUS.failed,
    summary: result.ok
      ? `no violations (${sweep})`
      : `violations found (exit ${result.code ?? 'did not run'})`,
    details: headText(`${result.stdout}\n${result.stderr}`, 30)
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

// Runbook Step 3.1, the check that catches the dropped-merge-commit trap: a MODIFIED file that
// upstream never touched in this sync's range means the replay moved content it did not own. A
// path upstream does not have at all is fork-only by construction, and expected here.
export function lostContent(tip, source) {
  if (!tip) {
    return {
      status: STATUS.unavailable,
      summary: `no pre-sync tip: ${BACKUP_REF} is absent and no state file names one`,
      details: []
    }
  }
  const oldBase = gitText(['merge-base', tip, UPSTREAM_REF])
  if (!oldBase) {
    return {
      status: STATUS.failed,
      summary: `no merge base between ${tip.slice(0, 10)} and ${UPSTREAM_REF}`,
      details: []
    }
  }
  const upstreamChanged = new Set(changedNames([oldBase, UPSTREAM_REF]) ?? [])
  // Renames and deletes are covered by the content at the added path, so the runbook's diff
  // filter stays M; anything wider would flag every file upstream renamed.
  const modified = changedNames(['--diff-filter=M', tip, 'HEAD']) ?? []
  const redFlags = []
  const forkOnly = []
  for (const file of modified.filter((name) => !upstreamChanged.has(name))) {
    if (git(['cat-file', '-e', `${UPSTREAM_REF}:${file}`]).ok) {
      redFlags.push(file)
    } else {
      forkOnly.push(file)
    }
  }
  return {
    status: redFlags.length === 0 ? STATUS.passed : STATUS.failed,
    summary:
      redFlags.length === 0
        ? `no unexpected change; ${forkOnly.length} fork-only file(s) listed below`
        : `${redFlags.length} modified file(s) upstream never touched`,
    details: [
      `pre-sync tip: ${tip.slice(0, 10)} from ${source}`,
      `old base (merge-base of that tip and ${UPSTREAM_REF}): ${oldBase.slice(0, 10)}`,
      `${modified.length} file(s) modified here, ${upstreamChanged.size} file(s) upstream touched`,
      `red flags (upstream knows the path but did not touch it in this range): ${redFlags.length}`,
      ...(redFlags.length === 0 ? [] : redFlags.slice(0, 30).map((file) => `  ! ${file}`)),
      `fork-only by construction (path does not exist upstream), expected: ${forkOnly.length}`,
      ...forkOnly.slice(0, 30).map((file) => `  - ${file}`)
    ]
  }
}
