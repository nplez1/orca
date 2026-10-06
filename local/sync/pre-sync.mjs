#!/usr/bin/env node
// Pre-sync gate for the upstream sync.
//
// Why this exists: Step 0 of the runbook was commands an operator retyped each sync, and the two
// mistakes it cannot forgive — starting a rebase on a dirty tree, and starting one from a tip
// that is already red — were only caught by noticing. The tree is *expected* to be red
// mid-series (an early commit can carry a syntax error a later commit fixes), so the only usable
// signal is that the starting tip is green. This proves that before anything moves.
//
// Inspection is read-only except for the derived localization catalog, which the
// localization-catalog gate regenerates (`pnpm run sync:localization-runtime-catalog` rewrites it with
// --fix); that rewriting *is* the check. `--prepare` is the only path that mutates refs or config: it
// takes the rollback ref and sets rerere/zdiff3; it refuses to mutate while a hard gate fails, and it
// is idempotent — an existing backup ref is reported, never re-pointed, because it is the rollback
// target for the sync that is about to happen. A ref creation or config write that failed is a
// non-zero exit, never just a printed line.
//
//   node local/sync/pre-sync.mjs                    # inspect only; non-zero if a hard gate fails
//   node local/sync/pre-sync.mjs --skip-typecheck   # skip pnpm tc (minutes)
//   node local/sync/pre-sync.mjs --prepare [--json] # also take the rollback ref and write the state
//   node local/sync/pre-sync.mjs --rebase           # the branch is a feature/local(...) series
//
// The gates themselves live in lib/pre-sync-checks.mjs and lib/checks.mjs; this file is the
// operator-facing report: one row per gate, with the title and the remediation text.

import path from 'node:path'
import process from 'node:process'
import {
  TYPE_CHECK_COMMAND,
  conflictMarkers,
  localizationCatalog,
  typecheck
} from './lib/checks.mjs'
import { BACKUP_REF, FORK_BRANCH, prepare, preSyncGates } from './lib/pre-sync-checks.mjs'
import { Report, STATUS, repoRoot, stateFilePath } from './lib/run.mjs'

function parseArgs(argv) {
  const options = { prepare: false, json: false, skipTypecheck: false, rebase: false, help: false }
  for (const flag of argv) {
    if (flag === '--prepare') {
      options.prepare = true
    } else if (flag === '--json') {
      options.json = true
    } else if (flag === '--skip-typecheck') {
      options.skipTypecheck = true
    } else if (flag === '--rebase') {
      options.rebase = true
    } else if (flag === '--help' || flag === '-h') {
      options.help = true
    } else {
      throw new Error(`unknown argument: ${flag}`)
    }
  }
  return options
}

function usage() {
  console.log(`Usage: node local/sync/pre-sync.mjs [--prepare] [--json] [--skip-typecheck] [--rebase]

Read-only gates except for the derived localization catalog, which the localization-catalog gate
regenerates (that rewriting is the check). Each is reported separately: working tree clean (nothing
is safe to merge or rebase dirty), no conflict markers, the derived localization catalog regenerates
to no diff, local(...) commits confined to ${FORK_BRANCH}, the branch and both remotes, the three sync
SHAs (old base, local old tip, new base) with the branch's relationship to origin/${FORK_BRANCH}
(equal / ahead / behind / diverged), the merge dry run with its conflict count, and the fork tip
typecheck (${TYPE_CHECK_COMMAND}).

Options:
  --prepare         after the gates pass: set rerere/zdiff3, create ${BACKUP_REF} and tag
                    archive/pre-sync-<old-tip-short>, write the state file to
                    ${path.basename(stateFilePath())} under the git directory (untracked).
                    Idempotent: an existing backup ref or tag is reported, never moved, and one
                    that no longer points at the pre-sync tip fails the prepare.
  --json            machine-readable report on stdout
  --skip-typecheck  skip ${TYPE_CHECK_COMMAND}; reported as skipped, never as passed
  --rebase          the branch being synced is a feature branch or a local(...) series, so print
                    the rebase procedure; the default is the release line's merge procedure
  -h, --help        this text

Exit code is non-zero if any hard gate fails, or if --prepare could not complete every mutation.`)
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
  const report = new Report('pre-sync inspection', {
    repo: repoRoot(),
    mode: options.prepare
      ? 'inspect, then --prepare mutations'
      : 'inspect only (add --prepare to take the rollback ref)'
  })
  // One row per gate. A gate that throws is a failed gate, never a missing one: this report is
  // the only thing an operator reads before starting a rebase.
  const gates = [
    [
      'tree-clean',
      'working tree is clean',
      'the runbook does not rebase a dirty tree; commit, stash or discard what is listed',
      preSyncGates.treeClean
    ],
    [
      'conflict-markers',
      'no conflict markers',
      'resolve the leftover conflict before rebasing; markers never survive a merge by design',
      () => conflictMarkers()
    ],
    [
      'localization-catalog',
      'derived localization catalog is in sync',
      'commit the regenerated catalog; hand-merging a derived file is the failure this checks for',
      localizationCatalog
    ],
    [
      'fork-branch',
      `local(...) commits are confined to ${FORK_BRANCH}`,
      `check out ${FORK_BRANCH} before rebasing; the .husky/commit-msg hook refuses local(...) elsewhere`,
      preSyncGates.forkBranch
    ],
    [
      'remotes',
      'branch and remotes point where this sync expects',
      'a sync against the wrong remote rewrites the wrong line; fix the remotes before rebasing',
      preSyncGates.remotes
    ],
    [
      'sync-shas',
      'old base, local old tip and new base are recorded',
      'a missing ref means the sync has no endpoint; a local branch behind or diverged from its upstream has to be reconciled first (fetch both remotes)',
      () => preSyncGates.syncShas(options)
    ],
    [
      'conflict-dry-run',
      'merge dry run',
      'read the raw merge-tree output by hand; the conflict count above is not trustworthy',
      () => preSyncGates.conflictDryRun(options)
    ],
    [
      'typecheck',
      `fork tip typechecks (${TYPE_CHECK_COMMAND})`,
      'the starting tip is red: fix it before the rebase, or every later failure is ambiguous',
      () => typecheck(options)
    ]
  ]
  for (const [id, title, look, run] of gates) {
    try {
      report.addOutcome(id, title, look, run())
    } catch (error) {
      report.add(id, STATUS.failed, title, `${id} crashed: ${error.message}`, {
        look: 'this is a bug in local/sync/pre-sync.mjs, not a finding about the repository',
        details: String(error.stack ?? '')
          .split('\n')
          .slice(0, 6)
      })
    }
  }
  const prepared = options.prepare ? prepare(options, report.failures.length, options.rebase) : null
  const summary = prepared
    ? [
        '',
        `--prepare (state file: ${stateFilePath()}):`,
        ...prepared.messages.map((line) => `  ${line}`)
      ]
    : []
  console.log(
    options.json
      ? JSON.stringify(report.toJSON({ prepare: prepared }), null, 2)
      : report.render(summary)
  )
  // A failed --prepare has to be non-zero even though its own gates passed, and a stale backup is a
  // reported condition, not a pass.
  if (prepared && prepared.failures.length > 0) {
    process.exit(1)
  }
  process.exit(report.failures.length === 0 ? 0 : 1)
}

main()
