#!/usr/bin/env node
// Post-sync integration checks.
//
// Why this exists: Step 3 of the runbook was a list of commands run by hand, late, and the
// previous sync's own log records the cases that merged cleanly and were still wrong — a
// metadata-only index writer that discarded content, a settings toggle writing a field the fork
// had renamed, two settings surfaces controlling one consent. Those are not conflict markers, so
// nothing but a repeatable command catches them. This is that command.
//
// Read-only on the tree, except that the localization generator rewrites the derived catalog (that
// rewriting *is* the check, and it must produce no diff) and that a clean run deletes the pre-sync state
// file. Every run saves its report under the git dir, so reading a section is a file read, not a re-run.
//
//   node local/sync/post-sync.mjs
//   node local/sync/post-sync.mjs --skip-typecheck --json
//   node local/sync/post-sync.mjs --only typecheck,native-macos-build
//
// The checks themselves live in lib/post-sync-checks.mjs, lib/dangling-references.mjs and lib/checks.mjs;
// their order and titles in lib/post-sync-rows.mjs. This file is the driver: the report, the waivers, the
// exit code and the state-file cleanup.

import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { TYPE_CHECK_COMMAND } from './lib/checks.mjs'
import { BUILDER_CONFIG, FORK_SLUG } from './lib/post-sync-checks.mjs'
import { postSyncRowIds, postSyncRows } from './lib/post-sync-rows.mjs'
import { Report, STATUS, clearSyncState, gitText, repoRoot, syncOutputDir } from './lib/run.mjs'
import { pinnedUpstreamBase, resolvePreSyncTip } from './lib/sync-range.mjs'

function parseArgs(argv) {
  const options = {
    json: false,
    skipTypecheck: false,
    noCache: false,
    help: false,
    only: null,
    waivers: []
  }
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    if (flag === '--json') {
      options.json = true
    } else if (flag === '--skip-typecheck') {
      options.skipTypecheck = true
    } else if (flag === '--no-cache') {
      options.noCache = true
    } else if (flag === '--only') {
      const value = argv[index + 1]
      const ids = (value ?? '')
        .split(',')
        .map((id) => id.trim())
        .filter(Boolean)
      if (ids.length === 0) {
        throw new Error('--only needs <id>[,<id>...]')
      }
      options.only = [...(options.only ?? []), ...ids]
      index += 1
    } else if (flag === '--waive') {
      const value = argv[index + 1]
      if (!value) {
        throw new Error('--waive needs <check-id>:<reason>')
      }
      const split = value.indexOf(':')
      if (split < 1 || value.slice(split + 1).trim() === '') {
        throw new Error(`--waive needs <check-id>:<reason>, got "${value}"`)
      }
      options.waivers.push([value.slice(0, split), value.slice(split + 1).trim()])
      index += 1
    } else if (flag === '--help' || flag === '-h') {
      options.help = true
    } else {
      throw new Error(`unknown argument: ${flag}`)
    }
  }
  return options
}

function usage() {
  console.log(`Usage: node local/sync/post-sync.mjs [--json] [--skip-typecheck] [--no-cache]
                                     [--only <id>[,<id>...]] [--waive <id>:<reason>]

Integration checks, each reported separately: no conflict markers (delegating to
local/sync/conflicts.mjs --verify when present), the derived localization catalog regenerates to
no diff, both localization verifiers, the locale catalogs byte-identical to upstream (the fork's own
strings and its tombstones live in src/renderer/src/i18n/fork/), the fork builder config
(${BUILDER_CONFIG}) still loading, the five release-repo anchors still naming ${FORK_SLUG} and nothing
under src/main/updater/ naming upstream's repo, the fork identity sweep (delegating to
local/sync/identity-sweep.mjs when present, and gated on its frozen report-only baseline), every test
path and package script LOCAL-PATCHES.md cites still existing, a red-flag scan of the files modified
since the pre-sync tip compared against the upstream base pre-sync recorded, an inventory of the
exported surface of every fork-only module this sync deleted (each name searched for a surviving
reference), the fork-modified test files this sync left gone (against a baseline bound to this range),
the names the fork added to a surviving file that the merged file no longer declares, fork-added
references that resolve to nothing at HEAD, the repo-wide lint the changed-lines gate never runs (which
is how the np.18 merge left six over-cap files for a later PR to inherit), every Swift target under
native/ compiling (macOS only), and the merged tip typecheck (${TYPE_CHECK_COMMAND}).

Every run saves the full report to ${path.join('<git-dir>', 'orca-sync', `${REPORT_NAME}.txt`)} and .json
(${PARTIAL_REPORT_NAME}.* for --only). Read that file for a section instead of re-running the whole
thing, and re-check the one row you fixed with --only <id>.

Options:
  --json                     machine-readable report on stdout (the state-file notice goes to stderr)
  --skip-typecheck           skip ${TYPE_CHECK_COMMAND}; reported as skipped, never as passed
  --no-cache                 re-run the typecheck and native build even when this exact content already
                             passed them (a pass is cached per content; a failure never is)
  --only <id>[,<id>...]      run only these rows (repeatable). A partial run is never a clean run: it says
                             so in its result line and leaves the pre-sync state file in place. Ids:
${wrapIds(postSyncRowIds({}))}
  --waive <id>:<reason>      record a deliberate exception for a check that could not run (repeatable).
                             Without one, an N/A check fails the run: a check that did not run is not a pass
  -h, --help                 this text

Exit code is non-zero if any hard check fails, or if a check could not run and was not waived.
A passing --only run exits 0, so read its result line: 0 does not mean the whole report is clean.
A clean run deletes the pre-sync state file: it describes one merge and must not outlive it.`)
}

function wrapIds(ids) {
  const lines = []
  let line = ''
  for (const id of ids) {
    if (line && line.length + id.length + 2 > 70) {
      lines.push(`${line},`)
      line = ''
    }
    line = line ? `${line}, ${id}` : id
  }
  lines.push(line)
  return lines.map((text) => `                               ${text}`).join('\n')
}

const REPORT_NAME = 'post-sync-last'
// A partial run writes its own pair, so re-checking one row never overwrites the full report a reader
// is working through.
const PARTIAL_REPORT_NAME = 'post-sync-partial-last'

/** Returns the two paths written, or null with the reason on stderr; saving never changes the verdict. */
function saveReport(rendered, json, partial) {
  const dir = syncOutputDir()
  const base = path.join(dir, partial ? PARTIAL_REPORT_NAME : REPORT_NAME)
  try {
    mkdirSync(dir, { recursive: true })
    writeFileSync(`${base}.txt`, `${rendered}\n`)
    writeFileSync(`${base}.json`, `${json}\n`)
    return [`${base}.txt`, `${base}.json`]
  } catch (error) {
    process.stderr.write(`post-sync: could not save the report under ${dir}: ${error.message}\n`)
    return null
  }
}

function main() {
  let options
  try {
    options = parseArgs(process.argv.slice(2))
  } catch (error) {
    console.error(`${error.message}\n`)
    usage()
    process.exit(2)
  }
  if (options.help) {
    usage()
    return
  }
  // Before anything runs: a waiver or an --only naming no check is a typo, and finding it after a
  // 20-minute typecheck is finding it too late.
  const allIds = postSyncRowIds({ options })
  const known = new Set(allIds)
  const unknown = (options.only ?? []).filter((id) => !known.has(id))
  if (unknown.length > 0) {
    console.error(
      `post-sync: --only names no check ${unknown.join(', ')} — valid ids: ${allIds.join(', ')}`
    )
    process.exit(2)
  }
  const selected = options.only === null ? known : new Set(options.only)
  for (const [id] of options.waivers) {
    if (!selected.has(id)) {
      console.error(
        `post-sync: no check ${String(id)} to waive${known.has(id) ? ' in this --only run' : ''} — one of ${[...selected].join(', ')}`
      )
      process.exit(2)
    }
  }
  const { tip, source, problem } = resolvePreSyncTip()
  const base = pinnedUpstreamBase(tip, source)
  const report = new Report('post-sync integration checks', {
    repo: repoRoot(),
    branch: gitText(['rev-parse', '--abbrev-ref', 'HEAD']) ?? 'unknown',
    head: gitText(['rev-parse', '--short', 'HEAD']) ?? 'unknown',
    preSyncTip: tip ? `${tip.slice(0, 10)} (from ${source})` : 'none found',
    upstreamBase: base.base
      ? `${base.base.slice(0, 10)} (from ${base.source})`
      : `unresolved: ${base.problem}`
  })
  // One row per check, from lib/post-sync-rows.mjs. A check that throws is a failed check, never a
  // missing one.
  const checks = postSyncRows({ tip, source, problem, options }).filter(([id]) => selected.has(id))
  if (options.only !== null) {
    report.markPartial(
      checks.map(([id]) => id),
      allIds.length
    )
  }
  for (const [id, title, look, run] of checks) {
    try {
      report.addOutcome(id, title, look, run())
    } catch (error) {
      report.add(
        id,
        STATUS.failed,
        title,
        `${String(id)} crashed: ${String(error?.message ?? error)}`,
        {
          look: 'this is a bug in local/sync/post-sync.mjs, not a finding about the repository',
          details: String(error.stack ?? '')
            .split('\n')
            .slice(0, 6)
        }
      )
    }
  }
  // A waiver a reader cannot find is not recorded: it lands in the rendered report, in --json and in the
  // verdict line, and it only ever covers a check that could not run.
  for (const [id, reason] of options.waivers) {
    report.waive(id, reason)
  }
  const rendered = report.render()
  const json = JSON.stringify(report.toJSON(), null, 2)
  console.log(options.json ? json : rendered)
  // A partial run proves only its rows, so it must not retire the state file the full run still needs.
  if (report.ok && report.partial === null) {
    const removed = clearSyncState()
    if (removed) {
      // stderr, because `--json` promises stdout is the report and nothing else.
      process.stderr.write(`\ncleared the pre-sync state file (${removed}); this merge is done\n`)
    }
  }
  const saved = saveReport(rendered, json, report.partial !== null)
  if (saved) {
    // stderr for the same reason; and the pointer is the cheap alternative to re-running for one section.
    process.stderr.write(
      `\npost-sync: report saved to ${saved[0]} (and .json) — read it rather than re-running; --only <id> re-checks one row\n`
    )
  }
  // exitCode, not exit(): exit() truncates a large --json still draining into a pipe. The report grew
  // past the pipe buffer once the fork-symbol and dangling-reference rows landed.
  process.exitCode = report.ok ? 0 : 1
}

main()
