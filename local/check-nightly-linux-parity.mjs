#!/usr/bin/env node
/**
 * Nightly Linux parity for the Mac-known-red allowlist.
 *
 * Every entry in `local/unit-known-red.json` claims its test is red because of *this Mac*. The
 * nightly (`fork-main-tests.yml` → upstream's `unit-tests.yml`) already uploads each shard's
 * Vitest JSON report with 14-day retention, and nobody has ever checked those claims against it.
 * This tool does: give it the downloaded shard reports and it answers, per allowlisted entry,
 * `passed` / `failed` / `absent` on Linux. A `failed` or `absent` entry exits non-zero — the claim
 * is either a real bug or a stale allowlist entry, and nothing else would ever say so. A test that
 * did not run (its file was never collected, failed at suite level, or reported `skipped`) is
 * `absent`, never `passed`.
 *
 * `prunedSince` entries are reported but not enforced: they were pruned for passing on the Mac,
 * so their Linux outcome is information for the next prune, not a claim this check may fail.
 *
 * Depends on the same Vitest JSON-report fields `local/check-unit-shard-verdict.mjs` reads
 * (`testResults[].name/.status/.message`, `assertionResults[].fullName|.title/.status/
 * .failureMessages`, `numTotalTests`) — see `local/lib/linux-parity.mjs` for the full list and
 * what happens when one is missing (fail closed, never a silent pass).
 *
 * Usage: node local/check-nightly-linux-parity.mjs REPORT.json [REPORT.json … | DIR …]
 *          [--allowlist PATH] [--json]
 *
 * Directories are walked (no shell globbing) for files named `unit-report.json` — the name
 * `.github/workflows/unit-tests.yml` writes into `ci-shards/` and uploads per shard — so a
 * directory of downloaded artifacts works as-is.
 *
 * Exit: 0 every allowlisted entry passed on Linux, 1 any failed/absent or an unreadable report,
 * 2 usage or environment problem.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  formatLinuxFailures,
  formatParity,
  indexShardReports,
  judgeLinuxFailures,
  judgeParity
} from './lib/linux-parity.mjs'

const ROOT = resolve(import.meta.dirname, '..')
const DEFAULT_ALLOWLIST = join(ROOT, 'local', 'unit-known-red.json')
/** Tests that fail on Linux for reasons absent from this Mac, with the evidence for each claim. */
const DEFAULT_RED_SET = join(ROOT, 'local', 'nightly-linux-known-red.json')
/** The name `unit-tests.yml` writes the shard's Vitest report under before uploading `ci-shards/`. */
const REPORT_FILE_NAME = 'unit-report.json'
const WALK_DEPTH = 8

function usage() {
  return (
    'usage: node local/check-nightly-linux-parity.mjs REPORT.json [REPORT.json … | DIR …] ' +
    '[--allowlist PATH] [--failures [--red-set PATH]] [--json]'
  )
}

function parseArgs(argv) {
  const options = {
    paths: [],
    allowlist: DEFAULT_ALLOWLIST,
    redSet: DEFAULT_RED_SET,
    json: false,
    failures: false,
    expectReports: null,
    allowlistGiven: false,
    redSetGiven: false
  }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--allowlist') {
      options.allowlist = resolve(argv[(index += 1)] ?? '')
      options.allowlistGiven = true
    } else if (arg === '--red-set') {
      options.redSet = resolve(argv[(index += 1)] ?? '')
      options.redSetGiven = true
    } else if (arg === '--expect-reports') {
      const raw = argv[(index += 1)]
      const count = Number(raw)
      if (!Number.isInteger(count) || count < 1) {
        console.error(`--expect-reports needs a positive integer, not ${raw}`)
        process.exit(2)
      }
      options.expectReports = count
    } else if (arg === '--failures') {
      options.failures = true
    } else if (arg === '--json') {
      options.json = true
    } else if (arg === '--help' || arg === '-h') {
      console.log(usage())
      process.exit(0)
    } else if (arg.startsWith('-')) {
      console.error(`unknown argument: ${arg}\n${usage()}`)
      process.exit(2)
    } else {
      options.paths.push(resolve(arg))
    }
  }
  if (options.paths.length === 0) {
    console.error(usage())
    process.exit(2)
  }
  return options
}

function collectReports(path, found, depth = 0) {
  const stat = statSync(path, { throwIfNoEntry: false })
  if (stat === undefined) {
    console.error(`no such file or directory: ${path}`)
    process.exit(2)
  }
  if (!stat.isDirectory()) {
    found.add(path)
    return
  }
  if (depth >= WALK_DEPTH) {
    return
  }
  const entries = readdirSync(path, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name)
  )
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) {
      continue
    }
    const child = join(path, entry.name)
    if (entry.isDirectory()) {
      collectReports(child, found, depth + 1)
    } else if (entry.name === REPORT_FILE_NAME) {
      found.add(child)
    }
  }
}

function readReports(paths) {
  const found = new Set()
  for (const path of paths) {
    collectReports(path, found)
  }
  const reports = []
  const unreadable = []
  for (const path of [...found].sort()) {
    try {
      reports.push({ source: path, report: JSON.parse(readFileSync(path, 'utf8')) })
    } catch (error) {
      unreadable.push(`${path}: ${error.message}`)
    }
  }
  return { reports, unreadable }
}

function main() {
  const options = parseArgs(process.argv.slice(2))
  const manifestPath = options.failures ? options.redSet : options.allowlist
  let manifest = null
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  } catch (error) {
    console.error(
      `cannot read ${options.failures ? 'the Linux red set' : 'the known-red allowlist'} at ${manifestPath}: ${error.message}`
    )
    process.exit(2)
  }

  const { reports, unreadable } = readReports(options.paths)
  if (reports.length === 0) {
    console.error(
      `no ${REPORT_FILE_NAME} found under ${options.paths.join(', ')} — download a nightly run's ` +
        'unit-shard artifacts and point this at the directory they unpack into'
    )
    process.exit(2)
  }
  // A flag that the chosen mode ignores would read as "I checked that" when nothing was checked.
  if (options.failures && options.allowlistGiven) {
    console.error('--allowlist belongs to the default mode; --failures judges against --red-set')
    process.exit(2)
  }
  if (!options.failures && options.redSetGiven) {
    console.error('--red-set needs --failures; the default mode judges the Mac allowlist')
    process.exit(2)
  }

  const result = options.failures
    ? judgeLinuxFailures(manifest, indexShardReports(reports), {
        reports,
        expectedReports: options.expectReports
      })
    : judgeParity(manifest, indexShardReports(reports))
  result.problems.push(...unreadable.map((line) => `unreadable report: ${line}`))
  result.ok = result.ok && unreadable.length === 0

  if (options.json) {
    console.log(
      JSON.stringify(
        { ...result, mode: options.failures ? 'failures' : 'parity', reportCount: reports.length },
        null,
        2
      )
    )
  } else {
    const lines = options.failures
      ? formatLinuxFailures(result, { allowlistPath: manifestPath, reportCount: reports.length })
      : formatParity(result, { allowlistPath: manifestPath, reportCount: reports.length })
    for (const line of lines) {
      console.log(line)
    }
  }
  process.exit(result.ok ? 0 : 1)
}

if (
  process.argv[1] &&
  existsSync(process.argv[1]) &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  main()
}
