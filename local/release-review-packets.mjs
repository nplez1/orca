#!/usr/bin/env node
/**
 * Prepares, runs and records the release review that `local/release-review-gate.mjs` requires.
 *
 * Why this exists. The 2026-11-15 release improvised its review: a 10.1 MB remerge diff cut into six
 * equal line ranges, a hand-written prompt, six `claude -p … &` runs of which four failed first time
 * on sandbox refusals, two hand-written delta prompts, and a manifest assembled by hand. 62% of that
 * diff was generated or mechanical content another gate already verifies. This makes each step a
 * command, so the review reads what only a review can check and the manifest is a product of the
 * outputs rather than a summary of them.
 *
 *   node local/release-review-packets.mjs --prepare [--merge <sha>] [--budget-kb 384]
 *   node local/release-review-packets.mjs --prepare --delta <R1>..<R2> [--findings <file.json>]
 *   node local/release-review-packets.mjs --run [--slices A,C] [--concurrency 6]
 *                                         [--max-budget-usd <per slice>] [--timeout-min 90]
 *   node local/release-review-packets.mjs --status
 *   node local/release-review-packets.mjs --print > /var/tmp/manifest.json   # inspect only
 *   node local/release-review-packets.mjs --write    # records it for the revision it covers
 *
 * Every mode works on HEAD's sync (the newest merge on HEAD's first-parent line), or on `--merge`.
 * Packets live in `<git dir>/orca-review/sync-<merge>/`; `--packet <dir>` names one directly.
 * `--findings` defaults to every finding no round has resolved yet.
 *
 * Exit: 0 done, 1 refused or incomplete, 2 usage.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { REVIEWER } from './pr-body-claims.mjs'
import { manifestPath, reviewNeutralOnly, validateManifest } from './release-review-gate.mjs'
import { loadCoverageContext } from './review-packets/exclusions.mjs'
import { buildManifest, openFindings, reviewState } from './review-packets/manifest.mjs'
import {
  DEFAULT_BUDGET_KB,
  git,
  headSyncMerge,
  prepareDelta,
  prepareSync,
  syncPacketDir
} from './review-packets/packet.mjs'
import { runSlices } from './review-packets/run.mjs'

const repoRoot = git(join(import.meta.dirname, '..'), ['rev-parse', '--show-toplevel']).trim()
const MODES = ['prepare', 'run', 'status', 'print', 'write']
const VALUED = [
  'merge',
  'budget-kb',
  'delta',
  'findings',
  'slices',
  'concurrency',
  'max-budget-usd',
  'max-estimate-usd',
  'timeout-min',
  'packet'
]
/** Why validated: `--timeout-min x` becomes `setTimeout(NaN)`, which fires at once and kills every
 * slice, and `--concurrency x` starts no worker at all — both after paying for the packet. */
const NUMERIC = ['budget-kb', 'concurrency', 'max-budget-usd', 'max-estimate-usd', 'timeout-min']

const short = (sha) => String(sha).slice(0, 12)

export function parseArgs(argv) {
  const options = { mode: null }
  for (let i = 0; i < argv.length; i += 1) {
    const name = argv[i].replace(/^--/, '')
    if (MODES.includes(name)) {
      if (options.mode) {
        throw new Error(`pick one of --${MODES.join(', --')}`)
      }
      options.mode = name
    } else if (VALUED.includes(name) && argv[i + 1] !== undefined) {
      options[name] = argv[i + 1]
      if (NUMERIC.includes(name) && !(Number(argv[i + 1]) > 0)) {
        throw new Error(`--${name} takes a positive number, got ${JSON.stringify(argv[i + 1])}`)
      }
      // Why capped: a larger delay overflows setTimeout and fires at once, killing every slice.
      if (name === 'timeout-min' && Number(argv[i + 1]) > 1440) {
        throw new Error('--timeout-min is capped at 1440 (one day)')
      }
      i += 1
    } else {
      throw new Error(`unknown argument: ${argv[i]}`)
    }
  }
  if (!options.mode) {
    throw new Error(`pick one of --${MODES.join(', --')}`)
  }
  return options
}

function syncDirFor(options) {
  if (options.packet) {
    // Why absolute: a denial's path is matched against this prefix, and a relative one matches nothing.
    return resolve(options.packet)
  }
  const merge = options.merge ?? headSyncMerge(repoRoot)
  if (!merge) {
    throw new Error('HEAD has no merge on its first-parent line; pass --merge <sha>')
  }
  return syncPacketDir(repoRoot, git(repoRoot, ['rev-parse', merge]).trim())
}

function readFindings(file) {
  const parsed = JSON.parse(readFileSync(file, 'utf8'))
  const list = Array.isArray(parsed) ? parsed : parsed.findings
  if (!Array.isArray(list)) {
    throw new Error(`${file} is neither a findings array nor { "findings": [...] }`)
  }
  return list.map((finding, index) => ({ id: finding.id ?? `F-${index + 1}`, ...finding }))
}

/**
 * What a plan will cost on the reviewer, from the two measurements there are.
 *
 * Two terms, and which dominates depends on the slice. Every slice is a fresh reviewer session that
 * writes its ~89k-token context at the cache-write rate — 88% of the 2026-11-20 review's $351.65 over
 * 435 slices, so a 1.5 KB slice still cost $0.78. A large slice pays for turns instead: each one
 * re-reads the whole growing context, so nine consolidated slices of the same 3.06 MB diff read 103.6M
 * tokens and cost $47.90 ($4.17 to $7.65 each).
 *
 * So: cost ≈ $0.75 a slice + $14 a MB. That predicts $5.5 for a 340 KB slice, $0.77 for a 1.5 KB one,
 * and $49 for the nine-slice plan — the three measurements. It over-counts a plan of hundreds of tiny
 * slices by ~5%, which is the safe direction for a guard.
 */
export function estimateReviewCostUsd(slices) {
  if (!slices.length) {
    return 0
  }
  const bytes = slices.reduce((total, slice) => total + slice.bytes, 0)
  return slices.length * 0.75 + (bytes / (1024 * 1024)) * 14
}

/** Why a warning and not a refusal: a pathological plan is almost always a packing bug upstream of
 * the release, and the reader needs to see it before `--run` spends anything. */
function estimateProblems(slices) {
  const problems = []
  const sized = slices.map((slice) => slice.bytes).sort((a, b) => a - b)
  if (sized.length && sized[Math.floor(sized.length / 2)] < 8192) {
    problems.push(
      `the median slice is ${String(Math.round(sized[Math.floor(sized.length / 2)]))} bytes — slices this small pay a whole reviewer boot for a few KB; suspect the packer`
    )
  }
  return problems
}

/** Prints the estimate, and refuses when it is over `--max-estimate-usd`. Returns an exit code. */
function reportEstimate(slices, maxUsd) {
  const estimate = estimateReviewCostUsd(slices)
  const lines = [
    `  estimate: ${String(slices.length)} slice(s), ~$${estimate.toFixed(0)} on ${REVIEWER.name} at ${REVIEWER.thinking} (measured: $0.75 a slice + $14 a MB)`
  ]
  const problems = estimateProblems(slices)
  for (const problem of problems) {
    lines.push(`  WARNING: ${problem}`)
  }
  const over = maxUsd && estimate > maxUsd
  if (over) {
    lines.push(
      `  REFUSE: the estimate is over --max-estimate-usd ${String(maxUsd)}; re-plan with a larger --budget-kb, narrow the scope, or run the tail on a cheaper tier`
    )
  }
  process.stderr.write(`${lines.join('\n')}\n`)
  return over ? 1 : 0
}

function prepare(options) {
  const context = loadCoverageContext(repoRoot)
  const budgetBytes = Math.round(Number(options['budget-kb'] ?? DEFAULT_BUDGET_KB) * 1024)
  if (options.delta) {
    const parentDir = syncDirFor(options)
    const findings = options.findings
      ? readFindings(options.findings)
      : openFindings(reviewState(parentDir))
    const { dir, packet } = prepareDelta({
      root: repoRoot,
      range: options.delta,
      findings,
      parentDir,
      context,
      budgetBytes
    })
    console.log(`delta packet: ${dir}`)
    console.log(
      `  ${packet.slices[0].files} file(s), ${packet.slices[0].bytes} bytes; ${findings.length} finding(s) to re-check`
    )
    return reportEstimate(packet.slices, options['max-estimate-usd'])
  }
  const merge = options.merge ?? headSyncMerge(repoRoot)
  if (!merge) {
    throw new Error('HEAD has no merge on its first-parent line; pass --merge <sha>')
  }
  const { dir, packet } = prepareSync({
    root: repoRoot,
    merge,
    budgetBytes,
    context,
    dir: options.packet ?? null
  })
  console.log(`packet: ${dir}`)
  console.log(
    `  remerge diff ${packet.artifact.bytes} bytes in ${packet.artifact.files} files; reviewed ${packet.reviewed.bytes} bytes in ${packet.reviewed.files}; excluded ${packet.excluded.bytes} bytes in ${packet.excluded.files}`
  )
  for (const rule of packet.excluded.rules) {
    console.log(
      `  excluded ${rule.id}: ${rule.files} file(s), ${rule.bytes} bytes, verified by ${rule.covers.join(' + ')}`
    )
  }
  for (const miss of packet.uncovered) {
    console.log(`  kept ${miss.path} (${miss.rule}): ${miss.reason}`)
  }
  for (const slice of packet.slices) {
    console.log(
      `  slice ${slice.id}: ${slice.bytes} bytes, ${slice.files} file(s) — ${slice.scope}`
    )
  }
  return reportEstimate(packet.slices, options['max-estimate-usd'])
}

function status(state) {
  if (!state.slices.length) {
    console.error('  no slices: the packet holds no hunks to review')
    return 1
  }
  for (const entry of state.slices) {
    const { report } = entry
    const counts = report.counts
      ? ` ${report.counts.blockers}B/${report.counts.shouldFix}S/${report.counts.minors}M/${report.counts.nits}N`
      : ''
    console.log(
      `  ${entry.slice.id}: ${report.status}${counts}${report.problem ? ` — ${report.problem}` : ''}${report.warning ? ` (${report.warning})` : ''}`
    )
  }
  return state.slices.every((entry) => entry.report.status === 'reported') ? 0 : 1
}

/**
 * Why refuse before spending: the reviewer reads the working tree while the prompt names a revision, so
 * a dirty tree or a moved HEAD means the answers describe a tree nobody will release.
 */
function runProblems(packet) {
  const problems = []
  const stale = ['provider', 'alias', 'name', 'thinking'].filter(
    (key) => packet.reviewer?.[key] !== REVIEWER[key]
  )
  if (packet.reviewer && stale.length) {
    problems.push(
      `the packet was prepared for another reviewer (${stale.join(', ')} differ); prepare it again`
    )
  }
  const dirty = git(repoRoot, ['status', '--porcelain', '--untracked-files=no'])
    .split('\n')
    .filter(Boolean)
  if (dirty.length) {
    const paths = dirty
      .slice(0, 3)
      .map((line) => line.slice(3))
      .join(', ')
    problems.push(
      `the working tree has ${dirty.length} uncommitted change(s) (${paths}), and the reviewer reads it as it is`
    )
  }
  const revision = packet.revision ?? packet.r2 ?? packet.merge
  try {
    const moved = git(repoRoot, ['diff', '--name-only', revision, 'HEAD'])
      .split('\n')
      .filter(Boolean)
      .filter((path) => !reviewNeutralOnly([path]))
    if (moved.length) {
      problems.push(
        `${moved.length} path(s) changed since the packet's revision ${short(revision)} (${moved.slice(0, 3).join(', ')}); prepare a packet for HEAD`
      )
    }
  } catch {
    problems.push(`the packet's revision ${short(revision)} is not in this repository`)
  }
  return problems
}

async function run(options) {
  const syncDir = syncDirFor(options)
  const state = reviewState(syncDir)
  const blocked = runProblems(state.rounds.at(-1).packet)
  if (blocked.length) {
    for (const problem of blocked) {
      console.error(`release-review: refusing to run — ${problem}`)
    }
    return 1
  }
  const only = options.slices ? new Set(options.slices.split(',')) : null
  const jobs = state.slices
    .filter((entry) => !only || only.has(entry.slice.id))
    .map((entry) => ({ id: entry.slice.id, dir: entry.dir, addDirs: [entry.dir] }))
  console.error(`release-review: ${jobs.length} slice(s) in ${syncDir}`)
  await runSlices({
    jobs,
    cwd: repoRoot,
    claude: process.env.ORCA_REVIEW_CLAUDE || 'claude',
    concurrency: Number(options.concurrency ?? 6),
    timeoutMs: Number(options['timeout-min'] ?? 90) * 60_000,
    maxBudgetUsd: options['max-budget-usd'] ? Number(options['max-budget-usd']) : null
  })
  return status(reviewState(syncDir))
}

/**
 * Where the review stops, and every break in the chain that leads there.
 *
 * Why the chain and not HEAD: round 1 reviews the merge's own resolution and a delta reviews only the
 * range it was given, so naming HEAD as the reviewed revision would certify commits no slice read.
 * The gate's `reviewedRevision` then accepts only review-neutral commits after the revision named
 * here, which is the same rule the hand-written manifests were held to.
 */
export function reviewCoverage(state) {
  let end = state.rounds[0].packet.merge
  const gaps = []
  for (const { packet } of state.rounds.slice(1)) {
    if (packet.r1 !== end) {
      gaps.push(
        `delta ${packet.range} starts at ${short(packet.r1)} but the reviewed range ends at ${short(end)}, so the commits between them were never reviewed`
      )
    }
    end = packet.r2
  }
  return { end, gaps }
}

/** Paths changed after the reviewed revision that a release review would have to cover. */
function uncoveredPaths(end) {
  const head = git(repoRoot, ['rev-parse', 'HEAD']).trim()
  if (head === end) {
    return []
  }
  const touched = git(repoRoot, ['diff', '--name-only', end, head]).split('\n').filter(Boolean)
  return touched.filter((path) => !reviewNeutralOnly([path]))
}

function print(options, write = false) {
  const state = reviewState(syncDirFor(options))
  const { end, gaps } = reviewCoverage(state)
  const manifest = buildManifest(state, { revision: end })
  const uncovered = uncoveredPaths(end)
  let ancestor = true
  try {
    git(repoRoot, ['merge-base', '--is-ancestor', end, 'HEAD'])
  } catch {
    ancestor = false
  }
  const problems = [
    ...gaps,
    ...(ancestor
      ? []
      : [
          `the reviewed revision ${short(end)} is not an ancestor of HEAD, so the gate cannot find its manifest`
        ]),
    ...validateManifest(manifest, { revision: end }),
    ...(uncovered.length
      ? [
          `${uncovered.length} path(s) changed after the reviewed revision ${short(end)} (${uncovered.slice(0, 5).join(', ')}${uncovered.length > 5 ? ', …' : ''}); prepare a delta round over them`
        ]
      : [])
  ]
  if (write && !problems.length) {
    const path = join(repoRoot, manifestPath(end))
    writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`)
    console.log(`manifest: ${path}`)
  } else if (!write) {
    console.log(JSON.stringify(manifest, null, 2))
  }
  // Why the problems go to stderr in both modes: the manifest names the revision it covers, which is
  // routinely not HEAD, so a redirect cannot be trusted to have recorded a complete review.
  for (const problem of problems) {
    console.error(`release-review: not yet complete — ${problem}`)
  }
  return problems.length ? 1 : 0
}

async function main(argv) {
  let options
  try {
    options = parseArgs(argv)
  } catch (error) {
    console.error(`release-review: ${error.message}`)
    return 2
  }
  try {
    if (options.mode === 'prepare') {
      return prepare(options)
    }
    if (options.mode === 'run') {
      return await run(options)
    }
    if (options.mode === 'status') {
      return status(reviewState(syncDirFor(options)))
    }
    if (options.mode === 'write') {
      return print(options, true)
    }
    return print(options)
  } catch (error) {
    console.error(`release-review: ${error.message}`)
    return 1
  }
}

if (process.argv[1] && import.meta.filename === process.argv[1]) {
  process.exitCode = await main(process.argv.slice(2))
}
