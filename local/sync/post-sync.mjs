#!/usr/bin/env node
// Post-sync integration checks.
//
// Why this exists: Step 3 of the runbook was a list of commands run by hand, late, and the
// previous sync's own log records the cases that merged cleanly and were still wrong — a
// metadata-only index writer that discarded content, a settings toggle writing a field the fork
// had renamed, two settings surfaces controlling one consent. Those are not conflict markers, so
// nothing but a repeatable command catches them. This is that command.
//
// Read-only, except that the localization generator rewrites the derived catalog: that rewriting
// *is* the check, and it must produce no diff.
//
//   node local/sync/post-sync.mjs
//   node local/sync/post-sync.mjs --skip-typecheck --json
//
// The checks themselves live in lib/post-sync-checks.mjs and lib/checks.mjs; this file is the
// operator-facing report: one row per check, with the title and the remediation text.

import process from 'node:process'
import {
  TYPE_CHECK_COMMAND,
  conflictMarkers,
  localizationCatalog,
  typecheck
} from './lib/checks.mjs'
import {
  BUILDER_CONFIG,
  FORK_SLUG,
  builderConfig,
  deletedForkModules,
  identitySweep,
  localizationVerifiers,
  lostContent,
  pinnedUpstreamBase,
  resolvePreSyncTip,
  updaterFeed
} from './lib/post-sync-checks.mjs'
import { Report, STATUS, gitText, repoRoot } from './lib/run.mjs'

function parseArgs(argv) {
  const options = { json: false, skipTypecheck: false, help: false }
  for (const flag of argv) {
    if (flag === '--json') {
      options.json = true
    } else if (flag === '--skip-typecheck') {
      options.skipTypecheck = true
    } else if (flag === '--help' || flag === '-h') {
      options.help = true
    } else {
      throw new Error(`unknown argument: ${flag}`)
    }
  }
  return options
}

function usage() {
  console.log(`Usage: node local/sync/post-sync.mjs [--json] [--skip-typecheck]

Integration checks, each reported separately: no conflict markers (delegating to
local/sync/conflicts.mjs --verify when present), the derived localization catalog regenerates to
no diff, both localization verifiers, the fork builder config (${BUILDER_CONFIG})
still loading, the update feed still naming ${FORK_SLUG}, the fork identity sweep (delegating to
local/sync/identity-sweep.mjs when present), a red-flag scan of the files modified since the pre-sync
tip compared against the upstream base pre-sync recorded, an inventory of the exported surface of
every fork-only module this sync deleted (each name searched for a surviving reference), and the
merged tip typecheck (${TYPE_CHECK_COMMAND}).

Options:
  --json            machine-readable report on stdout
  --skip-typecheck  skip ${TYPE_CHECK_COMMAND}; reported as skipped, never as passed
  -h, --help        this text

Exit code is non-zero if any hard check fails.`)
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
  const { tip, source } = resolvePreSyncTip()
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
  // One row per check. A check that throws is a failed check, never a missing one.
  const checks = [
    [
      'conflict-markers',
      'no conflict markers',
      'each named file still carries a conflict; resolve it before pushing',
      () => conflictMarkers({ delegate: true })
    ],
    [
      'localization-catalog',
      'derived localization catalog regenerates to no diff',
      'commit the regenerated catalog; hand-merging a derived file is the failure this checks for',
      localizationCatalog
    ],
    [
      'localization-verifiers',
      'both localization verifiers pass',
      'the source catalog lost entries the derived file still expects',
      localizationVerifiers
    ],
    [
      'builder-config',
      'the fork builder config loads',
      'the fork patches this file; a clean merge into it was wrong',
      builderConfig
    ],
    [
      'updater-feed',
      `update feed still names ${FORK_SLUG}`,
      'without this, an update check resolves upstream releases and the fork ships a downgrade',
      updaterFeed
    ],
    [
      'identity-sweep',
      'fork identity sweep',
      'the named paths carry upstream identity (bundle id, app name, data dir) that the fork must own',
      identitySweep
    ],
    [
      'lost-content',
      'red-flag scan of files modified since the pre-sync tip',
      "diff each flagged file against the pre-sync tip and take the old tip's content where the replay dropped it",
      () => lostContent(tip, source)
    ],
    [
      'deleted-fork-modules',
      'deleted fork-only modules, with the exported surface each one carried',
      'for each name listed as unreferenced, find the caller the deletion dropped and re-home it; "upstream supersedes this" is not a review',
      () => deletedForkModules(tip, source)
    ],
    [
      'typecheck',
      `merged tip typechecks (${TYPE_CHECK_COMMAND})`,
      'pnpm tc found both semantic breaks of the previous sync that no conflict marker showed',
      () => typecheck(options)
    ]
  ]
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
  console.log(options.json ? JSON.stringify(report.toJSON(), null, 2) : report.render())
  process.exit(report.failures.length === 0 ? 0 : 1)
}

main()
