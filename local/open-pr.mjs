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
// the property that rules that out, and it fails loudly instead of showing up in review. The base
// is resolved against the remote the PR targets — `upstream` for an upstream PR, `origin`
// otherwise — because the two remotes track different branches.
//
// Why both PR gates are read here: AGENTS.md makes the PR's own verification and one Opus review
// conditions of opening a PR, and a rule that nothing reads is advisory. This refuses a body with no
// review claim, and a head with no cached unit-gate PASS *when the change is global enough that a
// targeted run proves nothing* — the full suite itself moved to the release gate, so requiring it per
// branch is what made agents run it five times a session. `--waive-gate <n>:<reason>` records a
// deliberate exception and writes it into the PR body, because a waiver a reader cannot find is not
// recorded.
//
//   body=$(mktemp "${TMPDIR:-/tmp}/orca-pr-body.XXXXXX")
//   node local/open-pr.mjs --title "fix(git): ..." --body-file "$body"
//   node local/open-pr.mjs --title "..." --body-file "$body" --dry-run
//   node local/open-pr.mjs --title "..." --body-file "$body" --upstream
//   node local/open-pr.mjs --title "..." --body-file "$body" --waive-gate 1:"<why>"
//
// Upstream PRs are cut from `main`, this fork's PRs from `nplez1/main`; `--base <branch>`
// overrides either.

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'
import {
  GATE_INPUT_PATHS,
  allowlistFingerprint,
  formatVerdict,
  gateInputsFingerprint,
  readCachedVerdict,
  resolvedGateCacheDir,
  toolchainVersions
} from './gate-verdict-cache.mjs'

const FORK = 'nplez1/orca'
const UPSTREAM = 'stablyai/orca'
const FORK_BASE = 'nplez1/main'
const UPSTREAM_BASE = 'main'

// Why a remote per target: `origin` tracks only `refs/heads/nplez1/*`, so validating an upstream
// base against it reports "not a descendant" for what is really a wrong-remote lookup.
export const TARGETS = {
  fork: { repository: FORK, base: FORK_BASE, remote: 'origin' },
  upstream: { repository: UPSTREAM, base: UPSTREAM_BASE, remote: 'upstream' }
}

export const REVIEW_CLAIM_EXAMPLE =
  'Reviewed by Opus 5.5, high: R1 (2 blocking fixed), delta clean on R2'

/**
 * Gate 2's reviewer, as AGENTS.md names it: an Opus model at high reasoning. Why the token check:
 * without it the gate accepts a review by anyone, which is not the claim the gate exists to verify.
 */
export const REVIEWER_CLAIM = /^(?:claude\/)?opus\b(?:\s+\d+(?:\.\d+)*)?(?=\s|,|$)[\s\S]*\bhigh\b/i

/** Wording that names a finding without claiming it was closed. */
export const OPEN_VERDICT_WORDS =
  /\b(?:not\s+yet|not\s+(?:clean|fixed|addressed|resolved)|will\s+be|to\s+be\s+(?:fixed|addressed|resolved)|later|todo|tbd|unresolved|outstanding|pending|unfixed|still\s+open)\b/i

/** One `R<n>` (or `round <n>`) naming the round a verdict belongs to. */
const ROUND_REF = /\bR\d+\b|\bround\s*\d+\b/gi

/**
 * A closed verdict, in the two shapes AGENTS.md allows: the round came back clean, or a counted set
 * of blocking findings was fixed. Why counted: "found 2 BLOCKERs" is a finding, not a resolution.
 */
const CLOSED_VERDICT =
  /\bclean\b|\b(?:\d+|no)\s+(?:blocking|blockers?)\b[^;]*?\b(?:fixed|resolved|addressed)\b/gi

function run(command, args) {
  return execFileSync(command, args, { encoding: 'utf8' }).trim()
}

// Why untrimmed: a fingerprint is over bytes, and `git show` output ends with the newline the file
// has. Trimming here made `open-pr` hash a different allowlist than `gate-unit` does, so every fork
// PR looked like it had no verdict.
function runRaw(command, args) {
  return execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
}

function git(args) {
  return run('git', args)
}

function tryGit(args) {
  try {
    return git(args)
  } catch {
    return null
  }
}

export function parseArgs(argv) {
  const options = { upstream: false, dryRun: false, base: null, branch: null, waiveGates: [] }
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
    } else if (flag === '--waive-gate') {
      options.waiveGates.push(value ?? '')
      index += 1
    } else if (flag === '--help' || flag === '-h') {
      options.help = true
    } else {
      throw new Error(`Unknown argument: ${flag}`)
    }
  }
  return options
}

export function usage() {
  return `Usage: node local/open-pr.mjs --title <title> --body-file <path> [options]

  --upstream          target ${UPSTREAM} instead of this fork (explicit by design)
  --base <branch>     base branch (defaults: ${FORK_BASE}, or ${UPSTREAM_BASE} with --upstream)
  --branch <branch>   head branch (defaults to the checked-out branch)
  --waive-gate <n>:<reason>
                      open the PR without gate <n> (1 = unit gate, 2 = review), and write
                      \`Gate <n> waived: <reason>\` into the PR body
  --dry-run           print the gh command instead of running it, and report a gate refusal
                      instead of aborting on it

Gate 1 needs a cached PASS from \`orca-queue node local/gate-unit.mjs\` only when the change is
global: a build, workspace, config or \`src/packages\` / \`src/shared\` input, or any path outside
the source, test, doc, fork-tooling, workflow and agent trees. An ordinary \`src/\` change is verified
by its targeted tests instead. Gate 1 is fork-local either way, so an upstream PR always needs \`--waive-gate 1:\`
with the reason. Gate 2 needs a
line in the body shaped like:
  ${REVIEW_CLAIM_EXAMPLE}
Where that line names a round, the round needs a closed verdict of its own — \`clean\`, or a count of
blocking findings that were fixed — and the reviewer has to be the Opus reviewer AGENTS.md names.
`
}

export function fail(message) {
  console.error(`open-pr: ${message}`)
  process.exit(1)
}

/** `--waive-gate 1:<reason>` — the reason is required, because the point is to record one. */
export function parseGateWaivers(entries = []) {
  const waivers = new Map()
  for (const entry of entries) {
    const match = /^\s*([12])\s*:\s*(\S.*)$/.exec(entry)
    if (!match) {
      throw new Error(`--waive-gate expects <1|2>:<reason>, got "${entry}"`)
    }
    waivers.set(Number(match[1]), match[2].trim())
  }
  return waivers
}

/** Markdown emphasis, headings and bullets are noise around the claim, not a different claim. */
function normaliseBodyLine(line) {
  return String(line)
    .replace(/^[\s>*_#-]+/, '')
    .replace(/[*_]/g, '')
    .trim()
}

export function reviewClaim(body) {
  let fenced = false
  for (const raw of String(body ?? '').split('\n')) {
    if (raw.trimStart().startsWith('```')) {
      fenced = !fenced
      continue
    }
    if (fenced) {
      continue
    }
    const line = normaliseBodyLine(raw)
    const match = /^reviewed by\s+(.+)$/i.exec(line)
    if (!match) {
      continue
    }
    const claim = match[1].trim()
    const colon = claim.indexOf(':')
    const reviewer = (colon === -1 ? claim : claim.slice(0, colon)).trim()
    const roundsText = colon === -1 ? '' : claim.slice(colon + 1).trim()
    // Why the reviewer first: a claim nobody AGENTS.md names is not a review, whatever verdicts it
    // lists, and checking this last let `Reviewed by nobody: R1 clean` through the whole gate.
    if (!REVIEWER_CLAIM.test(reviewer)) {
      return {
        ok: false,
        reason: `the review line names "${reviewer}" as the reviewer, and AGENTS.md § PR gate 2 requires an Opus reviewer at high reasoning (\`Opus 5.5, high\` or \`claude/opus, high\`)`
      }
    }
    // Why the whole claim: "not yet fixed" does not contain "not fixed", and that one gap accepted
    // `R1 (3 blocking, not yet fixed)`.
    if (OPEN_VERDICT_WORDS.test(roundsText)) {
      return {
        ok: false,
        reason: `the review line records an open finding: "${claim}"`
      }
    }
    const rounds = [...roundsText.matchAll(ROUND_REF)].length
    if (rounds === 0) {
      return {
        ok: false,
        reason: `the review line names no review round (R1, round 1): "${claim}"`
      }
    }
    const closed = [...roundsText.matchAll(CLOSED_VERDICT)].length
    if (closed === 0) {
      return {
        ok: false,
        reason: `the review line states no closed verdict (R1 clean, or R1 N blocking fixed): "${claim}"`
      }
    }
    // Why a count per round rather than one verdict anywhere: `R1 found 2 BLOCKERs; nits fixed` has a
    // verdict word in it and closes nothing, and a round nobody reported on is not a reviewed round.
    if (closed < rounds) {
      return {
        ok: false,
        reason: `the review line names ${rounds} review round(s) but only ${closed} closed verdict(s); every round needs its own: "${claim}"`
      }
    }
    return { ok: true, line: `Reviewed by ${reviewer}: ${roundsText}` }
  }
  return { ok: false, reason: 'the body has no "Reviewed by" line' }
}

/**
 * The waiver, written into the body it belongs to: the script used to print it to a terminal nobody
 * reads later, so the one place a reader would look was the one place it was guaranteed absent.
 */
export function waiverDisclosure(body, waivers = new Map()) {
  const text = String(body ?? '')
  const present = new Set(text.split('\n').map((line) => line.trim()))
  const lines = []
  for (const [gate, reason] of waivers) {
    const line = `Gate ${gate} waived: ${reason}`
    if (!present.has(line)) {
      lines.push(line)
    }
  }
  if (lines.length === 0) {
    return { body: text, lines }
  }
  const trimmed = text.replace(/\s*$/, '')
  return { body: trimmed ? `${trimmed}\n\n${lines.join('\n')}\n` : `${lines.join('\n')}\n`, lines }
}

/** Why a subject prefix and not a path: `.husky/commit-msg` enforces the same invariant locally. */
export function forkOnlySubjects(subjects) {
  return subjects.filter((subject) => subject.startsWith('local('))
}

export function commitSubjects(range, gitRun = git) {
  return gitRun(['log', '--format=%s', range])
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
}

export function localCommitsIn(range, gitRun = git) {
  return forkOnlySubjects(commitSubjects(range, gitRun))
}

export function allowlistAtHead(head, gitRaw = runRaw) {
  try {
    return gitRaw('git', ['show', `${head}:local/unit-known-red.json`])
  } catch {
    return null
  }
}

/**
 * The gate inputs as they are at `head`: the scripts and the bun pin from the commit, the toolchains
 * from this machine. Why from the commit and not the working tree: a verdict is about a revision, and
 * `gate-unit` fingerprints the tree only because it refuses to run on a dirty one.
 */
export function gateInputsAtHead(head, gitRaw = runRaw) {
  const files = {}
  for (const path of GATE_INPUT_PATHS) {
    try {
      files[path] = gitRaw('git', ['show', `${head}:${path}`])
    } catch {
      files[path] = ''
    }
  }
  return gateInputsFingerprint({ files, toolchain: toolchainVersions() })
}

export function unitGateVerdict(
  head,
  {
    commonDir,
    gitDir,
    // Why from the commit and not the working tree: an uncommitted allowlist would fingerprint a red
    // set that is not part of the revision being shipped.
    allowlistText = allowlistAtHead(head),
    gateInputs
  } = {}
) {
  if (allowlistText === null) {
    return {
      ok: false,
      reason: `cannot read local/unit-known-red.json at ${head.slice(0, 10)}, so no verdict can be checked`
    }
  }
  const fingerprint = allowlistFingerprint(allowlistText)
  // Why the inference is skipped when either was supplied: a caller that names a git dir is answering
  // the question, and inventing a common dir over it would read a cache that caller did not choose.
  if (commonDir === undefined && gitDir === undefined) {
    commonDir = tryGit(['rev-parse', '--path-format=absolute', '--git-common-dir'])
    gitDir = tryGit(['rev-parse', '--absolute-git-dir'])
  }
  if (!commonDir && !gitDir) {
    return { ok: false, reason: 'cannot resolve the git dir, so no cached verdict can be found' }
  }
  const cacheDir = resolvedGateCacheDir({ commonDir, gitDir, root: process.cwd() })
  const verdict = readCachedVerdict(cacheDir, head, fingerprint)
  if (!verdict || verdict.revision !== head) {
    return {
      ok: false,
      reason:
        `gate 1 has no cached unit-gate verdict for ${head.slice(0, 10)}.\n` +
        `Run it once, from the worktree being shipped: orca-queue node local/gate-unit.mjs\n` +
        `The verdict is cached per (revision, allowlist), so a PASS for another revision does not count.`
    }
  }
  if (verdict.clean !== true) {
    return {
      ok: false,
      reason:
        `gate 1's cached verdict for ${head.slice(0, 10)} was produced on a dirty tree, so it is not ` +
        `a verdict on this revision. Re-run the gate on a committed tree.`
    }
  }
  // Why: the same revision on a different bun or node is a different run of the machine-bound test
  // classes, so the cached PASS is about a runtime this machine no longer has.
  const inputs = gateInputs ?? gateInputsAtHead(head)
  if (verdict.gateInputs !== inputs) {
    return {
      ok: false,
      reason:
        `gate 1's cached verdict for ${head.slice(0, 10)} was produced with different gate inputs ` +
        `(the gate scripts, config/.bun-version, or the installed node and bun), so it is not a ` +
        `verdict on this revision. Re-run it: orca-queue node local/gate-unit.mjs`
    }
  }
  if (verdict.exitCode !== 0) {
    return {
      ok: false,
      reason:
        `gate 1 FAILED on ${head.slice(0, 10)}: ${verdict.counts?.failed ?? '?'} failing case(s), ` +
        `${verdict.unexpected?.length ?? '?'} of them unexpected.\n` +
        `Fix them, or record the red set in local/unit-known-red.json with its evidence line.`
    }
  }
  return { ok: true, verdict }
}

export function requireUnitGate(head, options) {
  const result = unitGateVerdict(head, options)
  if (!result.ok) {
    fail(result.reason)
  }
  return result.verdict
}

/**
 * The decision both gates make, separated from printing and exiting so it can be tested: `problems`
 * is what the PR boundary refuses on, `passes` is what it reports, `waived` is what a person chose.
 */
export function evaluateGates({
  upstream,
  waivers = new Map(),
  head,
  body,
  gateOne = {},
  changedPaths = null
} = {}) {
  const problems = []
  const passes = []
  if (!waivers.has(1)) {
    if (upstream) {
      problems.push(
        `gate 1 is fork-local, so an upstream PR has no verdict for it. Record that explicitly:\n` +
          `  --waive-gate 1:"upstream PR, gated by upstream CI"`
      )
    } else {
      const scope = needsFullUnitGate(changedPaths)
      if (!scope.required) {
        passes.push(`gate 1 not required — ${scope.why}`)
      } else {
        const result = unitGateVerdict(head, gateOne)
        if (result.ok) {
          passes.push(`gate 1 PASS — ${formatVerdict(result.verdict)}`)
        } else {
          problems.push(`${result.reason}\n(${scope.why})`)
        }
      }
    }
  }
  if (!waivers.has(2)) {
    const claim = reviewClaim(body)
    if (claim.ok) {
      passes.push(`gate 2 PASS — ${claim.line}`)
    } else {
      problems.push(
        `gate 2 needs a review claim in the PR body: ${claim.reason}.\n` +
          `Expected a line shaped like:\n  ${REVIEW_CLAIM_EXAMPLE}`
      )
    }
  }
  return { problems, passes, waived: [...waivers.entries()] }
}

export const FORK_OWNED_PATHS = [
  'local/',
  'LOCAL-PATCHES.md',
  'BRANCHES.md',
  'UPSTREAM-SYNC-RUNBOOK.md',
  '.husky/commit-msg'
]

/** Where the fork's own line lives, most authoritative first. */
export const FORK_LINE_REFS = [
  'refs/remotes/origin/nplez1/main',
  'refs/heads/nplez1/main',
  'nplez1/main'
]

/**
 * The fork-owned set, derived instead of listed: every file the fork's own line adds relative to the
 * merge base it shares with the upstream base.
 *
 * Why derived: the hand list could not keep up — `.agents/skills/**`, `.github/workflows/fork-*.yml`,
 * `.github/scripts/fork-release-notes.mjs` and `local/orca-vm/` were all fork-added and all absent
 * from it, so a normally-worded commit carrying one reached an upstream-bound PR.
 *
 * Why from the fork line and not from the branch: a legitimate upstream PR adds new source files, and
 * deriving from the branch would refuse every one of them. What this set answers is "is this path a
 * file the fork introduced", which `FORK_OWNED_PATHS` answers only for the paths someone remembered.
 *
 * Returns `null` when no fork line is reachable, in which case only the literal list applies.
 */
export function derivedForkOwnedPaths(upstreamBase, gitRun = git, refs = FORK_LINE_REFS) {
  const attempt = (args) => {
    try {
      return gitRun(args)
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
      `${upstreamBase}...${ref}`
    ])
    return added === null
      ? null
      : added
          .split('\n')
          .map((line) => line.trim())
          .filter(Boolean)
  }
  return null
}

/**
 * The changed paths in `range` that are fork-owned, by the literal list and by the derived set.
 * Both, because they answer different questions: the list catches a fork file the branch *modified*
 * (`.husky/commit-msg` exists upstream), the derived set catches a fork tree nobody listed.
 */
export function forkOwnedPathsInRange(range, upstreamBase, gitRun = git) {
  const changed = changedPathsIn(range, gitRun)
  const listed = forkOnlyPathsIn(range, gitRun)
  const derived = derivedForkOwnedPaths(upstreamBase, gitRun)
  const derivedInDiff = derived === null ? [] : changed.filter((path) => derived.includes(path))
  return [...new Set([...listed, ...derivedInDiff])]
}

/**
 * The changed paths a PR will show. Exported and injectable for the same reason `forkOnlyPathsIn` is:
 * the `--no-renames` flag is the fix for a real hole, and a hole that is only described in a comment
 * comes back the next time someone tidies the call.
 */
export function changedPathsIn(range, gitRun = git) {
  return gitRun(['diff', '--name-only', '--no-renames', range])
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
}

/**
 * Paths whose change makes a targeted test run prove nothing: the build, the workspace definition,
 * config every project reads, and the two `src` trees every process imports. Why a fixed list and
 * not `selectUnitFiles`: that needs the reverse-import graph (globs plus the TypeScript API), which
 * costs minutes in a PR opener and would answer "run all 13,064 files" for nearly every input.
 * Measured on the last 40 commits, `src/shared` or `src/packages` changes in 15 of them, so this
 * keeps the full gate on the ~37% of changes with real blast radius and drops it from the rest.
 */
export const GLOBAL_CHANGE_PATHS = [
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'config/',
  'src/packages/',
  'src/shared/'
]

/** Paths that cannot change unit-suite behaviour on their own, so they need no suite run. */
const TARGETED_PATHS = [
  /^src\//,
  /^tests\//,
  /^docs\//,
  /^local\//,
  /^\.github\//,
  /^\.agents\//,
  /\.md$/
]

function isGlobalChange(path) {
  if (GLOBAL_CHANGE_PATHS.some((global) => path === global || path.startsWith(global))) {
    return true
  }
  // Why tsconfig separately: every project reads it, and a file name is not a directory prefix.
  if (/^tsconfig[^/]*\.json$/.test(path)) {
    return true
  }
  return !TARGETED_PATHS.some((pattern) => pattern.test(path))
}

/**
 * Whether this diff needs the full suite before a PR, or whether targeted tests are the verification.
 * Fails closed: no changed-path evidence means the full gate, because a silent skip is the failure
 * mode this boundary exists to prevent.
 */
export function needsFullUnitGate(changedPaths) {
  if (!Array.isArray(changedPaths)) {
    return { required: true, why: 'no changed-path evidence, so the change is unproven' }
  }
  // Why filter before deciding: an unreadable diff and a diff that is genuinely empty must not both
  // read as "nothing global changed", and only the second should ever be a statement about the code.
  const paths = changedPaths.filter((path) => typeof path === 'string' && path.length > 0)
  if (paths.length === 0) {
    return { required: true, why: 'no changed-path evidence, so the change is unproven' }
  }
  const global = paths.filter(isGlobalChange)
  if (global.length > 0) {
    const more = global.length > 1 ? ` (+${global.length - 1} more)` : ''
    return { required: true, why: `${global[0]}${more} is a global input` }
  }
  return { required: false, why: 'every changed path is covered by targeted tests' }
}

/**
 * Why a path check on top of the subject check: the subject prefix is a convention, and a squash or
 * a differently-worded commit carries the same files upstream without one.
 */
export function forkOnlyPathsIn(range, gitRun = git) {
  // Why `:(top)`: pathspecs are relative to the current directory, so a run from a subdirectory would
  // look under `<subdir>/local/` and find nothing.
  return gitRun(['diff', '--name-only', range, '--', ...FORK_OWNED_PATHS.map((p) => `:(top)${p}`)])
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
}

function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    console.log(usage())
    return
  }

  const waivers = (() => {
    try {
      return parseGateWaivers(options.waiveGates)
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error))
    }
  })()

  const target = options.upstream ? TARGETS.upstream : TARGETS.fork
  const base = options.base ?? target.base
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

  git(['fetch', '--quiet', target.remote, base])
  const baseRef = `${target.remote}/${base}`
  // Why a separate resolution: without it a base the remote does not track fails at the ancestry
  // check, which reports "not a descendant" for what is really an unknown base.
  const baseCommit = tryGit(['rev-parse', '--verify', '--quiet', `${baseRef}^{commit}`])
  if (!baseCommit) {
    fail(
      `'${baseRef}' does not resolve after fetching '${base}' from '${target.remote}'.\n` +
        `The base has to be a branch that remote tracks — pass the base this branch was cut from, ` +
        `or fetch it and set up a tracking ref first.`
    )
  }
  const localHead = git(['rev-parse', 'HEAD'])
  const branchHead = git(['rev-parse', '--verify', `refs/heads/${branch}`])

  // Why not a no-op when the branch is checked out: the check must hold for whatever is pushed.
  if (tryGit(['merge-base', '--is-ancestor', baseCommit, branchHead]) === null) {
    const shared = tryGit(['merge-base', baseCommit, branchHead]) !== null
    const history = shared
      ? ''
      : `The two share no history at all, so '${baseRef}' is probably not the branch this was cut from.\n`
    fail(
      `'${branch}' is not a descendant of '${baseRef}'.\n${history}` +
        `A branch cut from the wrong base lands as a PR full of the base's own commits as reversions. ` +
        `Rebase onto ${baseRef} first, or pass the base this branch was cut from.`
    )
  }

  if (options.upstream) {
    const offenders = localCommitsIn(`${baseCommit}..${branchHead}`)
    if (offenders.length > 0) {
      const listed = offenders.map((subject) => `  ${subject}`).join('\n')
      fail(
        `'${branch}' carries ${offenders.length} fork-only commit(s) into an upstream PR:\n${listed}\n` +
          `A local(...) commit is this fork's patch series and must never reach ${UPSTREAM}. ` +
          `Rebase the branch onto ${baseRef} without them, or open the PR against the fork.`
      )
    }
    const paths = forkOwnedPathsInRange(`${baseCommit}...${branchHead}`, baseCommit)
    if (paths.length > 0) {
      const listed = paths
        .slice(0, 8)
        .map((path) => `  ${path}`)
        .join('\n')
      const more = paths.length > 8 ? `\n  …and ${paths.length - 8} more` : ''
      fail(
        `'${branch}' carries ${paths.length} fork-owned file(s) into an upstream PR:\n${listed}${more}\n` +
          `These paths exist only in this fork and no upstream review can act on them. Rebase them ` +
          `out, or open the PR against the fork.`
      )
    }
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

  // Why before the gates: the waiver line is part of the body that gets published, so gate 2 has to
  // read the text the reader will see. Writing it later left the waiver in a terminal scrollback.
  const disclosure = waiverDisclosure(readFileSync(options.bodyFile, 'utf8'), waivers)
  const gateResult = evaluateGates({
    upstream: options.upstream,
    waivers,
    head: branchHead,
    body: disclosure.body,
    // Why three dots: the merge-base diff is what the PR will show, so a branch that has already
    // pulled the base in must not look global because of the base's own files.
    changedPaths: changedPathsIn(`${baseCommit}...${branchHead}`)
  })
  for (const line of gateResult.passes) {
    console.log(`open-pr: ${line}`)
  }
  for (const [gate, reason] of gateResult.waived) {
    console.log(`open-pr: WAIVED gate ${gate} — ${reason}`)
  }
  for (const line of disclosure.lines) {
    console.log(
      `open-pr: ${options.dryRun ? 'would append to' : 'appended to'} the PR body: ${line}`
    )
  }
  if (gateResult.problems.length > 0 && !options.dryRun) {
    fail(gateResult.problems.join('\n\n'))
  }
  if (gateResult.problems.length > 0) {
    console.log(
      `open-pr: --dry-run: this would be refused —\n\n${gateResult.problems.join('\n\n')}\n`
    )
  }

  const head = options.upstream ? `nplez1:${branch}` : branch
  const args = [
    'pr',
    'create',
    '--repo',
    target.repository,
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

  if (disclosure.lines.length > 0) {
    // Why the file and not a `--body` argument: the caller may re-read it, and the record of the
    // waiver should live where every other PR's body lives.
    writeFileSync(options.bodyFile, disclosure.body)
  }

  console.log(
    `open-pr: ${target.repository} <- ${branch} (base ${base}, head ${localHead.slice(0, 9)})`
  )
  console.log(run('gh', args))
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    main()
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error))
  }
}
