#!/usr/bin/env node
/**
 * Publish the synced release line to this fork, then sweep the Actions fleet — as one step.
 *
 * `UPSTREAM-SYNC-RUNBOOK.md` step 4 pushes the merge to the fork's `main` branch. A workflow file new
 * to that push arrives **active**: a file with `push: [main]` fires on that very push, and one with
 * `schedule` or `pull_request` starts firing as soon as it exists on this repository, whose default
 * branch is `main`. The enablement check cannot get ahead of that, because GitHub has no workflow to
 * disable until the file is there — so the only lever is sweeping immediately, which is what this
 * wrapper exists to make unskippable. On 2026-10-28T13:17Z the equivalent push started "Unit transform
 * cache producer", which then wedged for 12 hours; a sweep alone would not have stopped a run already
 * going, which is why `check-actions-enablement --fix` also cancels the queued and in-progress runs of
 * whatever it disables.
 *
 * Why it replaced `push-upstream-mirror.mjs`: that script pushed `upstream/main` to a fork branch
 * literally named `main`, which was the upstream mirror. `main` is now the fork's own line, so the
 * same command would have overwritten it with upstream's tree. The push is the fork line and nothing
 * else; there is no mirror branch left to keep in step.
 *
 * The two halves are one command on purpose: a runbook line that says "push, then remember to sweep"
 * is the same failure with more words.
 *
 *   node local/sync/publish-sync.mjs            push, then `check-actions-enablement --fix`
 *   node local/sync/publish-sync.mjs --dry-run   print the plan and what is on now; changes nothing
 *
 * Exit: 0 pushed and clean, 1 the push or the sweep failed, 2 refused before pushing or the sweep could
 * not tell.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const ROOT = resolve(import.meta.dirname, '../..')

/** One fixed refspec: the fork's release line, and nothing else. */
export const SYNC_PUSH = ['push', '--atomic', 'origin', 'main']
export const SWEEP = ['node', 'local/check-actions-enablement.mjs', '--fix']

/** Why the push cannot be judged without both remotes, and what to do about it. */
export function refusalsFor({ remotes, hasUpstreamMain, toplevel, root }) {
  const problems = []
  if (toplevel && root && toplevel !== root) {
    // The push runs in the cwd's repository and the sweep runs in this script's; two checkouts at
    // once is how a sweep lands on the wrong fork.
    problems.push(`run this from ${root} (the checkout this script lives in), not ${toplevel}`)
  }
  for (const name of ['origin', 'upstream']) {
    if (!remotes.includes(name)) {
      problems.push(`no '${name}' remote — origin is the fork, upstream is read-only`)
    }
  }
  if (!hasUpstreamMain) {
    problems.push(
      "upstream/main does not resolve — 'git fetch upstream' first, so the line being published is " +
        'the sync you reviewed and not a stale one'
    )
  }
  return problems
}

/**
 * What the run meant, from the two exit statuses. A sweep that exited 2 never reached a verdict, which
 * is not the same as a fleet that drifted — and the difference decides what the operator does next.
 */
export function judgeRun({ pushStatus, sweepStatus }) {
  if (pushStatus !== 0) {
    return {
      code: 1,
      message: 'the push failed, so no sweep was attempted — fix the push and run this again'
    }
  }
  if (sweepStatus === 0) {
    return { code: 0, message: 'pushed, and the fleet swept in the same step' }
  }
  if (sweepStatus === 2) {
    return {
      code: 2,
      message:
        'the push landed but the sweep could not reach the API, so a new workflow may still be ' +
        'running — run `node local/check-actions-enablement.mjs --fix` as soon as it can'
    }
  }
  return {
    code: 1,
    message:
      'the push landed but the fleet is not clean — run `node local/check-actions-enablement.mjs` ' +
      'and record the outcome in LOCAL-PATCHES.md § local(ci)'
  }
}

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' })

function facts(cwd) {
  let remotes = []
  try {
    remotes = git(cwd, 'remote')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
  } catch {
    return { remotes, hasUpstreamMain: false, toplevel: null, root: ROOT }
  }
  const verify = spawnSync('git', ['rev-parse', '--verify', '--quiet', 'upstream/main'], { cwd })
  let toplevel = null
  try {
    toplevel = git(cwd, 'rev-parse', '--show-toplevel').trim()
  } catch {
    toplevel = null
  }
  return { remotes, hasUpstreamMain: verify.status === 0, toplevel, root: ROOT }
}

function main() {
  const cwd = process.cwd()
  const dryRun = process.argv.includes('--dry-run')
  const refusals = refusalsFor(facts(cwd))
  if (refusals.length > 0) {
    for (const problem of refusals) {
      console.error(`publish-sync: refusing — ${problem}`)
    }
    process.exit(2)
  }

  console.log(`publish-sync: ${dryRun ? 'plan' : 'pushing'}`)
  console.log(`  1. git ${SYNC_PUSH.join(' ')}`)
  console.log(`  2. ${SWEEP.join(' ')}`)

  if (dryRun) {
    // Report-only: the sweep is the interesting half when nothing is being pushed, and its verdict is
    // this run's verdict — 0 clean, 1 drift, 2 could not tell.
    const check = spawnSync('node', ['local/check-actions-enablement.mjs'], {
      cwd: ROOT,
      encoding: 'utf8'
    })
    process.stdout.write(`${check.stdout ?? ''}${check.stderr ?? ''}`)
    process.exit(check.status ?? 2)
  }

  const push = spawnSync('git', SYNC_PUSH, { cwd, encoding: 'utf8' })
  process.stdout.write(`${push.stdout ?? ''}${push.stderr ?? ''}`)
  if (push.status !== 0) {
    const verdict = judgeRun({ pushStatus: push.status ?? 1, sweepStatus: null })
    console.error(`publish-sync: ${verdict.message}`)
    process.exit(verdict.code)
  }

  // Never skipped, never deferred: the push is what turns new workflow files on.
  const sweep = spawnSync(SWEEP[0], SWEEP.slice(1), {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  })
  process.stdout.write(`${sweep.stdout ?? ''}${sweep.stderr ?? ''}`)
  const verdict = judgeRun({ pushStatus: 0, sweepStatus: sweep.status ?? 2 })
  if (verdict.code === 0) {
    console.log(`publish-sync: ${verdict.message}`)
  } else {
    console.error(`publish-sync: ${verdict.message}`)
  }
  process.exit(verdict.code)
}

if (
  process.argv[1] &&
  existsSync(process.argv[1]) &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  main()
}
