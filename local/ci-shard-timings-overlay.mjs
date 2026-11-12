#!/usr/bin/env node
/**
 * The tool that maintains the fork's shard-timing overlay: the weights for fork-added test files the
 * unit shard planner would otherwise place at its 442 ms fallback.
 *
 * Why an overlay at all: `ci-shard-timings.json` is imported from *upstream* runs, whose tree has no
 * fork files, so a fork-added file can never appear in it however often it is refreshed. The merge
 * itself lives in `ci-shard-timings-overlay-merge.mjs`, which the planner calls; this file only writes
 * and checks the data.
 *
 * Why 2 s is the threshold: the artifacts record `endTime - startTime` per file, which agrees with the
 * baseline for heavy files (median ratio 1.03 above 5 s) but not for light ones, where the baseline's
 * per-file environment allowance dominates. Below the threshold the 442 ms fallback is already closer
 * than anything this file could record.
 *
 * Usage:
 *   node local/ci-shard-timings-overlay.mjs import <artifact-dir...> [--runner LABEL] [--override PATH=MS]...
 *   node local/ci-shard-timings-overlay.mjs --check
 *   node local/ci-shard-timings-overlay.mjs --simulate <artifact-dir...> [--override PATH=MS]...
 *
 * `import` needs the fork's upstream ref (to know which files are fork-added); `--check` and
 * `--simulate` do not. `--override` records a duration the artifacts predate, and keeps saying so in
 * the overlay's `estimates` block until a measured run replaces it.
 *
 * Exit: 0 pass, 1 a red finding, 2 usage or environment problem.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { balanceFiles } from '../config/scripts/ci/sharding/ci-shard-assignment.mjs'
import {
  assertOverlayShape,
  mergeForkTimingOverlay,
  OVERLAY_PATH
} from './ci-shard-timings-overlay-merge.mjs'

const ROOT = resolve(import.meta.dirname, '..')
export { OVERLAY_PATH }
export const BASELINE_PATH = resolve(
  import.meta.dirname,
  '../config/scripts/ci/sharding/ci-shard-timings.json'
)
export const DEFAULT_THRESHOLD_MS = 2000
const REPORT_FILE = 'unit-report.json'
const ASSIGNMENT_FILE = 'unit-assignment.json'

export function parseArgs(argv) {
  const options = {
    mode: null,
    dirs: [],
    overrides: new Map(),
    thresholdMs: DEFAULT_THRESHOLD_MS,
    runner: null
  }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === 'import' || arg === '--check' || arg === '--simulate') {
      if (options.mode) {
        throw new Error('pick one mode')
      }
      options.mode = arg === 'import' ? 'import' : arg === '--check' ? 'check' : 'simulate'
    } else if (arg === '--override') {
      const value = argv[(index += 1)] ?? ''
      const [file, milliseconds] = value.split('=')
      const ms = Number(milliseconds)
      if (!file || !Number.isFinite(ms) || ms <= 0) {
        throw new Error(`--override needs PATH=MS, got "${value}"`)
      }
      options.overrides.set(file, Math.round(ms))
    } else if (arg === '--runner') {
      options.runner = (argv[(index += 1)] ?? '').trim() || null
    } else if (arg === '--threshold-ms') {
      options.thresholdMs = Number(argv[(index += 1)])
    } else if (arg === '--help' || arg === '-h') {
      options.mode = 'help'
    } else {
      options.dirs.push(arg)
    }
  }
  if (!options.mode) {
    throw new Error('pick one mode')
  }
  if (options.mode === 'import' && options.dirs.length === 0) {
    throw new Error('import needs at least one artifact directory')
  }
  if (options.mode === 'simulate' && options.dirs.length === 0) {
    throw new Error('--simulate needs at least one artifact directory')
  }
  return options
}

/**
 * Per-file durations from a set of shard artifact directories, keyed by repository-relative path.
 *
 * Why every folder must agree on the run and the attempt, and why a file may appear once: a set that
 * mixes two attempts holds each file twice, and summing them would double every weight silently.
 * Upstream's importer refuses the same cases (`ci-unit-timing-import.mjs`).
 */
export function readArtifacts(directories) {
  const discovered = new Set()
  const reports = []
  let source = null
  for (const directory of directories) {
    const assignmentPath = join(directory, ASSIGNMENT_FILE)
    const reportPath = join(directory, REPORT_FILE)
    for (const path of [assignmentPath, reportPath]) {
      if (!existsSync(path)) {
        throw new Error(`${directory} holds no ${basename(path)}`)
      }
    }
    const assignment = JSON.parse(readFileSync(assignmentPath, 'utf8'))
    const attempt = { runId: assignment.runId ?? null, attempt: assignment.runAttempt ?? null }
    if (source && (source.runId !== attempt.runId || source.attempt !== attempt.attempt)) {
      throw new Error(`${directory} is not from run ${source.runId} attempt ${source.attempt}`)
    }
    source ??= attempt
    for (const shard of assignment.shards ?? []) {
      for (const file of shard.files ?? []) {
        discovered.add(file)
      }
    }
    reports.push({ reportPath, report: JSON.parse(readFileSync(reportPath, 'utf8')) })
  }
  const observed = new Map()
  for (const { reportPath, report } of reports) {
    for (const result of report.testResults ?? []) {
      const file = relativeToDiscovery(String(result.name ?? ''), discovered, reportPath)
      const duration = Number(result.endTime) - Number(result.startTime)
      if (!Number.isFinite(duration) || duration < 0) {
        throw new Error(`${reportPath} holds an unreadable duration for ${file}`)
      }
      if (observed.has(file)) {
        throw new Error(`${file} appears in more than one shard report`)
      }
      observed.set(file, duration)
    }
  }
  return {
    observed,
    files: [...discovered].sort(),
    source: { runId: source?.runId ?? null, attempt: source?.attempt ?? null }
  }
}

/**
 * The checkout prefix is not fixed, so the discovered file list is the ruler: the longest tail of an
 * absolute report path that is a discovered file is its repository-relative path.
 */
function relativeToDiscovery(absolute, discovered, reportPath) {
  const segments = absolute.replace(/\\/g, '/').split('/').filter(Boolean)
  for (let start = 0; start < segments.length; start += 1) {
    const candidate = segments.slice(start).join('/')
    if (discovered.has(candidate)) {
      return candidate
    }
  }
  throw new Error(`${reportPath} reports ${absolute}, which discovery did not select`)
}

/** The files a timing entry may cover: the ones the fork's own line adds to the tree upstream ships. */
export function readForkAddedFiles(root = ROOT) {
  const list = (args) =>
    execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 })
  let upstreamFiles
  try {
    upstreamFiles = new Set(list(['ls-tree', '-r', '--name-only', 'upstream/main']).split('\n'))
  } catch {
    throw new Error(
      'upstream/main is not available, so the fork-added files cannot be identified; fetch it first'
    )
  }
  return new Set(
    list(['ls-tree', '-r', '--name-only', 'HEAD'])
      .split('\n')
      .filter((path) => path && !upstreamFiles.has(path))
  )
}

/**
 * The entries an overlay should carry: measured, fork-added, absent from the baseline, and heavy
 * enough that the artifacts' metric is trustworthy.
 */
export function selectEntries({
  observed,
  baselineTimings,
  forkFiles,
  thresholdMs = DEFAULT_THRESHOLD_MS
}) {
  const entries = {}
  for (const [file, milliseconds] of observed) {
    if (!forkFiles.has(file) || file in baselineTimings || milliseconds < thresholdMs) {
      continue
    }
    entries[file] = Math.round(milliseconds)
  }
  return Object.fromEntries(
    Object.entries(entries).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
  )
}

/** Every way the overlay disagrees with what the planner can use. Empty means usable. */
export function overlayProblems(overlay, { root = ROOT, baselineTimings }) {
  const problems = []
  try {
    assertOverlayShape(overlay)
  } catch (error) {
    return [error.message]
  }
  const keys = Object.keys(overlay.unit.timings)
  if (keys.length === 0) {
    problems.push('unit.timings is empty')
  }
  if (JSON.stringify(keys) !== JSON.stringify([...keys].sort())) {
    problems.push('unit.timings keys are not sorted')
  }
  for (const file of [...keys].sort()) {
    if (file in baselineTimings) {
      problems.push(`${file}: the baseline already measures it, so this entry is stale`)
    }
    if (!existsSync(join(root, file))) {
      problems.push(`${file}: no such file`)
    }
  }
  for (const file of Object.keys(overlay.estimates ?? {})) {
    if (!(file in overlay.unit.timings)) {
      problems.push(`estimates.${file}: not an entry`)
    }
  }
  if (overlay?.source?.runId && !overlay?.source?.sha) {
    problems.push('source.sha is missing')
  }
  return problems
}

/**
 * Shard loads for one plan, in the units the shards actually spent: each file's measured duration,
 * with any override standing in for a file whose duration changed after the artifacts were recorded.
 */
export function simulateLoads({ files, observed, timings, shardCount, overrides = new Map() }) {
  const duration = (file) => overrides.get(file) ?? observed.get(file) ?? 0
  return {
    loads: balanceFiles(files, shardCount, timings).shards.map((shard) =>
      shard.files.reduce((sum, file) => sum + duration(file), 0)
    )
  }
}

export function summariseLoads(loads) {
  const sorted = [...loads].sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  const median =
    sorted.length === 0
      ? 0
      : sorted.length % 2 === 1
        ? sorted.at(middle)
        : (sorted.at(middle - 1) + sorted.at(middle)) / 2
  return {
    median,
    max: sorted.at(-1) ?? 0,
    ratio: median ? (sorted.at(-1) ?? 0) / median : 0
  }
}

function writeOverlay(overlay) {
  writeFileSync(OVERLAY_PATH, `${JSON.stringify(overlay, null, 2)}\n`)
}

function reportProblems(problems) {
  for (const problem of problems) {
    console.error(`::error::${problem}`)
  }
  return problems.length > 0 ? 1 : 0
}

function runImport(options) {
  const artifacts = readArtifacts(options.dirs)
  const baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf8'))
  const entries = selectEntries({
    observed: artifacts.observed,
    baselineTimings: baseline.unit.timings,
    forkFiles: readForkAddedFiles(),
    thresholdMs: options.thresholdMs
  })
  for (const [file, milliseconds] of options.overrides) {
    if (!(file in entries)) {
      throw new Error(`--override ${file} is not a selected entry`)
    }
    entries[file] = milliseconds
  }
  if (Object.keys(entries).length === 0) {
    throw new Error(
      `no fork-added file over ${options.thresholdMs} ms in ${options.dirs.length} artifact ` +
        'director(ies); refusing to write an overlay that weights nothing'
    )
  }
  const previous = existsSync(OVERLAY_PATH)
    ? JSON.parse(readFileSync(OVERLAY_PATH, 'utf8'))
    : { source: {} }
  const estimates = {}
  for (const file of options.overrides.keys()) {
    estimates[file] =
      previous.estimates?.[file] ??
      'overridden at import, because the recorded run predates the change; the next measured run replaces it'
  }
  const overlay = {
    version: 1,
    note:
      'Fork-added unit tests heavy enough to move a shard. Merged over ci-shard-timings.json by ' +
      'readTimingBaseline, which lets the baseline win on any collision. Regenerate with ' +
      '`node local/ci-shard-timings-overlay.mjs import <artifact-dir...>`.',
    source: {
      runId: artifacts.source?.runId ?? null,
      attempt: artifacts.source?.attempt ?? null,
      sha: artifacts.source?.sha ?? previous.source?.sha ?? null,
      runner: options.runner ?? previous.source?.runner ?? null,
      metric: 'unit-report-file-duration'
    },
    thresholdMs: options.thresholdMs,
    ...(Object.keys(estimates).length > 0 ? { estimates } : {}),
    unit: { timings: entries }
  }
  const problems = overlayProblems(overlay, { baselineTimings: baseline.unit.timings })
  if (problems.length > 0) {
    return reportProblems(problems)
  }
  writeOverlay(overlay)
  console.log(
    `Wrote ${Object.keys(entries).length} entr(ies) from run ${overlay.source.runId ?? 'unknown'}` +
      `${Object.keys(estimates).length > 0 ? `, ${Object.keys(estimates).length} overridden` : ''}.`
  )
  return 0
}

function runCheck() {
  if (!existsSync(OVERLAY_PATH)) {
    console.error(`::error::${OVERLAY_PATH} is missing`)
    return 1
  }
  const baselineBytes = readFileSync(BASELINE_PATH, 'utf8')
  const baseline = JSON.parse(baselineBytes)
  const overlay = JSON.parse(readFileSync(OVERLAY_PATH, 'utf8'))
  const problems = overlayProblems(overlay, { baselineTimings: baseline.unit.timings })
  try {
    mergeForkTimingOverlay('unit', baselineBytes)
  } catch (error) {
    problems.push(`the planner cannot load it: ${error.message}`)
  }
  if (problems.length === 0) {
    console.log(
      `Overlay: ${Object.keys(overlay.unit.timings).length} entr(ies) against baseline ` +
        `${overlay.source?.runId ?? 'unknown'}.`
    )
  }
  return reportProblems(problems)
}

function runSimulate(options) {
  const artifacts = readArtifacts(options.dirs)
  const baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf8'))
  const overlay = existsSync(OVERLAY_PATH) ? JSON.parse(readFileSync(OVERLAY_PATH, 'utf8')) : null
  const plans = {
    'baseline only': baseline.unit.timings,
    'baseline + overlay': { ...overlay?.unit?.timings, ...baseline.unit.timings }
  }
  const shardCount = Math.max(1, ...loadShardCounts(options.dirs))
  const overrideSets = options.overrides.size > 0 ? [new Map(), options.overrides] : [new Map()]
  for (const [planLabel, timings] of Object.entries(plans)) {
    for (const overrides of overrideSets) {
      const { loads } = simulateLoads({
        files: artifacts.files,
        observed: artifacts.observed,
        timings,
        shardCount,
        overrides
      })
      const summary = summariseLoads(loads)
      const label = overrides.size > 0 ? `${planLabel}, with overrides` : planLabel
      console.log(
        `${label}: median ${(summary.median / 1000).toFixed(1)}s, ` +
          `slowest ${(summary.max / 1000).toFixed(1)}s, ratio ${summary.ratio.toFixed(2)}x`
      )
    }
  }
  return 0
}

function loadShardCounts(directories) {
  return directories
    .map((directory) => join(directory, ASSIGNMENT_FILE))
    .filter(existsSync)
    .map((path) => (JSON.parse(readFileSync(path, 'utf8')).shards ?? []).length)
}

export function main(argv = process.argv.slice(2)) {
  let options
  try {
    options = parseArgs(argv)
  } catch (error) {
    console.error(
      `${error.message}\nusage: node local/ci-shard-timings-overlay.mjs import|--check|--simulate ...`
    )
    return 2
  }
  try {
    if (options.mode === 'help') {
      console.log(
        'usage: node local/ci-shard-timings-overlay.mjs import <dir...> | --check | --simulate <dir...>'
      )
      return 0
    }
    if (options.mode === 'check') {
      return runCheck()
    }
    if (options.mode === 'import') {
      return runImport(options)
    }
    return runSimulate(options)
  } catch (error) {
    console.error(`${error.message}`)
    return 2
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main())
}
