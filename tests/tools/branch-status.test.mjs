import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import {
  FORK_BASE,
  PARENTS,
  UPSTREAM_BASE,
  branchNames,
  columnWidths,
  formatDelta,
  formatPullRequest,
  formatRow,
  mergePullRequestRows,
  parentFor,
  parseArgs,
  parsePullRequestRows,
  parseRefs,
  parseRemoteHeads,
  readPullRequests,
  unmatchedParents,
  unobserved
} from '../../local/branch-status.mjs'

const SCRIPT = new URL('../../local/branch-status.mjs', import.meta.url).pathname
const dirs = []

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim()
}

function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'orca-branch-status-'))
  dirs.push(dir)
  git(dir, ['init', '-q', '-b', FORK_BASE])
  git(dir, ['config', 'user.email', 'test@example.com'])
  git(dir, ['config', 'user.name', 'Test'])
  writeFileSync(join(dir, 'base.txt'), 'base\n')
  git(dir, ['add', '.'])
  git(dir, ['commit', '-qm', 'base'])
  git(dir, ['update-ref', 'refs/remotes/upstream/main', 'HEAD'])
  return dir
}

it('reads the fork namespaces and ignores every other ref', () => {
  const refs = parseRefs(
    [
      'refs/heads/nplez1/Hide-hosts',
      'refs/heads/nplez1/a-brand-new-branch',
      'refs/remotes/origin/nplez1/Agent-Button',
      'refs/remotes/origin/nplez1/pushed-only',
      'refs/remotes/upstream/main'
    ].join('\n')
  )

  expect(refs.local).toEqual(['nplez1/Hide-hosts', 'nplez1/a-brand-new-branch'])
  expect(refs.remote).toEqual(['nplez1/Agent-Button', 'nplez1/pushed-only'])
})

it('derives the inventory from the refs, not from a hand-kept list', () => {
  const branches = branchNames({
    local: [FORK_BASE, 'nplez1/a-brand-new-branch'],
    remote: [FORK_BASE, 'nplez1/pushed-only']
  })

  expect(branches[0]).toBe(FORK_BASE)
  expect(branches).toContain('nplez1/a-brand-new-branch')
  expect(branches).toContain('nplez1/pushed-only')
  // Upstream-bound branches cannot be described by the fork namespace, so they stay named.
  expect(branches).toContain('fix/terminal-session-reconnect')
})

it('includes a branch that exists on the fork but was never fetched here', () => {
  const branches = branchNames(
    { local: [FORK_BASE], remote: [] },
    ['fix/cli-symlink-world-readable'],
    [FORK_BASE, 'nplez1/pushed-from-another-worktree', 'nwparker/perf']
  )

  expect(branches).toContain('nplez1/pushed-from-another-worktree')
  expect(branches).toContain('fix/cli-symlink-world-readable')
  // Only the fork line, the fork namespace and the named upstream-bound set belong in this report.
  expect(branches).toContain(FORK_BASE)
  expect(branches).not.toContain('nwparker/perf')
})

it('keys a dependency by the branch name the branch actually has', () => {
  expect(parentFor('fix/terminal-session-reconnect')).toBe('feat/worktree-scan-cache-persistence')
  expect(parentFor('feat/startup-worktree-hydration')).toBe('fix/terminal-session-reconnect')
  expect(parentFor('nplez1/Hide-hosts')).toBe(FORK_BASE)
  // The fork line itself is measured against upstream, which is the delta worth reading.
  expect(parentFor(FORK_BASE)).toBe(UPSTREAM_BASE)
  expect(parentFor('fix/cli-symlink-world-readable')).toBe(UPSTREAM_BASE)
})

it('reports a dependency key that matches no branch instead of ignoring it', () => {
  expect(unmatchedParents(['nplez1/Hide-hosts'], PARENTS)).toEqual(Object.keys(PARENTS))
  expect(unmatchedParents(Object.keys(PARENTS), PARENTS)).toEqual([])
  expect(unobserved(new Set(['a']), ['a', 'b'])).toEqual(['b'])
})

it('reads the fork heads from one ls-remote listing', () => {
  const heads = parseRemoteHeads(
    ['9f1c2  refs/heads/main', 'abc123\trefs/heads/fix/terminal-session-reconnect'].join('\n')
  )

  expect(heads.get('main')).toBe('9f1c2')
  expect(heads.get('fix/terminal-session-reconnect')).toBe('abc123')
})

it('queries PR state on both repos and shows which repo a PR lives in', () => {
  const fork = parsePullRequestRows('nplez1/Hide-hosts\t9\tMERGED', 'nplez1/orca')
  const upstream = parsePullRequestRows(
    'fix/cli-symlink-world-readable\t20813\tOPEN',
    'stablyai/orca'
  )
  const merged = mergePullRequestRows(fork, upstream)

  expect(formatPullRequest(merged.get('nplez1/Hide-hosts'))).toBe('#9 merged (fork)')
  expect(formatPullRequest(merged.get('fix/cli-symlink-world-readable'))).toBe(
    '#20813 open (upstream)'
  )
  expect(formatPullRequest(undefined)).toBe('-')
})

it('reports the PR columns even when a gh query fails', async () => {
  const partial = await readPullRequests(['nplez1/Hide-hosts'], {
    readForkPrs: async () => null,
    readUpstreamPrs: async () => null
  })

  expect(partial.partial).toBe(true)
  expect(formatPullRequest(partial.pullRequests.get('nplez1/Hide-hosts'))).toBe('-')

  const forkOnly = await readPullRequests(['nplez1/Hide-hosts'], {
    readForkPrs: async () => parsePullRequestRows('nplez1/Hide-hosts\t9\tMERGED', 'nplez1/orca'),
    readUpstreamPrs: async () => null
  })
  // Why one repository failing must not blank the other: the row keeps what was read.
  expect(forkOnly.partial).toBe(true)
  expect(formatPullRequest(forkOnly.pullRequests.get('nplez1/Hide-hosts'))).toBe('#9 merged (fork)')
})

it('formats a delta, and truncates a generated branch name rather than misaligning the row', () => {
  expect(formatDelta(3, ' 3 files changed, 12 insertions(+), 4 deletions(-)')).toBe(
    '3 file(s) +12/−4'
  )
  expect(formatDelta(0, '')).toBe('0 file(s) +0/−0')

  const long = `nplez1/${'x'.repeat(80)}`
  const widths = columnWidths([long])
  const row = formatRow(
    { branch: long, local: 'abc', fork: 'def', delta: '1 file(s)', pr: '-' },
    widths
  )

  expect(row).toContain('…')
  expect(row.split(' ')[0]).toHaveLength(widths[0])
})

it('rejects an unknown argument', () => {
  expect(parseArgs(['--local-only']).localOnly).toBe(true)
  expect(() => parseArgs(['--local'])).toThrow(/unknown argument/)
})

it('reports the derived branches and their delta against this fork line', () => {
  const dir = repo()
  git(dir, ['checkout', '-qb', 'nplez1/feature'])
  writeFileSync(join(dir, 'feature.txt'), 'feature\n')
  git(dir, ['add', '.'])
  git(dir, ['commit', '-qm', 'feature'])
  git(dir, ['checkout', '-q', FORK_BASE])
  writeFileSync(join(dir, 'fork-only.txt'), 'fork\n')
  git(dir, ['add', '.'])
  git(dir, ['commit', '-qm', 'local(x): fork work'])
  git(dir, ['checkout', '-q', '-b', 'unrelated-branch', FORK_BASE])

  const out = execFileSync('node', [SCRIPT, '--local-only'], { cwd: dir, encoding: 'utf8' })
  const rows = out
    .split('\n')
    .filter((line) => line.startsWith(FORK_BASE) || line.startsWith('nplez1/'))

  // The fork line has its own row, measured against upstream rather than against itself.
  expect(rows.some((line) => line.startsWith(FORK_BASE) && line.includes('1 file(s)'))).toBe(true)
  expect(
    rows.some((line) => line.startsWith('nplez1/feature') && line.includes('1 file(s) +1/−0'))
  ).toBe(true)
  // `unrelated-branch` is outside the fork namespace, so it is not part of this report.
  expect(out.split('\n').some((line) => line.startsWith('unrelated-branch'))).toBe(false)
})
