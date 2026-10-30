#!/usr/bin/env node
// Post-sync integration checks.
//
// Why this exists: Step 3 of the runbook was a list of commands run by hand, late, and the
// previous sync's own log records the cases that merged cleanly and were still wrong — a
// metadata-only index writer that discarded content, a settings toggle writing a field the fork
// had renamed, two settings surfaces controlling one consent. Those are not conflict markers, so
// nothing but a repeatable command catches them. This is that command.
//
// Read-only, except that the localization generator rewrites the derived catalog (that rewriting *is*
// the check, and it must produce no diff) and that a clean run deletes the pre-sync state file.
//
//   node local/sync/post-sync.mjs
//   node local/sync/post-sync.mjs --skip-typecheck --json
//
// The checks themselves live in lib/post-sync-checks.mjs, lib/dangling-references.mjs and lib/checks.mjs;
// their order and titles in lib/post-sync-rows.mjs. This file is the driver: the report, the waivers, the
// exit code and the state-file cleanup.

import process from 'node:process'
import { TYPE_CHECK_COMMAND } from './lib/checks.mjs'
import { BUILDER_CONFIG, FORK_SLUG } from './lib/post-sync-checks.mjs'
import { postSyncRowIds, postSyncRows } from './lib/post-sync-rows.mjs'
import { Report, STATUS, clearSyncState, gitText, repoRoot } from './lib/run.mjs'
import { pinnedUpstreamBase, resolvePreSyncTip } from './lib/sync-range.mjs'

function parseArgs(argv) {
  const options = { json: false, skipTypecheck: false, help: false, waivers: [] }
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    if (flag === '--json') {
      options.json = true
    } else if (flag === '--skip-typecheck') {
      options.skipTypecheck = true
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
  console.log(`Usage: node local/sync/post-sync.mjs [--json] [--skip-typecheck] [--waive <id>:<reason>]

Integration checks, each reported separately: no conflict markers (delegating to
local/sync/conflicts.mjs --verify when present), the derived localization catalog regenerates to
no diff, both localization verifiers, the fork builder config (${BUILDER_CONFIG})
still loading, the update feed still naming ${FORK_SLUG}, the fork identity sweep (delegating to
local/sync/identity-sweep.mjs when present), a red-flag scan of the files modified since the pre-sync
tip compared against the upstream base pre-sync recorded, an inventory of the exported surface of
every fork-only module this sync deleted (each name searched for a surviving reference), the names the
fork added to a surviving file that the merged file no longer declares, fork-added references that
resolve to nothing at HEAD, the repo-wide lint the changed-lines gate never runs (which is how the
np.18 merge left six over-cap files for a later PR to inherit), and the merged tip typecheck
(${TYPE_CHECK_COMMAND}).

Options:
  --json                     machine-readable report on stdout (the state-file notice goes to stderr)
  --skip-typecheck           skip ${TYPE_CHECK_COMMAND}; reported as skipped, never as passed
  --waive <id>:<reason>      record a deliberate exception for a check that could not run (repeatable).
                             Without one, an N/A check fails the run: a check that did not run is not a pass
  -h, --help                 this text

Exit code is non-zero if any hard check fails, or if a check could not run and was not waived.
A clean run deletes the pre-sync state file: it describes one merge and must not outlive it.`)
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
  // Before anything runs: a waiver naming no check is a typo, and finding it after a 20-minute typecheck
  // is finding it too late.
  const known = new Set(postSyncRowIds({ options }))
  for (const [id] of options.waivers) {
    if (!known.has(id)) {
      console.error(`post-sync: no check ${String(id)} to waive — one of ${[...known].join(', ')}`)
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
  const checks = postSyncRows({ tip, source, problem, options })
  for (const [id, title, look, run] of checks) {
    try {
      report.addOutcome(id, title, look, run())
    } catch (error) {
      report.add(id, STATUS.failed, title, `${id} crashed: ${error.message}`, {
        look: 'this is a bug in local/sync/post-sync.mjs, not a finding about the repository',
        details: String(error.stack ?? '')
          .split('\n')
          .slice(0, 6)
      })
    }
  }
  // A waiver a reader cannot find is not recorded: it lands in the rendered report, in --json and in the
  // verdict line, and it only ever covers a check that could not run.
  for (const [id, reason] of options.waivers) {
    report.waive(id, reason)
  }
  console.log(options.json ? JSON.stringify(report.toJSON(), null, 2) : report.render())
  if (report.ok) {
    const removed = clearSyncState()
    if (removed) {
      // stderr, because `--json` promises stdout is the report and nothing else.
      process.stderr.write(`\ncleared the pre-sync state file (${removed}); this merge is done\n`)
    }
  }
  // exitCode, not exit(): exit() truncates a large --json still draining into a pipe. The report grew
  // past the pipe buffer once the fork-symbol and dangling-reference rows landed.
  process.exitCode = report.ok ? 0 : 1
}

main()
