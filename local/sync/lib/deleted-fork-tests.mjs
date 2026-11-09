// The fork-modified test files upstream deleted, which nothing else in the post-sync report can see.
//
// Why: `deletedForkModules` deliberately skips test files (a test is not a module a caller imports),
// and `lostContent` only scans files that are still modified at HEAD. So a test the fork had edited —
// extra cases, a re-pointed expectation — that upstream retired in the sync simply stops existing, and
// the only trace is a deletion inside a 1537-commit merge. The 2026-11-08 sync left 449 of them.
//
// The gate is a baseline bound to the sync range: `base` and `tip` are recorded, and a baseline whose
// range does not match the range being checked contributes nothing. So it cannot absorb the next
// sync's set — that sync reports its own and fails until someone re-runs `--baseline-init --accept`
// with a reason. Regenerate with:
//
//   node local/sync/lib/deleted-fork-tests.mjs --baseline-init --accept "<why>"
//
// The pure part is `forkModifiedTests` + `compareDeletedForkTests`; `upstreamDeletedForkTests()` is the
// post-sync row, and the CLI at the bottom writes the baseline.

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'
import { STATUS, changedNames, gitText, repoRoot, run, splitNul } from './run.mjs'
import {
  BACKUP_REF,
  foreignTipFailure,
  pinnedUpstreamBase,
  resolvePreSyncTip
} from './sync-range.mjs'

export const BASELINE_PATH = path.join('local', 'sync', 'upstream-deleted-fork-tests-baseline.json')
export const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/

/**
 * `changed` is what the fork modified between the old base and the pre-sync tip (no renames, `M`
 * only: a file the fork added cannot have been retired by upstream). `gone` is the subset absent at
 * HEAD, which is the loss this exists to name.
 */
export function forkModifiedTests({ changed, presentAtHead }) {
  const modified = [...changed].filter((file) => TEST_FILE.test(file)).sort()
  const gone = modified.filter((file) => !presentAtHead.has(file))
  // A file upstream moved rather than retired shows up here as gone, so the report separates the two:
  // a same-basename file at HEAD may or may not carry the fork's cases, and saying which are which is
  // the reviewer's job, not a guess this can make.
  const basenames = new Set()
  for (const file of presentAtHead) {
    basenames.add(file.slice(file.lastIndexOf('/') + 1))
  }
  const moved = gone.filter((file) => basenames.has(file.slice(file.lastIndexOf('/') + 1)))
  return { modified, gone, moved }
}

export function buildBaseline(gone, { base, tip, accepted, note }) {
  const files = {}
  for (const file of [...gone].sort()) {
    files[file] = true
  }
  return { note, base, tip, ...(accepted ? { accepted } : {}), total: gone.length, files }
}

/**
 * A baseline from another range contributes nothing: the set is a property of one merge, and reusing
 * it would make the next sync's losses look recorded.
 */
export function compareDeletedForkTests({ baseline, gone, range }) {
  if (baseline === null || typeof baseline !== 'object') {
    return { bound: false, appeared: [...gone].sort(), stale: [], clean: false }
  }
  const bound = baseline.base === range.base && baseline.tip === range.tip
  const known = new Set(bound ? Object.keys(baseline.files ?? {}) : [])
  const appeared = [...gone].filter((file) => !known.has(file)).sort()
  const present = new Set(gone)
  const stale = bound
    ? Object.keys(baseline.files ?? {})
        .filter((file) => !present.has(file))
        .sort()
    : []
  return { bound, appeared, stale, clean: bound && appeared.length === 0 }
}

export function readBaseline(root) {
  const file = path.join(root, BASELINE_PATH)
  if (!existsSync(file)) {
    return { baseline: null, problem: `${BASELINE_PATH} is missing` }
  }
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    if (parsed === null || typeof parsed !== 'object' || typeof parsed.files !== 'object') {
      return { baseline: null, problem: `${BASELINE_PATH} has no files map` }
    }
    return { baseline: parsed, problem: null }
  } catch (error) {
    return { baseline: null, problem: `${BASELINE_PATH} is not valid JSON: ${error.message}` }
  }
}

export function describeComparison(comparison, { total, moved = [] }) {
  return [
    moved.length === 0
      ? `${total} fork-modified test file(s) are gone at HEAD`
      : `${total} fork-modified test file(s) are gone at HEAD, ${moved.length} of them with a same-named file elsewhere — check whether the fork's cases moved with it`,
    ...(comparison.bound
      ? []
      : [
          `  ! ${BASELINE_PATH} was written for another sync range, so it records none of them —`,
          '    re-run `node local/sync/lib/deleted-fork-tests.mjs --baseline-init --accept "<why>"`'
        ]),
    ...comparison.appeared.slice(0, 60).map((file) => `  ! ${file}`),
    ...(comparison.appeared.length > 60 ? [`  ... ${comparison.appeared.length - 60} more`] : []),
    ...(comparison.stale.length === 0
      ? []
      : [
          `  ? ${comparison.stale.length} baseline entr(ies) are present again — re-run --baseline-init`
        ])
  ]
}

// The writer. Resolves the same range the post-sync row uses, so the baseline it writes is the one
// that row will accept.
async function main(argv = process.argv.slice(2), root = process.cwd()) {
  if (!argv.includes('--baseline-init')) {
    process.stderr.write(
      'usage: node local/sync/lib/deleted-fork-tests.mjs --baseline-init [--accept <reason>]\n'
    )
    return 2
  }
  const acceptAt = argv.indexOf('--accept')
  const accepted = acceptAt === -1 ? null : (argv[acceptAt + 1] ?? '').trim()
  if (acceptAt !== -1 && accepted === '') {
    process.stderr.write('deleted-fork-tests: --accept needs a reason\n')
    return 2
  }
  const where = root
  const { tip, source, problem } = resolvePreSyncTip()
  if (problem !== null || !tip) {
    process.stderr.write(
      `deleted-fork-tests: no usable pre-sync tip — ${problem ?? 'none found'}\n`
    )
    return 2
  }
  const pinned = pinnedUpstreamBase(tip, source)
  if (pinned.base === null) {
    process.stderr.write(`deleted-fork-tests: cannot pin the upstream base — ${pinned.problem}\n`)
    return 2
  }
  const oldBase = gitText(['merge-base', tip, pinned.base])
  if (!oldBase) {
    process.stderr.write(`deleted-fork-tests: no merge base between ${tip} and ${pinned.base}\n`)
    return 2
  }
  const listing = gitText(['ls-tree', '-r', '--name-only', '-z', 'HEAD'])
  const changed = run('git', [
    'diff',
    '--name-only',
    '-z',
    '--no-renames',
    '--diff-filter=M',
    oldBase,
    tip
  ])
  if (!changed.ok || listing === null) {
    process.stderr.write('deleted-fork-tests: git could not read the range\n')
    return 2
  }
  const { gone } = forkModifiedTests({
    changed: splitNul(changed.stdout),
    presentAtHead: new Set(splitNul(listing))
  })
  const previous = readBaseline(where).baseline
  // A count comparison across two ranges proves nothing: the next sync loses a different set, so
  // "300 is fewer than 449" would rebaseline silently. The test is the same one the row runs — a
  // baseline bound to another range records nothing, so every path is new.
  const comparison =
    previous === null
      ? null
      : compareDeletedForkTests({ baseline: previous, gone, range: { base: pinned.base, tip } })
  const unrecorded = comparison !== null && (!comparison.bound || comparison.appeared.length > 0)
  if (unrecorded && accepted === null) {
    process.stderr.write(
      `deleted-fork-tests: refusing to record unrecorded loss — ` +
        `${comparison.bound ? `${comparison.appeared.length} path(s) this range did not have before` : `the baseline was written for ${previous.base.slice(0, 10)}/${previous.tip.slice(0, 10)}, not this range`}. ` +
        'Pass --accept <reason> when the loss is not this branch\u2019s to fix.\n'
    )
    return 1
  }
  const note =
    'Fork-modified test files that are gone at HEAD after a sync (deleted by upstream, or by the ' +
    'resolution). Bound to one sync range: a baseline whose base/tip do not match the range being ' +
    'checked records nothing. Regenerate with `node local/sync/lib/deleted-fork-tests.mjs ' +
    '--baseline-init [--accept <reason>]`.'
  // Re-running on the same range is the documented way to lock in a shrink, and it passes no
  // `--accept`; dropping the reason that is already recorded would lose it for good, because this
  // tool has no prune mode to carry it forward.
  const keptReason = accepted ?? (comparison?.bound ? (previous.accepted ?? null) : null)
  const baseline = buildBaseline(gone, {
    base: pinned.base,
    tip,
    accepted: keptReason,
    note
  })
  writeFileSync(path.join(where, BASELINE_PATH), `${JSON.stringify(baseline, null, 2)}\n`)
  process.stdout.write(
    `deleted-fork-tests: wrote ${BASELINE_PATH} — ${gone.length} path(s)` +
      `${previous ? ` (was ${previous.total})` : ''}\n`
  )
  if (unrecorded) {
    process.stdout.write(`deleted-fork-tests: accepted — ${accepted}\n`)
  }
  return 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2), repoRoot()).then(
    (code) => {
      process.exitCode = code
    },
    (error) => {
      process.stderr.write(`deleted-fork-tests: ${error.message}\n`)
      process.exitCode = 2
    }
  )
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
  const { modified, gone, moved } = forkModifiedTests({
    changed,
    presentAtHead: new Set(splitNul(listing))
  })
  const { baseline, problem: baselineProblem } = readBaseline(repoRoot())
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
      ...describeComparison(comparison, { total: gone.length, moved })
    ]
  }
}
