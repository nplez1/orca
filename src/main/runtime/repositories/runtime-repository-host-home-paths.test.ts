import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import type * as NodeOs from 'node:os'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { runProcessSync } from '@orca/process-host'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../../shared/repo-types'
import { partialRuntimeStore } from '../orca-runtime-tests/runtime-store-partial-fixture'
import { RuntimeRepositoryCloneController } from './runtime-repository-clone-controller'
import { RuntimeRepositoryRegistrationController } from './runtime-repository-registration-controller'

const home = vi.hoisted(() => ({ current: '' }))

// A paired host answers `~` with its own home, so the server process's home is what a `~` means.
vi.mock('node:os', async (importOriginal) => ({
  ...(await importOriginal<typeof NodeOs>()),
  homedir: () => home.current
}))

vi.mock('../../repository-icons/repo-icon-autodetect', () => ({
  detectRepoIconAndUpstream: vi.fn().mockResolvedValue({})
}))

vi.mock('../../workspaces/creation/worktree-root-preparation', () => ({
  prepareLocalWorktreeRootForRepo: vi.fn().mockResolvedValue(undefined)
}))

function createStore(
  repos: Repo[] = [],
  settings: Record<string, unknown> = {}
): ReturnType<typeof partialRuntimeStore> {
  return partialRuntimeStore({
    getRepos: () => repos,
    getRepo: (id: string) => repos.find((repo) => repo.id === id),
    getSettings: () => settings,
    addRepo: (repo: Repo) => {
      repos.push(repo)
      return repo
    },
    updateRepo: () => null
  })
}

function runGit(args: string[]): void {
  const result = runProcessSync({ program: 'git', args })
  if (result.code !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`)
  }
}

describe('a paired host expands ~ against its own home', () => {
  let root: string

  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'orca-host-home-')))
    home.current = root
  })

  afterEach(async () => {
    home.current = ''
    await rm(root, { recursive: true, force: true })
  })

  it('creates a project under the home folder a ~ names', async () => {
    const repos: Repo[] = []
    const controller = new RuntimeRepositoryRegistrationController({
      getStore: () => createStore(repos),
      invalidateResolvedWorktrees: () => {},
      invalidateWorktreeScan: () => {},
      notifyReposChanged: () => {}
    })

    const result = await controller.create('~/projects', 'demo', 'folder')

    expect('error' in result).toBe(false)
    expect(repos).toHaveLength(1)
    expect(repos[0].path).toBe(join(root, 'projects', 'demo'))
  })

  it('checks a clone target under the home folder a ~ names', async () => {
    const taken = join(root, 'clones', 'source')
    await mkdir(taken, { recursive: true })
    await writeFile(join(taken, 'README.md'), 'taken')
    const controller = new RuntimeRepositoryCloneController({
      getStore: () => createStore(),
      invalidateResolvedWorktrees: () => {},
      invalidateWorktreeScan: () => {},
      notifyReposChanged: () => {}
    })

    const check = await controller.checkTarget({
      url: 'https://github.com/o/source.git',
      destination: '~/clones'
    })

    expect(check.status).toBe('taken')
    expect(check.folderName).toBe('source')
  })

  it('nests a clone under the home folder a ~ names, never a literal ~ folder', async () => {
    const source = join(root, 'origin', 'source')
    await mkdir(source, { recursive: true })
    runGit(['-c', 'init.defaultBranch=main', 'init', '-q', source])
    runGit([
      '-C',
      source,
      '-c',
      'user.name=t',
      '-c',
      'user.email=t@t.invalid',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '-q',
      '--allow-empty',
      '-m',
      'init'
    ])
    const repos: Repo[] = []
    const controller = new RuntimeRepositoryCloneController({
      getStore: () => createStore(repos, { worktreeLayoutMode: 'repo-nested' }),
      invalidateResolvedWorktrees: () => {},
      invalidateWorktreeScan: () => {},
      notifyReposChanged: () => {}
    })
    const originalCwd = process.cwd()
    // The nested placement makes the folder before the path is validated, so a stray `~` would land here.
    process.chdir(root)
    try {
      const cloned = await controller.clone(pathToFileURL(source).href, '~/clones')

      expect(cloned.path).toBe(join(root, 'clones', 'source', 'main'))
      expect(existsSync(join(root, '~'))).toBe(false)
    } finally {
      process.chdir(originalCwd)
    }
  })
})
