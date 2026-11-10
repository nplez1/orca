import { execFileSync, spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { devNull, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import {
  FORK_ON_LINE,
  UNCLASSIFIED,
  UPSTREAM_BOUND,
  classifyLineage,
  decide
} from '../../local/commit-msg-guard.mjs'

const GUARD = new URL('../../local/commit-msg-guard.mjs', import.meta.url).pathname
const HOOK = new URL('../../.husky/commit-msg', import.meta.url).pathname
const PATH_MODULE = new URL('../../local/fork-owned-paths.mjs', import.meta.url).pathname

// Why stripped: an inherited `GIT_DIR` or `GIT_INDEX_FILE` would point the fixture's git at this
// checkout, and the guard would then classify the repository instead of the temp repo.
const ENV = {
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))),
  GIT_CONFIG_GLOBAL: devNull,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'fixture',
  GIT_AUTHOR_EMAIL: 'fixture@example.com',
  GIT_COMMITTER_NAME: 'fixture',
  GIT_COMMITTER_EMAIL: 'fixture@example.com'
}

const dirs = []

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'orca-commit-msg-'))
  dirs.push(dir)
  return dir
}

function git(dir, args) {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf8', env: ENV }).trim()
}

function write(dir, path, text) {
  mkdirSync(dirname(join(dir, path)), { recursive: true })
  writeFileSync(join(dir, path), text)
}

function commit(dir, subject) {
  git(dir, ['add', '-A'])
  git(dir, ['commit', '-qm', subject])
}

/**
 * The shape the hook has to tell apart: `main` is the fork's own line (one commit that adds fork-only
 * paths), `upstream-line` is upstream's tip and what `refs/remotes/upstream/main` points at, `fork-old`
 * was cut from the fork line before the fork advanced, and `up` was cut from upstream's line.
 */
function fixture() {
  const dir = tempDir()
  git(dir, ['init', '-q', '-b', 'upstream-line'])
  write(dir, 'src/a.ts', 'a')
  commit(dir, 'chore: upstream 0')
  git(dir, ['update-ref', 'refs/remotes/upstream/main', 'HEAD'])

  git(dir, ['checkout', '-q', '-b', 'main'])
  git(dir, ['update-ref', 'refs/remotes/origin/main', 'HEAD'])
  write(dir, 'local/tool.mjs', 'tool')
  write(dir, 'RELEASE-RUNBOOK.md', 'notes')
  write(dir, '.husky/commit-msg', 'hook')
  commit(dir, 'local(hooks): fork 1')
  git(dir, ['update-ref', 'refs/remotes/origin/main', 'HEAD'])

  git(dir, ['checkout', '-q', '-b', 'fork-old'])
  write(dir, 'src/branch.ts', 'b')
  commit(dir, 'feat: branch work')

  git(dir, ['checkout', '-q', 'main'])
  write(dir, 'local/tool2.mjs', 'tool2')
  commit(dir, 'local(hooks): fork 2')
  git(dir, ['update-ref', 'refs/remotes/origin/main', 'HEAD'])

  git(dir, ['checkout', '-q', '-b', 'up', 'upstream-line'])
  write(dir, 'src/upstream.ts', 'u')
  commit(dir, 'feat: upstream work')
  return dir
}

/** Runs the guard the way the hook does: a message file, and the repository as the cwd. */
function guard(dir, subject) {
  const message = join(tempDir(), 'message.txt')
  writeFileSync(message, `${subject}\n\nbody\n`)
  const result = spawnSync(process.execPath, [GUARD, message], {
    cwd: dir,
    encoding: 'utf8',
    env: ENV
  })
  return { status: result.status, stderr: result.stderr }
}

function stage(dir, path, text) {
  write(dir, path, text)
  git(dir, ['add', path])
}

it('accepts a local( commit on a fork branch that is behind an advanced main', () => {
  const dir = fixture()
  git(dir, ['checkout', '-q', 'fork-old'])

  expect(guard(dir, 'local(hooks): a fork-only change')).toMatchObject({ status: 0 })
})

it('accepts a local( commit on main itself', () => {
  const dir = fixture()
  git(dir, ['checkout', '-q', 'main'])

  expect(guard(dir, 'local(hooks): a fork-only change')).toMatchObject({ status: 0 })
})

it('accepts a local( commit when only the remote fork ref exists', () => {
  const dir = fixture()
  git(dir, ['update-ref', 'refs/remotes/origin/main', 'main'])
  git(dir, ['checkout', '-q', 'fork-old'])
  git(dir, ['branch', '-q', '-D', 'main'])

  expect(guard(dir, 'local(hooks): a fork-only change')).toMatchObject({ status: 0 })
})

it('refuses a local( subject on an upstream-bound branch', () => {
  const dir = fixture()

  const result = guard(dir, 'local(hooks): a fork-only change')
  expect(result.status).toBe(1)
  expect(result.stderr).toContain('upstream-bound')
})

it('refuses a fork-owned path on an upstream-bound branch under a normal subject', () => {
  const dir = fixture()
  stage(dir, 'local/leak.mjs', 'leaked')

  const result = guard(dir, 'feat(git): a change upstream could review')
  expect(result.status).toBe(1)
  expect(result.stderr).toContain('local/leak.mjs')
})

it('refuses a derived-only fork path the literal list does not name', () => {
  const dir = fixture()
  stage(dir, 'RELEASE-RUNBOOK.md', 'notes')

  const result = guard(dir, 'docs: release notes')
  expect(result.status).toBe(1)
  expect(result.stderr).toContain('RELEASE-RUNBOOK.md')
})

it('accepts fork-owned paths on a fork branch, which owns them', () => {
  const dir = fixture()
  git(dir, ['checkout', '-q', 'fork-old'])
  stage(dir, 'local/added.mjs', 'added')

  expect(guard(dir, 'local(hooks): add a tool')).toMatchObject({ status: 0 })
})

it('accepts an ordinary source change on an upstream-bound branch', () => {
  const dir = fixture()
  stage(dir, 'src/upstream.ts', 'u2')

  expect(guard(dir, 'fix(git): an upstream fix')).toMatchObject({ status: 0 })
})

it('allows the commit with a warning when no fork line ref resolves', () => {
  const dir = fixture()
  git(dir, ['checkout', '-q', 'fork-old'])
  git(dir, ['branch', '-q', '-D', 'main'])
  git(dir, ['update-ref', '-d', 'refs/remotes/origin/main'])

  const result = guard(dir, 'local(hooks): a fork-only change')
  expect(result.status).toBe(0)
  expect(result.stderr).toContain('not classifying')
})

it('does not read a file upstream already carries as fork-added', () => {
  const dir = fixture()
  git(dir, ['checkout', '-q', 'upstream-line'])
  write(dir, 'NEW.md', 'upstream notes')
  commit(dir, 'docs: upstream notes')
  git(dir, ['update-ref', 'refs/remotes/upstream/main', 'HEAD'])
  // The fork syncs it, so the file is on both lines; only a base that predates it makes it fork-added.
  git(dir, ['checkout', '-q', 'main'])
  git(dir, ['merge', '-q', '--no-edit', 'upstream-line'])
  git(dir, ['checkout', '-q', '-b', 'up-fresh', 'upstream-line'])
  stage(dir, 'NEW.md', 'upstream notes, edited')

  expect(guard(dir, 'docs: edit the upstream notes')).toMatchObject({ status: 0 })
})

it('accepts removing a leaked fork file, which is the fix for the leak', () => {
  const dir = fixture()
  stage(dir, 'local/leak.mjs', 'leaked')
  commit(dir, 'local(x): leak it')
  git(dir, ['rm', '-q', 'local/leak.mjs'])

  expect(guard(dir, 'chore: drop the leaked file')).toMatchObject({ status: 0 })
})

it('refuses a merge of main into an upstream-bound branch', () => {
  const dir = fixture()
  git(dir, ['merge', '-q', '--no-commit', '--no-ff', 'main'])

  const result = guard(dir, 'Merge branch main into up')
  expect(result.status).toBe(1)
  expect(result.stderr).toContain('local/tool.mjs')
  git(dir, ['merge', '--abort'])
})

it('allows the commit with a warning when the fork ref shares no reachable history', () => {
  // A `--depth` clone reports exactly this, and this fork is cloned shallow by CI and by agents.
  const runGit = (args) => {
    if (args[0] === 'merge-base') {
      throw new Error('fatal: no merge base')
    }
    if (args[0] === 'rev-parse' && args.at(-1).startsWith('HEAD')) {
      return 'head'
    }
    if (args[0] === 'rev-parse') {
      return 'sha'
    }
    throw new Error(`unexpected git ${args.join(' ')}`)
  }

  expect(classifyLineage(runGit)).toMatchObject({
    lineage: UNCLASSIFIED,
    why: expect.stringContaining('no reachable history')
  })
})

it('refuses to run when the tree carries the hook but not the guard it runs', () => {
  const dir = fixture()
  mkdirSync(join(dir, '.husky'), { recursive: true })
  copyFileSync(HOOK, join(dir, '.husky/commit-msg'))

  const message = join(tempDir(), 'message.txt')
  writeFileSync(message, 'feat(git): anything\n')
  const result = spawnSync('sh', ['-e', '.husky/commit-msg', message], {
    cwd: dir,
    encoding: 'utf8',
    env: ENV
  })
  expect(result.status).toBe(1)
  expect(result.stderr).toContain('leaked onto an upstream-bound branch')
})

function withHook(branch) {
  const dir = fixture()
  git(dir, ['checkout', '-q', branch])
  mkdirSync(join(dir, '.husky'), { recursive: true })
  mkdirSync(join(dir, 'local'), { recursive: true })
  copyFileSync(HOOK, join(dir, '.husky/commit-msg'))
  copyFileSync(GUARD, join(dir, 'local/commit-msg-guard.mjs'))
  copyFileSync(PATH_MODULE, join(dir, 'local/fork-owned-paths.mjs'))
  return dir
}

it('refuses through the hook itself, run the way husky runs it', () => {
  const dir = withHook('up')
  stage(dir, 'local/leak.mjs', 'leaked')

  const message = join(tempDir(), 'message.txt')
  writeFileSync(message, 'feat(git): a change upstream could review\n')
  const refused = spawnSync('sh', ['-e', '.husky/commit-msg', message], {
    cwd: dir,
    encoding: 'utf8',
    env: ENV
  })
  expect(refused.status).toBe(1)
  expect(refused.stderr).toContain('local/leak.mjs')

  writeFileSync(message, 'local(hooks): a fork-only change\n')
  const allowed = spawnSync('sh', ['-e', '.husky/commit-msg', message], {
    cwd: withHook('fork-old'),
    encoding: 'utf8',
    env: ENV
  })
  expect(allowed.status).toBe(0)
})

it('decides the same way with no git at all', () => {
  expect(decide({ subject: 'local(x): y', lineage: FORK_ON_LINE })).toMatchObject({ ok: true })
  expect(
    decide({ subject: 'feat: y', lineage: FORK_ON_LINE, forkOwnedStaged: ['local/a'] })
  ).toMatchObject({ ok: true })
  expect(decide({ subject: 'local(x): y', lineage: UPSTREAM_BOUND })).toMatchObject({ ok: false })
  expect(
    decide({ subject: 'feat: y', lineage: UPSTREAM_BOUND, forkOwnedStaged: ['local/a'] })
  ).toMatchObject({ ok: false })
  expect(decide({ subject: 'local(x): y', lineage: UNCLASSIFIED, why: 'no refs' })).toMatchObject({
    ok: true,
    warning: expect.stringContaining('no refs')
  })
})
