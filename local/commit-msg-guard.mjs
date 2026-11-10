#!/usr/bin/env node
// LOCAL(nplez1): the commit-time half of the rule `local/open-pr.mjs --upstream` enforces at PR time.
// A fork-only change must never reach an upstream-bound branch: a `local(...)` subject there is a
// patch series that is reviewed nowhere, and a fork-owned path there is a file no upstream review can
// act on. It is `commit-msg` rather than `pre-commit` because the subject is what identifies the
// commit as fork-only, and `pre-commit` cannot see it.
//
// Why lineage and not the tip: the first version required the *current* `main` tip to be an
// ancestor of HEAD, so once the fork advanced — any other PR squash-merging — every older fork branch
// was refused. That pushed people to drop the `local(` label, the unlabelled fork-only commit that
// the hook's own header calls the worse outcome (#319). A branch that descends from the fork's own
// line is on that line however far behind it is.
import { readFileSync } from 'node:fs'
import process from 'node:process'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  FORK_LINE_REFS,
  UPSTREAM_BASE_REFS,
  forkOwnedStagedPaths,
  quietGitRun
} from './fork-owned-paths.mjs'

export const FORK_ON_LINE = 'fork'
export const UPSTREAM_BOUND = 'upstream'
export const UNCLASSIFIED = 'unknown'

function attempt(runGit, args) {
  try {
    return runGit(args)
  } catch {
    return null
  }
}

function firstResolvable(runGit, refs) {
  for (const ref of refs) {
    if (attempt(runGit, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]) !== null) {
      return ref
    }
  }
  return null
}

/**
 * Which line HEAD is on, by ancestry rather than by any tip.
 *
 * Why a list and not one base: excluding every resolvable upstream ref is what makes a stale base
 * harmless, and the union costs nothing. Since the 2026-11-09 rename there is one upstream ref —
 * `main` on both remotes is the fork's own line, so it can no longer be a second upstream base — but
 * the loop stays so that adding one back does not mean rewriting the check.
 */
export function classifyLineage(runGit = quietGitRun) {
  if (attempt(runGit, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}']) === null) {
    return { lineage: UNCLASSIFIED, why: 'HEAD is unborn' }
  }
  const forkRef = firstResolvable(runGit, FORK_LINE_REFS)
  if (forkRef === null) {
    return {
      lineage: UNCLASSIFIED,
      why: `no fork line ref resolves (${FORK_LINE_REFS.join(', ')})`
    }
  }
  // Why a missing merge base is `unknown` and not `upstream`: a shallow clone reports exactly that,
  // and this fork is cloned with `--depth` by CI and by agents. Refusing there is the false refusal
  // #319 is about; an upstream branch on an unrelated history is caught by `open-pr --upstream`.
  const bases = attempt(runGit, ['merge-base', '--all', 'HEAD', forkRef])
  if (bases === null || bases === '') {
    return { lineage: UNCLASSIFIED, why: `HEAD and ${forkRef} share no reachable history` }
  }
  const upstreamRefs = UPSTREAM_BASE_REFS.filter(
    (ref) => attempt(runGit, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]) !== null
  )
  if (upstreamRefs.length === 0) {
    return {
      lineage: UNCLASSIFIED,
      why: `no upstream ref resolves (${UPSTREAM_BASE_REFS.join(', ')})`
    }
  }
  const forkOnly = attempt(runGit, [
    'rev-list',
    '--max-count=1',
    ...bases.split('\n').filter(Boolean),
    '--not',
    ...upstreamRefs
  ])
  if (forkOnly === null) {
    return { lineage: UNCLASSIFIED, why: 'git rev-list failed' }
  }
  return forkOnly === ''
    ? { lineage: UPSTREAM_BOUND, why: `nothing behind HEAD is fork-only (${upstreamRefs[0]})` }
    : { lineage: FORK_ON_LINE, why: `${forkOnly.slice(0, 9)} is a fork-only commit behind HEAD` }
}

/**
 * The fork-owned paths this commit would add. Called only on an upstream-bound branch, and derived
 * against every upstream ref rather than the freshest guess, for the same staleness reason the
 * lineage check unions them.
 */
export function stagedForkOwned(runGit = quietGitRun) {
  const upstreamBases = UPSTREAM_BASE_REFS.filter(
    (ref) => attempt(runGit, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]) !== null
  )
  return forkOwnedStagedPaths(upstreamBases, runGit)
}

/**
 * The whole decision, separated from git and from the message file so it can be tested as a truth
 * table. `unknown` allows on purpose: the only checkouts that reach here with no resolvable fork or
 * upstream ref are fresh clones and odd remotes, and a hook that refuses those gets `--no-verify`'d —
 * which guards nothing at all. `open-pr --upstream` remains the backstop either way.
 */
export function decide({ subject, lineage, why = '', forkOwnedStaged = [], branch = '' }) {
  const forkOnlySubject = subject.startsWith('local(')
  if (lineage === UNCLASSIFIED) {
    return { ok: true, warning: `not classifying '${branch}' (${why}); the commit is allowed` }
  }
  if (lineage === FORK_ON_LINE) {
    return { ok: true }
  }
  if (forkOnlySubject) {
    return {
      ok: false,
      lines: [
        `refusing a fork-only commit on '${branch}', which is upstream-bound.`,
        `  '${subject}' belongs on a branch that descends from main.`,
        `  ${why}, so a fork-only change committed here is reviewed as part of that PR's diff.`
      ]
    }
  }
  if (forkOwnedStaged.length > 0) {
    const listed = forkOwnedStaged.slice(0, 8).map((path) => `  ${path}`)
    const more = forkOwnedStaged.length > 8 ? [`  …and ${forkOwnedStaged.length - 8} more`] : []
    return {
      ok: false,
      lines: [
        `refusing ${forkOwnedStaged.length} fork-owned file(s) on '${branch}', which is upstream-bound:`,
        ...listed,
        ...more,
        `  ${why}. These paths exist only in this fork and no upstream review can act on them.`,
        '  Unstage them (git restore --staged <path>), or open the PR against the fork.'
      ]
    }
  }
  return { ok: true }
}

function currentBranch(runGit) {
  const branch = attempt(runGit, ['rev-parse', '--abbrev-ref', 'HEAD'])
  return !branch || branch === 'HEAD' ? '(detached)' : branch
}

/** Why the first non-blank, non-comment line: git runs this hook before it strips either. */
function subjectOf(message) {
  for (const line of message.split('\n')) {
    const trimmed = line.trim()
    if (trimmed !== '' && !trimmed.startsWith('#')) {
      return trimmed
    }
  }
  return ''
}

export function main(argv = process.argv.slice(2), runGit = quietGitRun) {
  const messageFile = argv[0]
  if (!messageFile) {
    console.error('commit-msg-guard: usage: commit-msg-guard.mjs <commit-message-file>')
    return 1
  }
  const subject = subjectOf(readFileSync(messageFile, 'utf8'))
  const { lineage, why } = classifyLineage(runGit)
  const forkOwnedStaged = lineage === UPSTREAM_BOUND ? stagedForkOwned(runGit) : []
  const verdict = decide({
    subject,
    lineage,
    why,
    forkOwnedStaged,
    branch: currentBranch(runGit)
  })
  if (verdict.warning) {
    console.error(`commit-msg: ${verdict.warning}`)
  }
  if (!verdict.ok) {
    console.error('')
    for (const line of verdict.lines) {
      console.error(`commit-msg: ${line}`)
    }
    console.error('')
    return 1
  }
  return 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  // Why a catch that allows: a crash in the guard must not be the reason nobody can commit, and a
  // warning printed on every commit is what gets the crash fixed.
  try {
    process.exit(main())
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    console.error(`commit-msg: the fork-only guard failed (${reason}); the commit is allowed`)
    process.exit(0)
  }
}
