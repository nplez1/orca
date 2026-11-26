/**
 * The refusals that stand between a review round and a wasted reviewer: what the gates say about the
 * revision a packet covers, whether a delta round is worth opening, and whether the loop may close.
 *
 * `gitText` and `repoRoot` come in from the caller — the CLI builds them from the repository it runs in
 * — so this module reads no global state and can be driven from fixtures.
 */
import { existsSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  lintVerdictProblem,
  resolvedGateCacheDir,
  unitVerdictProblem
} from '../gate-verdict-cache.mjs'
import { reviewState } from './manifest.mjs'
import { BLOCKING } from './verdict.mjs'

export const short = (sha) => String(sha).slice(0, 12)

/**
 * Why the gates are checked before a packet is written: the reviewer reads the working tree, so a lint
 * step or a unit class that will fail afterwards makes the whole round worthless — on 2026-11-24 the
 * five lint repairs landed after six review rounds and each repair opened another delta.
 */
export function preconditionProblems({ gitText, repoRoot }) {
  const problems = []
  const dirty = gitText(['status', '--porcelain', '--untracked-files=no'])
    .split('\n')
    .filter(Boolean)
  if (dirty.length) {
    problems.push(
      `the working tree has ${String(dirty.length)} uncommitted change(s) (${dirty
        .slice(0, 3)
        .map((line) => line.slice(3))
        .join(', ')}); commit them first`
    )
  }
  const revision = gitText(['rev-parse', 'HEAD']).trim()
  // Why caught: `rev-parse --verify` exits non-zero for a missing ref, and this refusal has to name the
  // fix rather than surface git's error.
  let originProblem = null
  try {
    gitText(['rev-parse', '--verify', 'origin/main'])
    gitText(['merge-base', '--is-ancestor', 'origin/main', 'HEAD'])
  } catch {
    originProblem = `origin/main is not an ancestor of HEAD (${short(revision)}); bring it in first: git fetch origin && git merge origin/main`
  }
  if (originProblem) {
    problems.push(originProblem)
  }
  const commonDir = gitText(['rev-parse', '--path-format=absolute', '--git-common-dir']).trim()
  const cacheDir = resolvedGateCacheDir({ commonDir, root: repoRoot })
  problems.push(
    ...[lintVerdictProblem({ commonDir, revision, git: gitText })].filter(Boolean),
    ...[
      unitVerdictProblem({
        cacheDir,
        revision,
        allowlistPath: join(repoRoot, 'local', 'unit-known-red.json'),
        git: gitText
      })
    ].filter(Boolean)
  )
  return problems
}

/** Why in the packet: an exception a reader cannot find is not recorded, as with open-pr's waivers. */
export function recordPacketNotes(dir, packet, notes) {
  const recorded = Object.entries(notes).filter(([, reason]) => String(reason ?? '').trim())
  if (!recorded.length) {
    return
  }
  for (const [key, reason] of recorded) {
    packet[key] = { reason: String(reason).trim(), recordedAt: new Date().toISOString() }
  }
  writeFileSync(join(dir, 'packet.json'), `${JSON.stringify(packet, null, 2)}\n`)
}

export const roundCounts = (entry) => {
  const counts = entry?.report?.counts
  return counts
    ? `${String(counts.blockers)} BLOCKER, ${String(counts.shouldFix)} SHOULD-FIX, ${String(counts.minors)} MINOR, ${String(counts.nits)} NIT`
    : 'no report'
}

/** A round with nothing above MINOR/NIT proved the fixes it re-checked; an unreported one proves nothing. */
export const aboveMinor = (entry) => {
  const counts = entry?.report?.counts
  return counts ? counts.blockers + counts.shouldFix : 1
}

/**
 * Why the loop stops here: rounds 5-14 of the 2026-11-24 review found zero blockers and one should-fix,
 * and three deltas were opened to fix MINORs — ~11 minutes each, for findings the PR body already lists.
 */
export function deltaStopProblems({ deltas, next, force, approve }) {
  const problems = []
  const previous = deltas[next - 2]
  if (!force && previous && previous.report.status === 'reported' && aboveMinor(previous) === 0) {
    problems.push(
      `delta round ${String(next - 1)} reported nothing above MINOR/NIT (${roundCounts(previous)}), and MINOR/NIT are listed in the PR body, not fixed; record the override if this round is still needed: --force-delta "<why>"`
    )
  }
  if (next >= 4 && Number(approve) !== next) {
    problems.push(
      `${String(next - 1)} delta round(s) have run and this would be round ${String(next)}; the last one found ${roundCounts(deltas.at(-1))} — pass --approve-round ${String(next)} to record the decision to open another`
    )
  }
  return problems
}

/** The same rule at the spend boundary: a round the loop should not open is not worth a reviewer boot. */
export function deltaRunProblems(dir, options) {
  const parentDir = dirname(dir)
  if (!existsSync(join(parentDir, 'packet.json'))) {
    return []
  }
  const deltas = reviewState(parentDir).slices.filter((entry) => entry.kind === 'delta')
  const index = deltas.findIndex((entry) => entry.dir === dir)
  return deltaStopProblems({
    deltas,
    next: index === -1 ? deltas.length + 1 : index + 1,
    force: Boolean(options['force-delta']),
    approve: options['approve-round']
  })
}

/**
 * Why the loop may close here: a MINOR/NIT is listed in the PR body, not fixed, and the gate itself
 * treats only BLOCKER/SHOULD-FIX as blocking — so this states the outcome instead of leaving a reader
 * to infer it from three counts.
 */
export function closingLine(state, manifest) {
  const open = manifest.slices
    .flatMap((slice) => slice.findings ?? [])
    .filter((finding) => finding.status === 'open')
  if (open.some((finding) => BLOCKING.has(finding.severity))) {
    return null
  }
  const count = (severity) => open.filter((finding) => finding.severity === severity).length
  const minors = count('MINOR')
  const nits = count('NIT')
  if (!minors && !nits) {
    return null
  }
  return `release-review: closing at round ${String(state.rounds.length)} with ${String(minors)} MINOR / ${String(nits)} NIT recorded and unfixed — the release may proceed; list them in the PR body`
}
