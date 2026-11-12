// @vitest-environment happy-dom

import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NeedsSetupProjectHostOption } from '@/lib/project-host-setup-options'
import { resetProjectCloneInFlightForTests } from './project-clone-in-flight'
import { useRunTargetAutoClone } from './use-run-target-auto-clone'

const mocks = vi.hoisted(() => ({
  setupProjectClone: vi.fn(),
  resolveCloneParentForHost: vi.fn(),
  checkCloneTargetOn: vi.fn(),
  toastError: vi.fn()
}))

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: unknown) => unknown) =>
    selector({ setupProjectClone: mocks.setupProjectClone })
}))

vi.mock('@/store/projects/project-host-routing', () => ({
  getProjectCloneCheckTarget: () => ({ kind: 'local' })
}))

vi.mock('@/components/sidebar/project-admission/clone-folder/use-clone-folder-override', () => ({
  checkCloneTargetOn: mocks.checkCloneTargetOn
}))

vi.mock('@/components/sidebar/project-admission/create/resolve-clone-parent-for-host', () => ({
  resolveCloneParentForHost: mocks.resolveCloneParentForHost
}))

vi.mock('sonner', () => ({ toast: { error: mocks.toastError, success: vi.fn() } }))

const HOST = 'runtime:env-b'
const DEFAULT_URL = 'git@github.com:acme/app.git'
const DESTINATION = '/home/alice/orca/projects'

const option: NeedsSetupProjectHostOption = {
  kind: 'needs-setup',
  id: `needs-setup:${HOST}`,
  projectId: 'github:acme/app',
  hostId: HOST,
  label: 'Build box',
  detail: 'Project location not set',
  isAvailable: true,
  attention: false,
  canSetLocation: true
}

const OTHER_HOST: NeedsSetupProjectHostOption = {
  ...option,
  id: 'needs-setup:runtime:env-c',
  hostId: 'runtime:env-c',
  label: 'Second box'
}

function renderClone(onProvisioned = vi.fn()) {
  return renderHook(() =>
    useRunTargetAutoClone({
      projectId: 'github:acme/app',
      projectName: 'app',
      defaultCloneUrl: DEFAULT_URL,
      settings: null,
      layoutMode: undefined,
      onProvisioned
    })
  )
}

beforeEach(() => {
  resetProjectCloneInFlightForTests()
  mocks.setupProjectClone.mockReset()
  mocks.resolveCloneParentForHost.mockReset()
  mocks.checkCloneTargetOn.mockReset()
  mocks.toastError.mockReset()
  mocks.resolveCloneParentForHost.mockResolvedValue(DESTINATION)
  mocks.checkCloneTargetOn.mockResolvedValue(null)
  mocks.setupProjectClone.mockResolvedValue({ setup: { id: 'setup-new' } })
})

afterEach(() => {
  cleanup()
})

describe('useRunTargetAutoClone', () => {
  it('clones from the project remote into the host default with no dialog and no folder name', async () => {
    const onProvisioned = vi.fn()
    const { result } = renderClone(onProvisioned)

    await act(async () => result.current.start(option))

    expect(mocks.resolveCloneParentForHost).toHaveBeenCalledWith(
      expect.objectContaining({ hostIds: [HOST] })
    )
    expect(mocks.setupProjectClone).toHaveBeenCalledWith(
      {
        projectId: 'github:acme/app',
        hostId: HOST,
        url: DEFAULT_URL,
        destination: DESTINATION,
        displayName: 'app'
      },
      { onFailure: 'throw' }
    )
    // Why the method: only our own clone can make the clone itself the copy.
    expect(onProvisioned).toHaveBeenCalledWith(JSON.stringify(['setup-new', HOST]), 'cloned')
    expect(result.current.status.kind).toBe('idle')
  })

  it('lets an advanced override win over both defaults', async () => {
    const { result } = renderClone()

    act(() => {
      result.current.setOverrides({ url: 'https://github.com/acme/app.git', destination: '/srv/x' })
    })
    await act(async () => result.current.start(option))

    expect(mocks.resolveCloneParentForHost).not.toHaveBeenCalled()
    expect(mocks.setupProjectClone).toHaveBeenCalledWith(
      expect.objectContaining({ url: 'https://github.com/acme/app.git', destination: '/srv/x' }),
      { onFailure: 'throw' }
    )
  })

  it('joins a clone already running for the same project and host', async () => {
    let finish: (value: unknown) => void = () => {}
    mocks.setupProjectClone.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve
      })
    )
    const onProvisioned = vi.fn()
    const { result } = renderClone(onProvisioned)

    // Flush the destination resolution so the first clone is genuinely in flight.
    await act(async () => {
      result.current.start(option)
    })
    act(() => result.current.start(option))
    await act(async () => {
      finish({ setup: { id: 'setup-new' } })
    })

    // Why: a second clone would collide on the destination or land a duplicate checkout.
    expect(mocks.setupProjectClone).toHaveBeenCalledTimes(1)
    // Why: the joined pick must not strand the clone it joined — the composer would wait forever.
    expect(onProvisioned).toHaveBeenCalledWith(JSON.stringify(['setup-new', HOST]), 'cloned')
    expect(result.current.status.kind).toBe('idle')
  })

  it('ignores the host it was moved away from and applies the one it was moved to', async () => {
    const finishes = new Map<string, (value: unknown) => void>()
    mocks.setupProjectClone.mockImplementation(
      (args: { hostId: string }) =>
        new Promise((resolve) => {
          finishes.set(args.hostId, resolve)
        })
    )
    const otherHost: NeedsSetupProjectHostOption = {
      ...option,
      id: 'needs-setup:runtime:env-c',
      hostId: 'runtime:env-c',
      label: 'Second box'
    }
    const onProvisioned = vi.fn()
    const { result } = renderClone(onProvisioned)

    await act(async () => {
      result.current.start(option)
    })
    await act(async () => {
      result.current.start(otherHost)
    })
    await act(async () => {
      finishes.get(HOST)?.({ setup: { id: 'setup-b' } })
    })

    expect(onProvisioned).not.toHaveBeenCalled()
    expect(result.current.status).toMatchObject({ kind: 'cloning' })

    await act(async () => {
      finishes.get('runtime:env-c')?.({ setup: { id: 'setup-c' } })
    })

    expect(onProvisioned).toHaveBeenCalledWith(
      JSON.stringify(['setup-c', 'runtime:env-c']),
      'cloned'
    )
  })

  it('joins a clone a closed composer started, and still reports how it turned out', async () => {
    let finish: (value: unknown) => void = () => {}
    mocks.setupProjectClone.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve
      })
    )
    const first = renderClone()
    await act(async () => {
      first.result.current.start(option)
    })
    // A reopened composer is a new instance: it has no pending key of its own.
    first.unmount()
    const onProvisioned = vi.fn()
    const second = renderClone(onProvisioned)
    await act(async () => {
      second.result.current.start(option)
    })

    expect(mocks.setupProjectClone).toHaveBeenCalledTimes(1)
    expect(second.result.current.status.kind).toBe('cloning')

    await act(async () => {
      finish({ setup: { id: 'setup-new' } })
    })

    // Why: the reopened composer must not be left waiting on a clone it joined but never hears about.
    expect(onProvisioned).toHaveBeenCalledWith(JSON.stringify(['setup-new', HOST]), 'cloned')
    expect(second.result.current.status.kind).toBe('idle')
  })

  it('drops a destination typed for another host instead of cloning into it there', async () => {
    mocks.checkCloneTargetOn
      .mockResolvedValueOnce({
        status: 'taken',
        folderName: 'app',
        suggestedFolderName: 'app-2',
        reason: 'not-empty'
      })
      .mockResolvedValue(null)
    const { result } = renderClone()

    await act(async () => result.current.start(option))
    act(() => result.current.setOverrides({ destination: '/srv/only-on-b' }))
    act(() => result.current.clear())
    await act(async () => result.current.start(OTHER_HOST))

    // Why the default: a path names one machine, so it must not follow the user to the next host.
    expect(mocks.setupProjectClone).toHaveBeenCalledWith(
      expect.objectContaining({ hostId: 'runtime:env-c', destination: DESTINATION }),
      { onFailure: 'throw' }
    )
  })

  it('starts nothing for a host the user abandoned while its folder was still being resolved', async () => {
    let releaseProbe: (value: string) => void = () => {}
    mocks.resolveCloneParentForHost.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseProbe = resolve
        })
    )
    const { result } = renderClone()

    act(() => result.current.start(option))
    await act(async () => result.current.start(OTHER_HOST))
    await act(async () => {
      releaseProbe('/home/abandoned')
    })

    // Why: the abandoned host would otherwise end up with a checkout nobody asked to keep.
    expect(mocks.setupProjectClone).toHaveBeenCalledTimes(1)
    expect(mocks.setupProjectClone.mock.calls[0][0]).toMatchObject({ hostId: 'runtime:env-c' })
  })

  it('starts nothing for a host abandoned before the composer closed', async () => {
    let releaseProbe: (value: string) => void = () => {}
    mocks.resolveCloneParentForHost.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseProbe = resolve
        })
    )
    const { result, unmount } = renderClone()

    act(() => result.current.start(option))
    // A project switch calls `clear()` too, so this covers both ways of moving on.
    act(() => result.current.clear())
    unmount()
    await act(async () => {
      releaseProbe('/home/abandoned')
    })

    // Why: closing the composer must not revive a clone the user had already dropped.
    expect(mocks.setupProjectClone).not.toHaveBeenCalled()
  })

  it('starts nothing for the host it was moved off before the composer closed', async () => {
    let releaseProbe: (value: string) => void = () => {}
    mocks.resolveCloneParentForHost.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseProbe = resolve
        })
    )
    const { result, unmount } = renderClone()

    act(() => result.current.start(option))
    await act(async () => result.current.start(OTHER_HOST))
    unmount()
    await act(async () => {
      releaseProbe('/home/abandoned')
    })

    expect(mocks.setupProjectClone).toHaveBeenCalledTimes(1)
    expect(mocks.setupProjectClone.mock.calls[0][0]).toMatchObject({ hostId: 'runtime:env-c' })
  })

  it('starts nothing for a host abandoned while the clone target was being checked', async () => {
    let releaseCheck: (value: null) => void = () => {}
    mocks.checkCloneTargetOn.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseCheck = resolve
        })
    )
    const { result, unmount } = renderClone()

    await act(async () => result.current.start(option))
    act(() => result.current.clear())
    unmount()
    await act(async () => {
      releaseCheck(null)
    })

    // Why: the second checkpoint is the last one before the clone is started.
    expect(mocks.setupProjectClone).not.toHaveBeenCalled()
  })

  it('keeps running a clone the closed composer was still waiting on', async () => {
    let releaseProbe: (value: string) => void = () => {}
    mocks.resolveCloneParentForHost.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseProbe = resolve
        })
    )
    const { result, unmount } = renderClone()

    act(() => result.current.start(option))
    unmount()
    await act(async () => {
      releaseProbe(DESTINATION)
    })

    // Why: closing the composer is not the user moving away — they may reopen and join this clone.
    expect(mocks.setupProjectClone).toHaveBeenCalledTimes(1)
    expect(mocks.setupProjectClone.mock.calls[0][0]).toMatchObject({ hostId: HOST })
  })

  it('keeps a destination typed while no clone was pending for the host picked next', async () => {
    const { result } = renderClone()

    act(() => result.current.setOverrides({ destination: '/srv/typed-before' }))
    await act(async () => result.current.start(option))

    expect(mocks.setupProjectClone).toHaveBeenCalledWith(
      expect.objectContaining({ destination: '/srv/typed-before' }),
      { onFailure: 'throw' }
    )
  })

  it('runs nothing when the default folder is already taken', async () => {
    mocks.checkCloneTargetOn.mockResolvedValue({
      status: 'taken',
      folderName: 'app',
      suggestedFolderName: 'app-2',
      reason: 'not-empty'
    })
    const { result } = renderClone()

    await act(async () => result.current.start(option))

    expect(mocks.setupProjectClone).not.toHaveBeenCalled()
    expect(result.current.status).toMatchObject({
      kind: 'folder-taken',
      folderName: 'app',
      suggestion: 'app-2',
      canUseExistingFolder: true
    })
  })

  it('keeps a failed clone on the row, with no toast and nothing cloned locally', async () => {
    const localClone = vi.fn()
    vi.stubGlobal('window', { api: { repos: { clone: localClone } } })
    mocks.setupProjectClone.mockRejectedValue(
      new Error("Error invoking remote method 'repo.clone': Error: Repository not found")
    )
    const onProvisioned = vi.fn()
    const { result } = renderClone(onProvisioned)

    await act(async () => result.current.start(option))

    expect(result.current.status).toMatchObject({
      kind: 'failed',
      message: 'Repository not found'
    })
    expect(mocks.toastError).not.toHaveBeenCalled()
    expect(localClone).not.toHaveBeenCalled()
    expect(onProvisioned).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
  })

  it('retries with the overrides the user edited after the failure', async () => {
    mocks.setupProjectClone.mockRejectedValueOnce(new Error('Host key verification failed'))
    const { result } = renderClone()

    await act(async () => result.current.start(option))
    act(() => result.current.setOverrides({ url: 'https://github.com/acme/app.git' }))
    await act(async () => result.current.retry())

    expect(mocks.setupProjectClone).toHaveBeenCalledTimes(2)
    expect(mocks.setupProjectClone.mock.calls[1][0]).toMatchObject({
      url: 'https://github.com/acme/app.git'
    })
  })

  it('ignores a clone that lands after the user moved to another host', async () => {
    let finish: (value: unknown) => void = () => {}
    mocks.setupProjectClone.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve
      })
    )
    const onProvisioned = vi.fn()
    const { result } = renderClone(onProvisioned)

    act(() => result.current.start(option))
    await act(async () => {
      result.current.clear()
    })
    await act(async () => {
      finish({ setup: { id: 'setup-new' } })
    })

    // Why: retargeting the composer here would move a selection the user has since changed.
    expect(onProvisioned).not.toHaveBeenCalled()
    expect(result.current.status.kind).toBe('idle')
  })
})
