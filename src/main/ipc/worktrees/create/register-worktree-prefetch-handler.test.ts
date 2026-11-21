import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../../../shared/repository/repo-types'
import { registerWorktreePrefetchHandler } from './register-worktree-prefetch-handler'
import { prefetchWorktreeCreateBase } from '../../../workspaces/creation/worktree-create-base-prefetch'
import { prepareWorktreeCreateForRepo } from '../../../workspaces/creation/preparation/worktree-create-preparation'
import { getWorktreeCreatePrefetchGitOptions } from '../../../workspaces/execution-host/project-runtime-git-options'
import { blockedWslDistroForPath } from '../../../wsl/filesystem/wsl-unc-access-gate'
import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import type { WorktreeIpcContext } from '../worktree-ipc-context'

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }))
vi.mock('../../../workspaces/creation/worktree-create-base-prefetch', () => ({
  prefetchWorktreeCreateBase: vi.fn()
}))
vi.mock('../../../workspaces/creation/preparation/worktree-create-preparation', () => ({
  prepareWorktreeCreateForRepo: vi.fn()
}))
vi.mock('../../../workspaces/execution-host/project-runtime-git-options', () => ({
  getWorktreeCreatePrefetchGitOptions: vi.fn()
}))
vi.mock('../../../wsl/filesystem/wsl-unc-access-gate', () => ({
  blockedWslDistroForPath: vi.fn()
}))

const REPO: Repo = {
  id: 'repo-1',
  path: '/tmp/repo',
  displayName: 'repo',
  badgeColor: '#000',
  addedAt: 0,
  kind: 'git'
}

type PrefetchHandler = (
  event: IpcMainInvokeEvent,
  args: { repoId: string; baseBranch?: string }
) => Promise<void>

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the handler reads no event field, and Electron's event interface has no structural stub.
const NO_EVENT = {} as IpcMainInvokeEvent

function handlerFrom(): PrefetchHandler {
  const call = vi.mocked(ipcMain.handle).mock.calls.at(-1)
  expect(call?.[0]).toBe('worktrees:prefetchCreateBase')
  if (!call) {
    throw new Error('the prefetch handler was never registered')
  }
  return async (event, args) => {
    await call[1](event, args)
  }
}

function registered(overrides: { repo?: Repo | undefined } = {}) {
  const store = { getRepo: vi.fn(() => ('repo' in overrides ? overrides.repo : REPO)) }
  const runtime = { name: 'runtime' }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the handler reads only getRepo and hands the runtime back to the injected prefetch.
  const context = { store, runtime } as unknown as WorktreeIpcContext
  registerWorktreePrefetchHandler(context)
  return { store, runtime, handler: handlerFrom() }
}

beforeEach(() => {
  vi.mocked(ipcMain.handle).mockClear()
  vi.mocked(prefetchWorktreeCreateBase).mockReset().mockResolvedValue('origin/main')
  vi.mocked(getWorktreeCreatePrefetchGitOptions)
    .mockReset()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the handler forwards git options opaquely; only wslDistro is read here.
    .mockReturnValue({ wslDistro: 'Ubuntu' } as never)
  vi.mocked(blockedWslDistroForPath).mockReset().mockResolvedValue(null)
})

describe('worktrees:prefetchCreateBase', () => {
  it('prefetches with the repo, the runtime and a checkout preparation bound to the store', async () => {
    const { runtime, handler } = registered()
    await handler(NO_EVENT, { repoId: 'repo-1', baseBranch: 'release' })

    expect(prefetchWorktreeCreateBase).toHaveBeenCalledTimes(1)
    const args = vi.mocked(prefetchWorktreeCreateBase).mock.calls[0][0]
    expect(args).toMatchObject({ repo: REPO, baseBranch: 'release', runtime })
    expect(args.gitOptions).toEqual({ wslDistro: 'Ubuntu' })

    if (!args.prepareCheckout) {
      throw new Error('the handler registered no checkout preparation')
    }
    await args.prepareCheckout('origin/main')
    expect(prepareWorktreeCreateForRepo).toHaveBeenCalledWith(
      expect.anything(),
      REPO,
      'origin/main',
      undefined
    )
  })

  it('does nothing for a repo the store does not hold', async () => {
    const { handler } = registered({ repo: undefined })
    await handler(NO_EVENT, { repoId: 'gone' })
    expect(prefetchWorktreeCreateBase).not.toHaveBeenCalled()
  })

  it('skips a repo whose WSL distro is blocked, because opening a composer is no act on it', async () => {
    vi.mocked(blockedWslDistroForPath).mockResolvedValue({ distro: 'Ubuntu', state: 'stopped' })
    const { handler } = registered()
    await handler(NO_EVENT, { repoId: 'repo-1' })
    expect(prefetchWorktreeCreateBase).not.toHaveBeenCalled()
  })

  it('swallows a speculative failure, because Create retries and reports it', async () => {
    vi.mocked(prefetchWorktreeCreateBase).mockRejectedValue(new Error('offline'))
    const { handler } = registered()
    await expect(handler(NO_EVENT, { repoId: 'repo-1' })).resolves.toBeUndefined()
  })
})
