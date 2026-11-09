// The paths and refs that belong to this fork's own line, and the diffs that find them.
//
// Why its own module: two guards need the same answer, `local/open-pr.mjs --upstream` at PR time and
// `.husky/commit-msg` at commit time, and a set maintained in two places drifts. Why not import
// `open-pr.mjs` instead: it pulls the unit-selection and gate-cache graphs onto every commit.
import { execFileSync } from 'node:child_process'

export const FORK_OWNED_PATHS = [
  'local/',
  '.agents/skills/',
  '.github/workflows/fork-*.yml',
  '.github/scripts/fork-release-notes.mjs',
  '.github/scripts/fork-release-ref-guard.sh',
  'LOCAL-PATCHES.md',
  'BRANCHES.md',
  'UPSTREAM-SYNC-RUNBOOK.md',
  '.husky/commit-msg'
]

/** Where the fork's own line lives, most authoritative first. */
export const FORK_LINE_REFS = ['refs/remotes/origin/nplez1/main', 'refs/heads/nplez1/main']

/**
 * Every ref that can prove a commit is upstream's, so lineage never depends on one of them being
 * fresh. They disagree in practice: `origin/main` and `upstream/main` were 2,000 commits apart here.
 * Fully qualified, because a short name loses to a tag of the same name.
 */
export const UPSTREAM_BASE_REFS = [
  'refs/remotes/upstream/main',
  'refs/remotes/origin/main',
  'refs/heads/main'
]

// Why the buffer: the default is 1 MiB, and `ls-tree` over this repository's 41k upstream files
// aborts with ENOBUFS — which the derivation reads as "no fork line", silently dropping the check.
export function gitRun(args) {
  return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).trim()
}

/**
 * The same runner with git's stderr discarded: a probe that fails is an expected answer for the
 * commit-msg guard, not an error to print on every commit.
 */
export function quietGitRun(args) {
  return execFileSync('git', args, {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'ignore']
  }).trim()
}

/**
 * The fork-owned set, derived instead of listed: the files the fork's own line adds to a top-level
 * tree the upstream base does not carry at all.
 *
 * Why top-level trees: the hand list could not keep up — `.agents/skills/**`,
 * `.github/workflows/fork-*.yml`, `.github/scripts/fork-release-notes.mjs` and `local/orca-vm/` were
 * all fork-added and all absent from it. Why not files, and not nested directories either:
 * BRANCHES.md records that upstream work is cut from code that has already landed on `nplez1/main`,
 * so every new `src/` file — including one in a directory the fork created, a provider for instance —
 * is "added since upstream/main" and would be refused. That is the one path fork work has to reach
 * upstream, so a tree upstream already owns stays reviewable; a whole tree it lacks does not.
 *
 * Returns `null` when no fork line is reachable, in which case only the literal list applies.
 *
 * Why `upstreamBase` may be a list: the top-level tree set is unioned over every upstream ref, so a
 * stale `upstream/main` cannot make a file upstream already carries look fork-added. Measured case:
 * upstream adds a file, the fork merges it, and the branch cut from a fresher `origin/main` then
 * modifies it — against a stale base that file reads as added-on-the-fork-line.
 */
export function derivedForkOwnedPaths(upstreamBase, runGit = gitRun, refs = FORK_LINE_REFS) {
  const bases = Array.isArray(upstreamBase) ? upstreamBase : [upstreamBase]
  const attempt = (args) => {
    try {
      return runGit(args)
    } catch {
      return null
    }
  }
  for (const ref of refs) {
    if (attempt(['rev-parse', '--verify', '--quiet', ref]) === null) {
      continue
    }
    const added = attempt([
      'diff',
      '--name-only',
      '--diff-filter=A',
      '--no-renames',
      `${bases[0]}...${ref}`
    ])
    const owned = new Set()
    for (const base of bases) {
      const upstreamTop = attempt(['ls-tree', '--name-only', base])
      if (upstreamTop === null) {
        return null
      }
      for (const line of upstreamTop.split('\n')) {
        if (line.trim()) {
          owned.add(line.trim())
        }
      }
    }
    if (added === null) {
      return null
    }
    return added
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .filter((path) => !owned.has(path.split('/')[0]))
  }
  return null
}

/**
 * The changed paths in `range` that are fork-owned, by the literal list and by the derived set.
 * Both, because they answer different questions: the list catches a fork file the branch *modified*
 * (a file this fork added to an upstream tree), the derived set catches a fork tree nobody listed.
 */
export function forkOwnedPathsInRange(range, upstreamBase, runGit = gitRun) {
  const changed = changedPathsIn(range, runGit)
  const listed = forkOnlyPathsIn(range, runGit)
  const derived = derivedForkOwnedPaths(upstreamBase, runGit)
  const derivedInDiff = derived === null ? [] : changed.filter((path) => derived.includes(path))
  return [...new Set([...listed, ...derivedInDiff])]
}

/**
 * The fork-owned paths staged for the commit being made. Why not a range: the index is what the
 * commit will contain, and it has no revision name of its own. Why `--diff-filter=d` on both reads:
 * removing a leaked fork file is the fix for the leak, and it must not be the commit the hook refuses.
 */
export function forkOwnedStagedPaths(upstreamBase, runGit = gitRun) {
  const staged = stagedPaths(runGit)
  const listed = forkOnlyStagedPaths(runGit)
  const derived = derivedForkOwnedPaths(upstreamBase, runGit)
  const derivedInIndex = derived === null ? [] : staged.filter((path) => derived.includes(path))
  return [...new Set([...listed, ...derivedInIndex])]
}

/**
 * The changed paths a PR will show. Exported and injectable for the same reason `forkOnlyPathsIn` is:
 * the `--no-renames` flag is the fix for a real hole, and a hole that is only described in a comment
 * comes back the next time someone tidies the call.
 */
export function changedPathsIn(range, runGit = gitRun) {
  return runGit(['diff', '--name-only', '--no-renames', range])
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
}

/**
 * Why the glob magic on a wildcard entry: a pathspec is a prefix match, so `.github/workflows/fork-`
 * would match a file literally named that, and `fork-*.yml` needs `:(glob)` to match a pattern.
 */
export function forkOwnedPathspec(path) {
  return path.includes('*') ? `:(top,glob)${path}` : `:(top)${path}`
}

/**
 * Why a path check on top of the subject check: the subject prefix is a convention, and a squash or
 * a differently-worded commit carries the same files upstream without one.
 */
export function forkOnlyPathsIn(range, runGit = gitRun) {
  // Why `:(top)`: pathspecs are relative to the current directory, so a run from a subdirectory would
  // look under `<subdir>/local/` and find nothing.
  return splitPaths(runGit(['diff', '--name-only', range, ...forkOwnedPathspecArgs()]))
}

export function forkOnlyStagedPaths(runGit = gitRun) {
  return splitPaths(
    runGit(['diff', '--cached', '--name-only', '--diff-filter=d', ...forkOwnedPathspecArgs()])
  )
}

function stagedPaths(runGit) {
  return splitPaths(runGit(['diff', '--cached', '--name-only', '--diff-filter=d', '--no-renames']))
}

function forkOwnedPathspecArgs() {
  return ['--', ...FORK_OWNED_PATHS.map(forkOwnedPathspec)]
}

function splitPaths(text) {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
}
