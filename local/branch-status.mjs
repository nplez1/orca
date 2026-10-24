#!/usr/bin/env node
// Live status of this fork's branches: where each one sits locally, whether the fork has it,
// what it actually changes, and whether a PR exists for it.
//
// Why a script rather than a hand-kept table: the branch set changes constantly, and a table
// that drifts is worse than none. The inventory is derived from the refs, so a fork branch that
// exists is reported and a name that no longer exists cannot linger. BRANCHES.md records intent
// and dependencies; this reports what is true right now.
//
//   node local/branch-status.mjs               # local refs, the fork's refs, and PR state
//   node local/branch-status.mjs --local-only  # offline: no network at all
//
// Exit: 0 for a report, 2 for a usage or environment problem.

import { execFile, execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import process from 'node:process'
import { promisify } from 'node:util'
import { pathToFileURL } from 'node:url'

const FORK = 'nplez1/orca'
const UPSTREAM = 'stablyai/orca'
// Why not `origin/main`: origin's fetch refspec maps only `refs/heads/nplez1/*`, so no
// `origin/main` ref exists locally and every own delta measured against it printed `0 file(s)`.
export const FORK_BASE = 'nplez1/main'
// Where a branch that is not part of this fork's line is measured from.
export const UPSTREAM_BASE = 'upstream/main'
const FORK_NAMESPACE = 'nplez1/'
const REF_NAMESPACES = ['refs/heads/nplez1', 'refs/remotes/origin/nplez1']

// Why explicit parents: most fork branches are cut straight from FORK_BASE, but a few exist only
// on top of another branch, and measuring those against the base would report the parent's files
// as their own. Keys are branch names as they actually are — a key that matches no branch is
// reported instead of being silently ignored.
export const PARENTS = {
  'fix/terminal-session-reconnect': 'feat/worktree-scan-cache-persistence',
  'feat/startup-worktree-hydration': 'fix/terminal-session-reconnect'
}

// Why still a list: these are upstream-bound, so they are the one part of the inventory that
// `refs/heads/nplez1` cannot describe. They are cut from `origin/main` and opened against
// `stablyai/orca` (see BRANCHES.md § Dependency graph); a name here that is in no ref is reported.
export const UPSTREAM_BOUND = [
  'fix/cli-symlink-world-readable',
  'fix/copilot-background-work',
  'fix/repo-catalog-connection-fence',
  'fix/claude-codex-enterprise-accounts',
  'feat/copilot-usage',
  'feat/deepseek-usage',
  'feat/fireworks-usage',
  'feat/worktree-scan-cache-persistence',
  'fix/terminal-session-reconnect',
  'feat/startup-worktree-hydration',
  'feat/startup-service-ordering',
  'fix/agent-status-routing-readiness'
]

const DEFAULT_WIDTHS = [40, 12, 12, 28]
const MAX_BRANCH_WIDTH = 56
const execFileAsync = promisify(execFile)

export function usage() {
  return `usage: node local/branch-status.mjs [--local-only]

  --local-only   skip every network call and report refs and deltas only
`
}

export function parseArgs(argv) {
  const options = { localOnly: false, help: false }
  for (const arg of argv) {
    if (arg === '--local-only') {
      options.localOnly = true
    } else if (arg === '--help' || arg === '-h') {
      options.help = true
    } else {
      throw new Error(`unknown argument: ${arg}\n${usage()}`)
    }
  }
  return options
}

/** `for-each-ref` output for the fork's two namespaces, one fully-qualified ref per line. */
export function parseRefs(text) {
  const local = new Set()
  const remote = new Set()
  for (const line of String(text ?? '').split('\n')) {
    const ref = line.trim()
    if (ref.startsWith('refs/heads/')) {
      local.add(ref.slice('refs/heads/'.length))
    } else if (ref.startsWith('refs/remotes/origin/')) {
      remote.add(ref.slice('refs/remotes/origin/'.length))
    }
  }
  return { local: [...local], remote: [...remote] }
}

/** `git ls-remote --heads` output: `<sha> <fully-qualified ref>` per line. */
export function parseRemoteHeads(text) {
  const shas = new Map()
  for (const line of String(text ?? '').split('\n')) {
    const [sha, ref] = line.trim().split(/\s+/)
    if (!ref?.startsWith('refs/heads/') || !sha) {
      continue
    }
    shas.set(ref.slice('refs/heads/'.length), sha)
  }
  return shas
}

/**
 * The inventory: every fork-namespace ref the fork or this checkout knows about, plus the named
 * upstream-bound branches. Why the fork's own heads and not only the local refs: a branch pushed
 * from another worktree is on the fork and not here, and leaving it out is the drift this replaces.
 */
export function branchNames({ local, remote }, upstreamBound = UPSTREAM_BOUND, forkHeads = []) {
  const names = new Set([...local, ...remote, ...forkHeads])
  for (const branch of upstreamBound) {
    names.add(branch)
  }
  return [...names]
    .filter((name) => name.startsWith(FORK_NAMESPACE) || upstreamBound.includes(name))
    .sort((left, right) => {
      if (left === FORK_BASE) {
        return -1
      }
      if (right === FORK_BASE) {
        return 1
      }
      return left.localeCompare(right)
    })
}

export function parentFor(branch, parents = PARENTS) {
  if (parents[branch]) {
    return parents[branch]
  }
  return branch.startsWith(FORK_NAMESPACE) ? FORK_BASE : UPSTREAM_BASE
}

export function unmatchedParents(branches, parents = PARENTS) {
  return Object.keys(parents).filter((branch) => !branches.includes(branch))
}

export function unobserved(observed, branches) {
  return branches.filter((branch) => !observed.has(branch))
}

/** `gh pr list` output: `<head>\t<number>\t<state>`, scoped to one repository. */
export function parsePullRequestRows(text, repository) {
  const rows = new Map()
  for (const line of String(text ?? '').split('\n')) {
    const [head, number, state] = line.trim().split('\t')
    if (!head || !number) {
      continue
    }
    rows.set(head, [
      ...(rows.get(head) ?? []),
      { number: `#${number}`, state: String(state ?? '').toLowerCase(), repository }
    ])
  }
  return rows
}

export function mergePullRequestRows(...sources) {
  const merged = new Map()
  for (const source of sources) {
    for (const [head, rows] of source) {
      merged.set(head, [...(merged.get(head) ?? []), ...rows])
    }
  }
  return merged
}

export function formatPullRequest(rows) {
  if (!rows?.length) {
    return '-'
  }
  const label = (repository) => (repository === UPSTREAM ? 'upstream' : 'fork')
  return rows.map((row) => `${row.number} ${row.state} (${label(row.repository)})`).join(' + ')
}

export function formatDelta(count, shortstat) {
  const insertions = /(\d+) insertion/.exec(shortstat ?? '')?.[1] ?? '0'
  const deletions = /(\d+) deletion/.exec(shortstat ?? '')?.[1] ?? '0'
  return `${count} file(s) +${insertions}/−${deletions}`
}

export function columnWidths(branches) {
  const widest = Math.max(0, ...branches.map((branch) => branch.length))
  return [
    Math.min(Math.max(widest, DEFAULT_WIDTHS[0]), MAX_BRANCH_WIDTH),
    ...DEFAULT_WIDTHS.slice(1)
  ]
}

/** Why truncate: the fork carries generated branch names over 60 characters wide. */
function pad(value, width) {
  const text = String(value)
  return text.length > width ? `${text.slice(0, width - 1)}…` : text.padEnd(width)
}

export function formatRow({ branch, local, fork, delta, pr }, widths = DEFAULT_WIDTHS) {
  return [branch, local, fork, delta]
    .map((value, index) => pad(value, widths[index]))
    .concat(pr)
    .join(' ')
}

function git(args) {
  try {
    return execFileSync('git', args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim()
  } catch {
    return null
  }
}

// Why a timeout: a stalled link must degrade to the `-` column, not hang the report.
async function gh(args) {
  try {
    const { stdout } = await execFileAsync('gh', args, {
      maxBuffer: 64 * 1024 * 1024,
      timeout: 60_000
    })
    return stdout.trim()
  } catch {
    return null
  }
}

async function run(command, args, maxBuffer = 64 * 1024 * 1024) {
  try {
    const { stdout } = await execFileAsync(command, args, { maxBuffer, timeout: 120_000 })
    return stdout.trim()
  } catch {
    return null
  }
}

async function forkHeads() {
  const out = await run('git', ['ls-remote', '--heads', 'origin'])
  return out === null ? null : parseRemoteHeads(out)
}

// Why one bulk call: the fork's own PR list is small, and a per-branch query would cost a gh
// invocation each. Upstream is queried per branch instead — its PR list is far too long to page.
async function forkPullRequests() {
  const out = await gh([
    'pr',
    'list',
    '--repo',
    FORK,
    '--state',
    'all',
    '--limit',
    '500',
    '--json',
    'number,state,headRefName',
    '--jq',
    '.[] | "\\(.headRefName)\\t\\(.number)\\t\\(.state)"'
  ])
  return out === null ? null : parsePullRequestRows(out, FORK)
}

// Why the bare branch and not `nplez1:<branch>`: gh matches the head label, and the
// owner-qualified form returns nothing even for a PR whose head is that fork.
async function upstreamPullRequests(branches) {
  const rows = await Promise.all(
    branches.map(async (branch) => {
      const out = await gh([
        'pr',
        'list',
        '--repo',
        UPSTREAM,
        '--head',
        branch,
        '--state',
        'all',
        '--limit',
        '1',
        '--json',
        'number,state,headRefName',
        '--jq',
        '.[] | "\\(.headRefName)\\t\\(.number)\\t\\(.state)"'
      ])
      return out === null ? null : parsePullRequestRows(out, UPSTREAM)
    })
  )
  return rows.some((row) => row === null) ? null : mergePullRequestRows(...rows)
}

function deltaFor(branch, parent) {
  if (branch === parent) {
    return '(base)'
  }
  if (git(['rev-parse', '--verify', '--quiet', `${branch}^{commit}`]) === null) {
    return 'not local'
  }
  if (git(['rev-parse', '--verify', '--quiet', `${parent}^{commit}`]) === null) {
    return `parent ${parent} MISSING`
  }
  const files = git(['diff', '--name-only', `${parent}...${branch}`]) ?? ''
  const count = files.split('\n').filter(Boolean).length
  return formatDelta(count, git(['diff', '--shortstat', `${parent}...${branch}`]) ?? '')
}

/**
 * Why null-tolerant: `gh` fails on the most ordinary degradations (not logged in, offline, rate
 * limited). A report that dies there is worse than one column that says `-`, so a failed source is
 * reported as partial rather than thrown.
 */
export async function readPullRequests(
  branches,
  { readForkPrs = forkPullRequests, readUpstreamPrs = upstreamPullRequests } = {}
) {
  const upstreamBound = branches.filter((branch) => !branch.startsWith(FORK_NAMESPACE))
  const [forkRows, upstreamRows] = await Promise.all([
    readForkPrs(),
    readUpstreamPrs(upstreamBound)
  ])
  return {
    pullRequests: mergePullRequestRows(forkRows ?? new Map(), upstreamRows ?? new Map()),
    partial: forkRows === null || upstreamRows === null
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    console.log(usage())
    return
  }

  const refs = git(['for-each-ref', '--format=%(refname)', ...REF_NAMESPACES])
  if (refs === null) {
    console.error(`branch-status: cannot read git refs in ${process.cwd()}`)
    process.exit(2)
  }
  const parsed = parseRefs(refs)
  // Why before the inventory: a branch pushed from another worktree is on the fork and not here.
  const heads = options.localOnly ? null : await forkHeads()
  const branches = branchNames(parsed, UPSTREAM_BOUND, heads ? [...heads.keys()] : [])

  const { pullRequests, partial } = options.localOnly
    ? { pullRequests: new Map(), partial: false }
    : await readPullRequests(branches)

  const widths = columnWidths(['branch', ...branches])
  const row = (values) => console.log(formatRow(values, widths))
  row({ branch: 'branch', local: 'local', fork: 'fork', delta: 'own delta', pr: 'PR' })
  console.log('-'.repeat(widths.reduce((total, width) => total + width + 1, 8)))

  let missingFromFork = 0
  for (const branch of branches) {
    const local = git(['rev-parse', '--short', branch])
    const forkSha = heads?.get(branch)
    // Why also require the local ref: a stale `origin/nplez1/x` tracking ref would otherwise be
    // reported as a branch that "exists locally".
    if (heads !== null && !forkSha && local) {
      missingFromFork += 1
    }
    row({
      branch,
      local: local ?? 'MISSING',
      fork: options.localOnly || heads === null ? '-' : (forkSha?.slice(0, 10) ?? 'NOT ON FORK'),
      delta: deltaFor(branch, parentFor(branch)),
      pr: options.localOnly ? '-' : formatPullRequest(pullRequests.get(branch))
    })
  }

  console.log()
  console.log(
    `parents: ${
      Object.entries(PARENTS)
        .map(([branch, parent]) => `${branch} → ${parent}`)
        .join('; ') || `nothing but ${FORK_BASE}`
    }`
  )
  // Why only with the fork's refs in hand: offline, "in no ref" would be a claim about what this
  // checkout happens to have fetched, which is the false alarm this replaced.
  const observed = new Set([...parsed.local, ...parsed.remote, ...(heads?.keys() ?? [])])
  if (heads !== null) {
    const orphans = unmatchedParents([...observed])
    if (orphans.length > 0) {
      console.log(
        `⚠ PARENTS key(s) match no branch in any ref, so that dependency is ignored: ${orphans.join(', ')}`
      )
    }
    const unlisted = unobserved(observed, UPSTREAM_BOUND)
    if (unlisted.length > 0) {
      console.log(
        `⚠ upstream-bound branch(es) in no ref this report could read: ${unlisted.join(', ')}`
      )
    }
  }
  if (missingFromFork > 0) {
    console.log(`⚠ ${missingFromFork} branch(es) exist locally but not on the fork`)
  }
  if (!options.localOnly && heads === null) {
    console.log(
      '⚠ could not read the fork’s refs (git ls-remote origin failed); fork column is "-"'
    )
  }
  if (partial) {
    console.log(
      '⚠ PR state is incomplete: one repository could not be queried, so its PRs show as "-"'
    )
  }
  if (options.localOnly) {
    console.log('(local only: fork refs and PR state were not read)')
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    await main()
  } catch (error) {
    console.error(`branch-status: ${error instanceof Error ? error.message : String(error)}`)
    process.exit(2)
  }
}
