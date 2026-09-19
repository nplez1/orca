#!/usr/bin/env node
// Open a pull request for a branch, in this fork, by default.
//
// Why a script rather than remembering the flags: nplez1/orca is a fork of stablyai/orca, so a
// bare `gh pr create` offers the parent repository as the base, and nothing in the repository
// said which of the two a PR belongs to. A PR aimed at upstream is a decision, not a default
// (see BRANCHES.md), so upstream requires the explicit `--upstream` flag here.
//
// Why the ancestry check: this fork's own line is `nplez1/main`, while `main` mirrors upstream.
// A branch cut from `main` and opened against `nplez1/main` still looks like a small diff
// locally, but the PR then carries every fork-only patch as a reversion. Descendant-of-base is
// the property that rules that out, and it fails loudly instead of showing up in review.
//
//   node local/open-pr.mjs --title "fix(git): ..." --body-file /tmp/body.md
//   node local/open-pr.mjs --title "..." --body-file /tmp/body.md --dry-run
//   node local/open-pr.mjs --title "..." --body-file /tmp/body.md --upstream
//
// Upstream PRs are cut from `main`, this fork's PRs from `nplez1/main`; `--base <branch>`
// overrides either.

import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import process from 'node:process'

const FORK = 'nplez1/orca'
const UPSTREAM = 'stablyai/orca'
const FORK_BASE = 'nplez1/main'
const UPSTREAM_BASE = 'main'

function run(command, args) {
  return execFileSync(command, args, { encoding: 'utf8' }).trim()
}

function git(args) {
  return run('git', args)
}

function parseArgs(argv) {
  const options = { upstream: false, dryRun: false, base: null, branch: null }
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    const value = argv[index + 1]
    if (flag === '--upstream') {
      options.upstream = true
    } else if (flag === '--dry-run') {
      options.dryRun = true
    } else if (flag === '--title') {
      options.title = value
      index += 1
    } else if (flag === '--body-file') {
      options.bodyFile = value
      index += 1
    } else if (flag === '--branch') {
      options.branch = value
      index += 1
    } else if (flag === '--base') {
      options.base = value
      index += 1
    } else if (flag === '--help' || flag === '-h') {
      options.help = true
    } else {
      throw new Error(`Unknown argument: ${flag}`)
    }
  }
  return options
}

function usage() {
  console.log(`Usage: node local/open-pr.mjs --title <title> --body-file <path> [options]

  --upstream          target ${UPSTREAM} instead of this fork (explicit by design)
  --base <branch>     base branch (defaults: ${FORK_BASE}, or ${UPSTREAM_BASE} with --upstream)
  --branch <branch>   head branch (defaults to the checked-out branch)
  --dry-run           print the gh command instead of running it
`)
}

function fail(message) {
  console.error(`open-pr: ${message}`)
  process.exit(1)
}

function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    usage()
    return
  }

  const repository = options.upstream ? UPSTREAM : FORK
  const base = options.base ?? (options.upstream ? UPSTREAM_BASE : FORK_BASE)
  const branch = options.branch ?? git(['rev-parse', '--abbrev-ref', 'HEAD'])
  if (branch === 'HEAD') {
    fail('the checkout is detached; pass --branch <branch>.')
  }
  if (!options.title) {
    fail('--title is required.')
  }
  if (!options.bodyFile) {
    fail('--body-file is required.')
  }
  if (!existsSync(options.bodyFile)) {
    fail(`body file not found: ${options.bodyFile}`)
  }

  git(['fetch', '--quiet', 'origin', base])
  const baseRef = `origin/${base}`
  const localHead = git(['rev-parse', 'HEAD'])
  const branchHead = git(['rev-parse', '--verify', `refs/heads/${branch}`])

  // Why not a no-op when the branch is checked out: the check must hold for whatever is pushed.
  try {
    git(['merge-base', '--is-ancestor', baseRef, branchHead])
  } catch {
    fail(
      `'${branch}' is not a descendant of '${baseRef}'.\n` +
        `A branch cut from the wrong base lands as a PR full of the base's own commits as ` +
        `reversions. Rebase onto ${baseRef} first, or pass the base this branch was cut from.`
    )
  }

  const remoteHead = run('git', ['ls-remote', 'origin', `refs/heads/${branch}`]).split(/\s+/)[0]
  if (!remoteHead) {
    fail(`origin has no branch '${branch}'; push it first.`)
  }
  if (remoteHead !== branchHead) {
    fail(
      `origin/${branch} is at ${remoteHead.slice(0, 9)}, but refs/heads/${branch} is at ${branchHead.slice(0, 9)}; push before opening the PR.`
    )
  }

  const head = options.upstream ? `nplez1:${branch}` : branch
  const args = [
    'pr',
    'create',
    '--repo',
    repository,
    '--base',
    base,
    '--head',
    head,
    '--title',
    options.title,
    '--body-file',
    options.bodyFile
  ]

  if (options.dryRun) {
    console.log(
      `gh ${args.map((arg) => (arg.includes(' ') ? JSON.stringify(arg) : arg)).join(' ')}`
    )
    return
  }

  console.log(`open-pr: ${repository} <- ${branch} (base ${base}, head ${localHead.slice(0, 9)})`)
  console.log(run('gh', args))
}

try {
  main()
} catch (error) {
  fail(error instanceof Error ? error.message : String(error))
}
