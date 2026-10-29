#!/usr/bin/env node
// Post-merge fork-symbol survival: fork-added names (old-base..pre-sync tip) the merged tree lost.
// Read-only. The modified-file companion to post-sync's deleted-fork-modules row.
//
//   node local/sync/fork-symbols.mjs [--json]
//   node local/sync/fork-symbols.mjs --old-base <ref> --tip <ref> --new-base <ref> [--merged <ref>] [--json]

import process from 'node:process'
import { forkSymbolSurvival, scanForkSymbols } from './lib/fork-symbol-check.mjs'
import { resolvePreSyncTip } from './lib/sync-range.mjs'
import { gitText } from './lib/run.mjs'

const HELP = `fork-symbol survival — which names the fork added are gone after a merge

usage
  node local/sync/fork-symbols.mjs [--json]          tip and base from pre-sync's state (or the backup ref)
  node local/sync/fork-symbols.mjs --old-base <ref> --tip <ref> --new-base <ref> [--merged <ref>] [--json]

A name is a top-level declaration, or a member of a top-level class, interface, type literal, enum or
object-literal constant. Each lost name is \`lost\` (fails), \`relocated\` (fails: the bare name is still on
a merged line the fork did not add; review it) or \`acknowledged\` by a \`symbols\` entry with status
expected-deletion in local/sync/expected-deletions.json. --json prints \`manifestEntries\` ready to paste
there once a reviewer has judged them; they are written as pending-decision, which silences nothing.
--merged must contain both the tip and the new base: mid-conflict HEAD is still the tip, and fails.`

function parseArgs(argv) {
  const options = { json: false, merged: 'HEAD' }
  const VALUE = {
    '--old-base': 'oldBase',
    '--tip': 'tip',
    '--new-base': 'newBase',
    '--merged': 'merged'
  }
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    if (flag === '--json') {
      options.json = true
    } else if (flag === '--help' || flag === '-h') {
      options.help = true
    } else if (VALUE[flag] && argv[index + 1]) {
      options[VALUE[flag]] = argv[index + 1]
      index += 1
    } else {
      throw new Error(`unknown or incomplete argument: ${flag}`)
    }
  }
  const explicit = ['oldBase', 'tip', 'newBase'].filter((key) => options[key])
  if (explicit.length !== 0 && explicit.length !== 3) {
    throw new Error('--old-base, --tip and --new-base go together')
  }
  return options
}

function main() {
  let options
  try {
    options = parseArgs(process.argv.slice(2))
  } catch (error) {
    console.error(`fork-symbols: ${error.message}\n\n${HELP}`)
    return 2
  }
  if (options.help) {
    console.log(HELP)
    return 0
  }
  let outcome
  if (options.tip) {
    const commit = (ref) => gitText(['rev-parse', '--verify', `${ref}^{commit}`]) ?? ref
    outcome = scanForkSymbols({
      oldBase: commit(options.oldBase),
      tip: commit(options.tip),
      newBase: commit(options.newBase),
      merged: options.merged
    })
  } else {
    const { tip, source } = resolvePreSyncTip()
    outcome = forkSymbolSurvival(tip, source, { merged: options.merged })
  }
  if (options.json) {
    console.log(JSON.stringify(outcome, null, 2))
  } else {
    console.log(`[${outcome.status}] ${outcome.summary}`)
    for (const line of outcome.details) {
      console.log(`  ${line}`)
    }
  }
  return outcome.status === 'failed' ? 1 : 0
}

// exitCode, not exit(): exit() truncates a large --json still draining into a pipe.
process.exitCode = main()
