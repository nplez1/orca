#!/usr/bin/env node
/**
 * The only documented way to dispatch a fork release.
 *
 * Why a wrapper and not the runbook's `gh workflow run fork-release.yml`. That command has no
 * preconditions at all: `workflow_dispatch` accepts any ref and any state of the tree, so the release
 * boundary was one line a reader could run before the review existed, while a gate was running, or
 * from a working tree with uncommitted edits. `local/open-pr.mjs` refuses a PR body without a review
 * claim; nothing refused a release without a review. This is that missing refusal.
 *
 * The four preconditions, in the order they are cheapest to fix:
 *
 *   1. the review of this exact revision is COMPLETE (`local/release-review-gate.mjs`) — every slice
 *      reported, no unresolved blocking finding;
 *   2. the tree is clean, so the tag names a commit and not a commit plus edits;
 *   3. HEAD is the remote's `main` tip as `git ls-remote` reads it now, because the workflow refuses
 *      any other ref and the local `origin/main` may be behind a merge that landed since a fetch;
 *   4. the Actions fleet is swept, because a workflow that came back enabled during a sync starts its
 *      own run on the release push (`RELEASE-RUNBOOK.md` step 0.5).
 *
 * Why the tip is read from the remote and not from `origin/main`: the review is of a commit, and the
 * build runs on whatever `main` is when the run starts. A stale tracking ref passes the gate on the
 * reviewed commit while CI publishes a newer tip. The same SHA is passed to the workflow as
 * `expected_sha`, so the run itself refuses if `main` moves again between the dispatch and the build.
 *
 *   node local/dispatch-release.mjs                          gate, then dispatch
 *   node local/dispatch-release.mjs --dry-run                 report the preconditions, dispatch nothing
 *   node local/dispatch-release.mjs -f version_suffix=np.50    pin the suffix above the newest tag
 *   node local/dispatch-release.mjs --waive-review "<reason>"  dispatch with the review gate waived
 *
 * Why `--waive-review` records rather than silently passes: the same reason as `open-pr.mjs`'s
 * `--waive-gate` — a waiver a reader cannot find is not recorded. It prints the reason, writes it to
 * the dispatch line it reports, and exits non-zero on a dry run so the decision is inspectable before
 * it is spent.
 *
 * Exit: 0 dispatched (or dry-run clean), 1 refused, 2 usage.
 */
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'

const repoRoot = join(import.meta.dirname, '..')
const WORKFLOW = 'fork-release.yml'
const DEFAULT_REPO = 'nplez1/orca'

function run(command, args, { capture = true } = {}) {
  return execFileSync(command, args, {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit'
  })
}

function tryRun(command, args) {
  try {
    return { ok: true, out: run(command, args).trim() }
  } catch (error) {
    return { ok: false, out: `${error.stdout ?? ''}${error.stderr ?? ''}`.trim() || error.message }
  }
}

function parse(argv) {
  const options = { dryRun: false, waiver: '', suffix: '', repo: DEFAULT_REPO }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--dry-run') {
      options.dryRun = true
    } else if (arg === '--waive-review') {
      options.waiver = argv[i + 1] ?? ''
      i += 1
    } else if (arg === '-f' || arg === '--version-suffix') {
      options.suffix = argv[i + 1] ?? ''
      i += 1
    } else if (arg.startsWith('--repo=')) {
      options.repo = arg.slice('--repo='.length)
    } else {
      throw new Error(`unknown argument: ${arg}`)
    }
  }
  return options
}

function preconditions(options) {
  const problems = []
  const notes = []

  const head = tryRun('git', ['rev-parse', 'HEAD'])
  const dirty = tryRun('git', ['status', '--porcelain'])
  if (!dirty.ok) {
    problems.push(`git status failed: ${dirty.out}`)
  } else if (dirty.out) {
    problems.push(
      `working tree is dirty (${dirty.out.split('\n').length} path(s)); commit or stash first`
    )
  }

  if (head.ok) {
    // Why the remote and not `origin/main`: the tracking ref is only as fresh as the last fetch, and
    // this gate exists to be right about what CI will build. Why the repo, not `origin`: `--repo=`
    // dispatches to that repository, so its `main` is the branch CI will check out. `origin` is the
    // right remote for the default only because it names the same repository.
    const remote =
      options.repo === DEFAULT_REPO ? 'origin' : `https://github.com/${options.repo}.git`
    const tip = tryRun('git', ['ls-remote', remote, 'refs/heads/main'])
    const tipSha = tip.ok ? (tip.out.split(/\s+/)[0] ?? '') : ''
    if (!tip.ok || !/^[0-9a-f]{40,64}$/i.test(tipSha)) {
      problems.push(`cannot read the remote's main tip: ${tip.out || 'no sha returned'}`)
    } else if (tipSha !== head.out) {
      problems.push(
        `HEAD ${head.out.slice(0, 12)} is not the remote's main ${tipSha.slice(0, 12)}; push or pull first`
      )
    }
  }

  if (options.waiver.trim()) {
    notes.push(`review gate WAIVED: ${options.waiver.trim()}`)
  } else {
    const gate = tryRun('node', ['local/release-review-gate.mjs'])
    if (gate.ok) {
      notes.push(gate.out)
    } else {
      problems.push(gate.out || 'release review gate refused')
    }
  }

  const fleet = tryRun('node', ['local/check-actions-enablement.mjs'])
  if (fleet.ok) {
    const fleetLines = fleet.out.split('\n').filter(Boolean)
    notes.push(fleetLines.at(-1) ?? 'actions fleet OK')
  } else {
    problems.push(
      `actions enablement drift; run node local/check-actions-enablement.mjs --fix\n${fleet.out}`
    )
  }

  return { problems, notes, head: head.ok ? head.out : null }
}

function main(argv) {
  let options
  try {
    options = parse(argv)
  } catch (error) {
    console.error(`dispatch-release: ${error.message}`)
    return 2
  }

  const { problems, notes, head } = preconditions(options)
  console.log('dispatch-release: preconditions')
  for (const note of notes) {
    console.log(`  ok: ${note}`)
  }
  if (problems.length) {
    for (const problem of problems) {
      console.error(`  REFUSE: ${problem}`)
    }
    console.error('dispatch-release: refused — nothing was dispatched')
    return 1
  }

  const args = ['workflow', 'run', WORKFLOW, '--repo', options.repo, '--ref', 'main']
  // Why: the run refuses unless `main` is still this commit, so a merge that lands between the
  // dispatch and the build cannot publish a tip nobody reviewed.
  if (head) {
    args.push('-f', `expected_sha=${head}`)
  }
  if (options.suffix) {
    args.push('-f', `version_suffix=${options.suffix}`)
  }
  const command = `gh ${args.join(' ')}${options.waiver.trim() ? ` # review WAIVED: ${options.waiver.trim()}` : ''}`
  if (options.dryRun) {
    console.log(`  would run: ${command}`)
    // Why 1 for a waived dry run: the review was not checked, and a green dry run would read as one
    // that was. The decision is meant to be inspected before it is spent.
    if (options.waiver.trim()) {
      console.error(
        'dispatch-release: dry run with --waive-review — the review gate was not run; nothing was dispatched'
      )
      return 1
    }
    console.log(`dispatch-release: dry run — ${head?.slice(0, 12)} clears every precondition`)
    return 0
  }

  const dispatched = tryRun('gh', args)
  if (!dispatched.ok) {
    console.error(`dispatch-release: dispatch failed: ${dispatched.out}`)
    return 1
  }
  console.log(`dispatch-release: dispatched ${WORKFLOW} at ${head?.slice(0, 12)}`)
  if (options.waiver.trim()) {
    // Why again after the dispatch: the line above is what a reader of a release run finds first.
    console.log(`  review WAIVED: ${options.waiver.trim()}`)
  }
  const listed = tryRun('gh', [
    'run',
    'list',
    '--repo',
    options.repo,
    '--workflow',
    WORKFLOW,
    '-L1',
    '--json',
    'url'
  ])
  if (listed.ok) {
    try {
      console.log(`  run: ${JSON.parse(listed.out).at(0)?.url ?? '(list failed)'}`)
    } catch {
      // Why swallowed: the dispatch already succeeded, and a run URL is a convenience, not the record.
    }
  }
  return 0
}

process.exitCode = main(process.argv.slice(2))
