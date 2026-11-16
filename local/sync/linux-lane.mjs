#!/usr/bin/env node
/**
 * Run the nightly Linux unit lane on a sync candidate, long before the release gates.
 *
 * Why: five of the six 2026-11-16 release dispatches failed, four of them in `fork-release.yml`'s Linux
 * unit lane on tests the Mac gate quarantines or skips. Each red cost a fix, a review-manifest commit, a
 * push and a dispatch — 8 to 60 minutes a loop. `fork-main-tests.yml` runs the same shard plan on the
 * same runner in ~12 minutes at no cost, and a `workflow_dispatch` on a ref runs that ref's own copy of
 * the workflow (and of `unit-tests.yml` and `local/nightly-linux-known-red.json`), so the merged tree is
 * what gets tested. UPSTREAM-SYNC-RUNBOOK.md § Step 3.5 is the step this serves.
 *
 * Why a script rather than two commands: the push is the dangerous half. The candidate's tree carries
 * upstream's freshly merged workflow files, a file new to this repository arrives enabled, and a `push:`
 * trigger evaluates the pushed commit's own copy. So before pushing, every workflow file in the
 * candidate's tree is read for a `push`/`create` trigger that this branch name would fire, and every
 * runner label `fork-main-tests.yml` can reach is checked against what this fork provisions — a job on a
 * label nobody serves queues for 24 h and `timeout-minutes` does not bound it.
 *
 *   node local/sync/linux-lane.mjs                     push HEAD to sync-candidate/<sha12>, dispatch
 *   node local/sync/linux-lane.mjs --dry-run           print the plan and the safety verdict only
 *   node local/sync/linux-lane.mjs --cleanup           delete candidate refs main already contains
 *   node local/sync/linux-lane.mjs --cleanup --dry-run list what --cleanup would delete
 *
 * The ref is per revision, so a push only ever creates a ref (never a force-push), and two candidates
 * never cancel each other through the workflow's `github.ref` concurrency group. Re-running on the same
 * revision re-dispatches on the same ref, which supersedes the earlier run of that revision.
 *
 * Exit: 0 dispatched (or the plan is safe), 1 the push, dispatch or delete failed, 2 refused.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parse } from 'yaml'
import { ACCEPTED_RUNNER_LABELS } from '../actions-enablement-contract.mjs'
import { calleesOf, runnerLabelsOf, triggersOf } from '../check-actions-enablement.mjs'

const ROOT = resolve(import.meta.dirname, '../..')
const REPO = 'nplez1/orca'
const LANE = '.github/workflows/fork-main-tests.yml'
export const CANDIDATE_PREFIX = 'sync-candidate/'

export const candidateRef = (sha) => `${CANDIDATE_PREFIX}${sha.slice(0, 12)}`

/** One GitHub filter pattern (`*`, `**`, `?`, `+`, `[…]`, `\` escapes) as an anchored regex. */
export function filterPatternRegex(pattern) {
  let out = ''
  for (let i = 0; i < pattern.length; i += 1) {
    const c = pattern[i]
    if (c === '\\' && i + 1 < pattern.length) {
      i += 1
      out += pattern[i].replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')
    } else if (c === '*') {
      if (pattern[i + 1] === '*') {
        out += '.*'
        i += 1
      } else {
        out += '[^/]*'
      }
    } else if (c === '?' || c === '+') {
      // GitHub reads both as quantifiers on the preceding character, which is what a regex does.
      out += c
    } else if (c === '[' && pattern.indexOf(']', i) > i) {
      const end = pattern.indexOf(']', i)
      out += pattern.slice(i, end + 1)
      i = end
    } else {
      out += c.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')
    }
  }
  try {
    return new RegExp(`^${out}$`)
  } catch {
    // A pattern this reading cannot compile is treated as matching everything: refusing a safe name
    // costs a rename, and passing an unsafe one starts a workflow nobody reviewed.
    return /^/
  }
}

const asList = (value) => (Array.isArray(value) ? value.map(String) : [String(value)])

/** Whether a `branches` list selects `branch`: patterns apply in order, and a later `!` unselects. */
function selectedBy(patterns, branch) {
  let selected = false
  for (const pattern of patterns) {
    if (pattern.startsWith('!')) {
      if (filterPatternRegex(pattern.slice(1)).test(branch)) {
        selected = false
      }
    } else if (filterPatternRegex(pattern).test(branch)) {
      selected = true
    }
  }
  return selected
}

/**
 * Whether a push of a new branch named `branch` fires this `on.push` value. `paths` filters are not
 * evaluated: what a new branch is compared against is GitHub's call, so they count as matching.
 */
export function pushFires(push, branch) {
  if (push === null || push === undefined || typeof push !== 'object' || Array.isArray(push)) {
    return true
  }
  if (push.branches !== undefined) {
    return selectedBy(asList(push.branches), branch)
  }
  if (push['branches-ignore'] !== undefined) {
    return !asList(push['branches-ignore']).some((p) => filterPatternRegex(p).test(branch))
  }
  // A tags-only filter never fires on a branch push.
  return push.tags === undefined && push['tags-ignore'] === undefined
}

/** The workflow files in `files` ({path: text}) that creating `branch` would start, with why. */
export function workflowsFiredBy(files, branch) {
  const fired = []
  for (const [path, text] of Object.entries(files)) {
    let triggers
    let doc
    try {
      triggers = triggersOf(text)
      doc = parse(text)
    } catch (error) {
      fired.push({ path, why: `unparseable, so it cannot be cleared: ${error.message}` })
      continue
    }
    if (triggers.includes('create')) {
      fired.push({ path, why: '`create` fires on every new branch' })
    }
    if (triggers.includes('push')) {
      const on = Object.hasOwn(doc, 'on') ? doc.on : doc[true]
      const push = on !== null && typeof on === 'object' && !Array.isArray(on) ? on.push : null
      if (pushFires(push, branch)) {
        fired.push({
          path,
          why: `on.push ${JSON.stringify(push ?? 'unfiltered')} matches ${branch}`
        })
      }
    }
  }
  return fired
}

/** Runner labels the lane can reach (itself and its `uses: ./…` callees) that nothing here serves. */
export function unservedLabels(files, entry = LANE) {
  const seen = new Set()
  const queue = [entry]
  const unserved = []
  while (queue.length > 0) {
    const path = queue.shift()
    if (seen.has(path) || files[path] === undefined) {
      continue
    }
    seen.add(path)
    const accepted = new Set(ACCEPTED_RUNNER_LABELS[path]?.labels ?? [])
    for (const label of runnerLabelsOf(files[path])) {
      if (!accepted.has(label)) {
        unserved.push({ path, label })
      }
    }
    queue.push(...calleesOf(files[path]))
  }
  return unserved
}

/** Everything that makes pushing this candidate unsafe or pointless, as sentences. */
export function refusalsFor({ toplevel, root, remotes, dirty, files, branch }) {
  const problems = []
  if (toplevel && root && toplevel !== root) {
    problems.push(`run this from ${root} (the checkout this script lives in), not ${toplevel}`)
  }
  if (!remotes.includes('origin')) {
    problems.push("no 'origin' remote — the candidate goes to the fork")
  }
  if (dirty.length > 0) {
    problems.push(
      `${dirty.length} tracked file(s) are modified — the candidate is HEAD, so commit first or the ` +
        'lane tests a tree you are not shipping'
    )
  }
  const lane = files[LANE]
  if (lane === undefined) {
    problems.push(`${LANE} is not in the candidate's tree`)
  } else if (!triggersOf(lane).includes('workflow_dispatch')) {
    problems.push(`${LANE} in the candidate's tree has no workflow_dispatch trigger`)
  }
  for (const { path, why } of workflowsFiredBy(files, branch)) {
    problems.push(`pushing ${branch} would start ${path}: ${why}`)
  }
  for (const { path, label } of unservedLabels(files)) {
    problems.push(
      `${path} asks for runner '${label}', which this fork does not provision (a job there queues ` +
        'for 24 h) — fix the workflow or record it in local/actions-enablement-contract.mjs'
    )
  }
  return problems
}

/** The run id GitHub printed for a dispatch, if it printed one. */
export function runIdFrom(output) {
  return /\/actions\/runs\/(\d+)/.exec(output ?? '')?.[1] ?? null
}

/** Which candidate refs `--cleanup` may delete: only those whose commit main already contains. */
export function partitionForCleanup(refs, isMerged) {
  const remove = []
  const keep = []
  for (const ref of refs) {
    ;(isMerged(ref.sha) ? remove : keep).push(ref)
  }
  return { remove, keep }
}

const git = (...args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' })

function treeWorkflows(sha) {
  const files = {}
  const listing = git('ls-tree', '--name-only', sha, '.github/workflows/')
  for (const path of listing.split('\n').filter((line) => /\.ya?ml$/.test(line))) {
    files[path] = git('show', `${sha}:${path}`)
  }
  return files
}

function facts(cwd, sha, branch) {
  const remotes = git('remote')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
  let toplevel = null
  try {
    toplevel = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd,
      encoding: 'utf8'
    }).trim()
  } catch {
    toplevel = null
  }
  const dirty = git('status', '--porcelain', '--untracked-files=no').split('\n').filter(Boolean)
  return { toplevel, root: ROOT, remotes, dirty, files: treeWorkflows(sha), branch }
}

const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)

/** The dispatch's run id: printed by `gh workflow run`, or found by ref and commit shortly after. */
function findRun(dispatchOutput, branch, sha) {
  const printed = runIdFrom(dispatchOutput)
  if (printed) {
    return printed
  }
  for (let attempt = 0; attempt < 10; attempt += 1) {
    pause(3000)
    const list = spawnSync(
      'gh',
      [
        'run',
        'list',
        '--repo',
        REPO,
        '--workflow',
        'fork-main-tests.yml',
        '--branch',
        branch,
        '--event',
        'workflow_dispatch',
        '--limit',
        '5',
        '--json',
        'databaseId,headSha'
      ],
      { encoding: 'utf8' }
    )
    const match = JSON.parse(list.stdout || '[]').find((run) => run.headSha === sha)
    if (match) {
      return String(match.databaseId)
    }
  }
  return null
}

function cleanup(dryRun) {
  const listing = git('ls-remote', '--heads', 'origin', `refs/heads/${CANDIDATE_PREFIX}*`)
  const refs = listing
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [sha, ref] = line.split('\t')
      return { sha, branch: ref.replace(/^refs\/heads\//, '') }
    })
  git('fetch', '--quiet', 'origin', 'main')
  const isMerged = (sha) =>
    spawnSync('git', ['merge-base', '--is-ancestor', sha, 'origin/main'], { cwd: ROOT }).status ===
    0
  const { remove, keep } = partitionForCleanup(refs, isMerged)
  for (const ref of keep) {
    console.log(`linux-lane: keeping ${ref.branch} — ${ref.sha.slice(0, 12)} is not in origin/main`)
  }
  if (remove.length === 0) {
    console.log('linux-lane: no merged candidate refs to delete')
    return 0
  }
  const args = ['push', 'origin', '--delete', ...remove.map((ref) => ref.branch)]
  console.log(`linux-lane: ${dryRun ? 'would run' : 'running'}: git ${args.join(' ')}`)
  if (dryRun) {
    return 0
  }
  const result = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' })
  process.stdout.write(`${result.stdout ?? ''}${result.stderr ?? ''}`)
  return result.status === 0 ? 0 : 1
}

function main() {
  const dryRun = process.argv.includes('--dry-run')
  if (process.argv.includes('--cleanup')) {
    process.exit(cleanup(dryRun))
  }

  const sha = git('rev-parse', 'HEAD').trim()
  const branch = candidateRef(sha)
  const refusals = refusalsFor(facts(process.cwd(), sha, branch))
  if (refusals.length > 0) {
    for (const problem of refusals) {
      console.error(`linux-lane: refusing — ${problem}`)
    }
    process.exit(2)
  }

  const push = ['push', 'origin', `${sha}:refs/heads/${branch}`]
  const dispatch = ['workflow', 'run', 'fork-main-tests.yml', '--repo', REPO, '--ref', branch]
  console.log(`linux-lane: ${dryRun ? 'plan (safe to push)' : 'pushing'} ${sha.slice(0, 12)}`)
  console.log(`  1. git ${push.join(' ')}`)
  console.log(`  2. gh ${dispatch.join(' ')}`)
  if (dryRun) {
    process.exit(0)
  }

  const pushed = spawnSync('git', push, { cwd: ROOT, encoding: 'utf8' })
  process.stdout.write(`${pushed.stdout ?? ''}${pushed.stderr ?? ''}`)
  if (pushed.status !== 0) {
    console.error('linux-lane: the push failed, so nothing was dispatched')
    process.exit(1)
  }
  const dispatched = spawnSync('gh', dispatch, { cwd: ROOT, encoding: 'utf8' })
  process.stdout.write(`${dispatched.stdout ?? ''}${dispatched.stderr ?? ''}`)
  if (dispatched.status !== 0) {
    console.error(`linux-lane: ${branch} is pushed but the dispatch failed — re-run this command`)
    process.exit(1)
  }
  const runId = findRun(`${dispatched.stdout ?? ''}${dispatched.stderr ?? ''}`, branch, sha)
  if (!runId) {
    console.log(
      `linux-lane: dispatched; find the run with ` +
        `gh run list --repo ${REPO} --workflow fork-main-tests.yml --branch ${branch}`
    )
    process.exit(0)
  }
  console.log(`linux-lane: run ${runId} on ${branch}`)
  console.log(`  gh run watch ${runId} --repo ${REPO} --compact --exit-status`)
  process.exit(0)
}

if (
  process.argv[1] &&
  existsSync(process.argv[1]) &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  main()
}
