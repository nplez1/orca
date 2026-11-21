import { describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../../shared/repository/repo-types'
import { prefetchWorktreeCreateBase } from './worktree-create-base-prefetch'
import { getDefaultBaseRefAsync } from '../../git/refs/resolution/repo-default-base-ref'
import { hasLocalWorktreeBaseRef } from '../../git/worktrees/creation/worktree-base-ref-probe'

vi.mock('../../git/refs/resolution/repo-default-base-ref', () => ({
  getDefaultBaseRefAsync: vi.fn()
}))
vi.mock('../../git/worktrees/creation/worktree-base-ref-probe', () => ({
  hasLocalWorktreeBaseRef: vi.fn()
}))

const TRACKING = {
  remote: 'origin',
  branch: 'main',
  ref: 'refs/remotes/origin/main',
  base: 'origin/main'
}

function repo(overrides: Partial<Repo> = {}): Repo {
  return {
    id: 'repo-1',
    path: '/tmp/repo',
    displayName: 'repo',
    badgeColor: '#000',
    addedAt: 0,
    kind: 'git',
    ...overrides
  }
}

function runtime(overrides: Record<string, unknown> = {}) {
  return {
    resolveRemoteTrackingBase: vi.fn(async () => TRACKING),
    hasRemoteTrackingRef: vi.fn(async () => false),
    getOrStartRemoteTrackingBaseRefresh: vi.fn(async () => ({ ok: true })),
    fetchRemoteWithCache: vi.fn(async () => {}),
    ...overrides
  }
}

describe('prefetchWorktreeCreateBase', () => {
  it('skips a folder repo and a repo served by a remote connection', async () => {
    const fake = runtime()
    expect(
      await prefetchWorktreeCreateBase({
        repo: repo({ kind: 'folder' }),
        runtime: fake,
        gitOptions: {}
      })
    ).toBeUndefined()
    expect(
      await prefetchWorktreeCreateBase({
        repo: repo({ connectionId: 'ssh:me@host' }),
        runtime: fake,
        gitOptions: {}
      })
    ).toBeUndefined()
    expect(fake.resolveRemoteTrackingBase).not.toHaveBeenCalled()
  })

  it('materializes once, after the refresh the checkout was registered against', async () => {
    vi.mocked(getDefaultBaseRefAsync).mockResolvedValue('origin/main')
    vi.mocked(hasLocalWorktreeBaseRef).mockResolvedValue(false)
    const settle: { finish?: () => void } = {}
    const fake = runtime({
      hasRemoteTrackingRef: vi.fn(async () => true),
      getOrStartRemoteTrackingBaseRefresh: vi.fn(
        () =>
          new Promise<{ ok: boolean }>((resolve) => {
            settle.finish = () => resolve({ ok: true })
          })
      )
    })
    const prepareCheckout = vi.fn(
      async (_base: string, _beforeMaterialization?: Promise<void>) => {}
    )

    const inFlight = prefetchWorktreeCreateBase({
      repo: repo(),
      runtime: fake,
      gitOptions: {},
      prepareCheckout
    })
    await vi.waitFor(() => expect(prepareCheckout).toHaveBeenCalledTimes(1))
    const beforeMaterialization = prepareCheckout.mock.calls[0][1]
    expect(beforeMaterialization).toBeInstanceOf(Promise)
    if (!beforeMaterialization) {
      throw new Error('the checkout was registered without its pre-materialization gate')
    }

    let materialized = false
    void beforeMaterialization.then(() => {
      materialized = true
    })
    await Promise.resolve()
    expect(materialized).toBe(false)

    settle.finish?.()
    await inFlight
    await vi.waitFor(() => expect(materialized).toBe(true))
    expect(prepareCheckout).toHaveBeenCalledTimes(1)
  })

  it('settles the pre-materialization gate when the refresh fails, so an offline checkout proceeds', async () => {
    vi.mocked(getDefaultBaseRefAsync).mockResolvedValue('origin/main')
    vi.mocked(hasLocalWorktreeBaseRef).mockResolvedValue(false)
    const fake = runtime({
      hasRemoteTrackingRef: vi.fn(async () => true),
      getOrStartRemoteTrackingBaseRefresh: vi.fn(async () => {
        throw new Error('offline')
      })
    })
    const prepareCheckout = vi.fn(
      async (_base: string, _beforeMaterialization?: Promise<void>) => {}
    )

    // The speculative failure surfaces here; the handler that calls this swallows it.
    await expect(
      prefetchWorktreeCreateBase({ repo: repo(), runtime: fake, gitOptions: {}, prepareCheckout })
    ).rejects.toThrow('offline')
    expect(prepareCheckout).toHaveBeenCalledTimes(1)
    await expect(prepareCheckout.mock.calls[0][1]).resolves.toBeUndefined()
  })

  it('falls back to the shared origin fetch when no usable ref exists', async () => {
    vi.mocked(getDefaultBaseRefAsync).mockResolvedValue('origin/main')
    vi.mocked(hasLocalWorktreeBaseRef).mockResolvedValue(false)
    const fake = runtime({ resolveRemoteTrackingBase: vi.fn(async () => null) })

    await prefetchWorktreeCreateBase({ repo: repo(), runtime: fake, gitOptions: {} })
    expect(fake.fetchRemoteWithCache).toHaveBeenCalledWith('/tmp/repo', 'origin')
  })

  it('swallows a preparation failure, because Create reports the error', async () => {
    vi.mocked(getDefaultBaseRefAsync).mockResolvedValue('origin/main')
    vi.mocked(hasLocalWorktreeBaseRef).mockResolvedValue(true)
    const prepareCheckout = vi.fn(async () => {
      throw new Error('checkout failed')
    })

    await expect(
      prefetchWorktreeCreateBase({
        repo: repo(),
        runtime: runtime(),
        gitOptions: {},
        prepareCheckout
      })
    ).resolves.toBe('origin/main')
  })
})
