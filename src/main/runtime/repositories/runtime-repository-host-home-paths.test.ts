import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import type * as NodeOs from 'node:os'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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

function createStore(repos: Repo[] = []): ReturnType<typeof partialRuntimeStore> {
  return partialRuntimeStore({
    getRepos: () => repos,
    getRepo: (id: string) => repos.find((repo) => repo.id === id),
    addRepo: (repo: Repo) => {
      repos.push(repo)
      return repo
    },
    updateRepo: () => null
  })
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
})
