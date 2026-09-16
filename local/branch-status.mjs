#!/usr/bin/env node
// Live status of this fork's branches: where each one sits locally, whether the fork has it,
// what it actually changes, and whether a PR exists for it.
//
// Why a script rather than a hand-kept table: the branch set changes constantly, and a table
// that drifts is worse than none. BRANCHES.md records intent and dependencies; this reports
// what is true right now. Run it after any push or upstream sync, and update BRANCHES.md if
// the two disagree.
//
//   node local/branch-status.mjs

import { execFileSync } from 'node:child_process'

const FORK = 'nplez1/orca'
const UPSTREAM = 'stablyai/orca'

// Why explicit parents: most branches are cut straight from origin/main, but a few exist only
// on top of another branch. Measuring those against main would report the parent's files as
// their own and hide the dependency that decides merge order.
const PARENTS = {
  'feat/terminal-session-reconnect': 'feat/worktree-scan-cache-persistence',
  'feat/startup-worktree-hydration': 'fix/terminal-session-reconnect'
}

const BRANCHES = [
  'nplez1/main',
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

function forkSha(branch) {
  try {
    const out = execFileSync(
      'gh',
      [
        'api',
        `repos/${FORK}/git/matching-refs/heads/${branch}`,
        '--jq',
        '.[].ref + " " + .[].object.sha'
      ],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
    ).trim()
    const line = out.split('\n').find((l) => l.startsWith(`refs/heads/${branch} `))
    return line ? line.split(' ')[1].slice(0, 10) : null
  } catch {
    return null
  }
}

// Why the bare branch and not `nplez1:<branch>`: gh matches the head label, and the
// owner-qualified form returns nothing even for a PR whose head is that fork.
function pullRequest(branch) {
  try {
    const out = execFileSync(
      'gh',
      [
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
        'number,state',
        '--jq',
        '.[0] // empty | "#\\(.number) \\(.state)"'
      ],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
    ).trim()
    return out || null
  } catch {
    return null
  }
}

console.log(
  'branch'.padEnd(40),
  'local'.padEnd(11),
  'fork'.padEnd(11),
  'own delta'.padEnd(22),
  'PR'
)
console.log('-'.repeat(96))

let missingFromFork = 0
for (const branch of BRANCHES) {
  const local = git(['rev-parse', '--short', branch])
  if (!local) {
    console.log(branch.padEnd(40), 'MISSING locally')
    continue
  }
  const parent = PARENTS[branch] ?? 'origin/main'
  const files = git(['diff', '--name-only', `${parent}...${branch}`])
  const count = files ? files.split('\n').filter(Boolean).length : 0
  const stat = git(['diff', '--shortstat', `${parent}...${branch}`])
  const delta = `${count} file(s) ${stat ? stat.replace(/^\s*\d+ files? changed,?\s*/, '').trim() : ''}`
  const remote = forkSha(branch)
  if (!remote) {
    missingFromFork += 1
  }
  console.log(
    branch.padEnd(40),
    local.padEnd(11),
    (remote ?? 'NOT ON FORK').padEnd(11),
    delta.slice(0, 21).padEnd(22),
    pullRequest(branch) ?? '-'
  )
}

console.log()
console.log(
  `parents: ${
    Object.entries(PARENTS)
      .map(([b, p]) => `${b} → ${p}`)
      .join('; ') || 'all cut from origin/main'
  }`
)
if (missingFromFork > 0) {
  console.log(`⚠ ${missingFromFork} branch(es) are not on the fork yet`)
}
