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
  toastError: vi.fn(),
  toastWarning: vi.fn()
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

vi.mock('sonner', () => ({
  toast: { error: mocks.toastError, warning: mocks.toastWarning, success: vi.fn() }
}))

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

/** A clone that stays in flight until the test rejects it, so an unmount can land mid-clone. */
function rejectableClone(): (message: string) => void {
  let reject: (error: unknown) => void = () => {}
  mocks.setupProjectClone.mockReturnValue(
    new Promise((_resolve, rejectClone) => {
      reject = rejectClone
    })
  )
  return (message: string) => reject(new Error(message))
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
  mocks.toastWarning.mockReset()
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
    // Why: nothing was cloned, so there is nothing to report either.
    expect(mocks.toastError).not.toHaveBeenCalled()
    expect(mocks.toastWarning).not.toHaveBeenCalled()
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

  it('starts its own clone when the one it joined was abandoned by a closed composer', async () => {
    let releaseProbe: (value: string) => void = () => {}
    mocks.resolveCloneParentForHost.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseProbe = resolve
        })
    )
    const first = renderClone()
    act(() => first.result.current.start(option))
    act(() => first.result.current.clear())
    first.unmount()
    const onProvisioned = vi.fn()
    const second = renderClone(onProvisioned)
    await act(async () => second.result.current.start(option))
    await act(async () => {
      releaseProbe('/home/abandoned')
    })

    // Why: joining a promise the closed composer had abandoned would block Create on a clone
    // nobody runs, so the composer that still wants the host has to clone it itself.
    expect(mocks.setupProjectClone).toHaveBeenCalledTimes(1)
    expect(mocks.setupProjectClone.mock.calls[0][0]).toMatchObject({ hostId: HOST })
    expect(onProvisioned).toHaveBeenCalledWith(JSON.stringify(['setup-new', HOST]), 'cloned')
    expect(second.result.current.status.kind).toBe('idle')
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

  it('toasts a clone that fails after the composer closed, naming the project and host', async () => {
    const rejectClone = rejectableClone()
    const onProvisioned = vi.fn()
    const { result, unmount } = renderClone(onProvisioned)

    await act(async () => result.current.start(option))
    unmount()
    await act(async () => {
      rejectClone("Error invoking remote method 'repo.clone': Error: Repository not found")
    })

    // Why a toast: the row that would have carried this failure no longer exists.
    const [title, options] = mocks.toastError.mock.calls[0]
    expect(mocks.toastError).toHaveBeenCalledTimes(1)
    // Why these two: the user has to be able to tell which project, on which host, failed.
    expect(title).toContain('app')
    expect(title).toContain('Build box')
    expect(options.description).toBe('Repository not found')
    expect(onProvisioned).not.toHaveBeenCalled()
  })

  it('toasts a failure from the host the user moved away from, naming that host', async () => {
    const pending = new Map<string, { reject: (error: unknown) => void }>()
    mocks.setupProjectClone.mockImplementation(
      (args: { hostId: string }) =>
        new Promise((_resolve, reject) => {
          pending.set(args.hostId, { reject })
        })
    )
    const { result } = renderClone()

    await act(async () => result.current.start(option))
    await act(async () => result.current.start(OTHER_HOST))
    await act(async () => {
      pending.get(HOST)?.reject(new Error('Host key verification failed'))
    })

    // Why: the failure belongs to the host that ran it, and the composer now waits on another one.
    const [title, options] = mocks.toastError.mock.calls[0]
    expect(mocks.toastError).toHaveBeenCalledTimes(1)
    expect(title).toContain('Build box')
    expect(options.description).toBe('Host key verification failed')
    expect(result.current.status).toMatchObject({ kind: 'cloning' })
  })

  it('toasts a failure that lands after the user cleared the selection', async () => {
    const rejectClone = rejectableClone()
    const { result } = renderClone()

    await act(async () => result.current.start(option))
    await act(async () => result.current.clear())
    await act(async () => {
      rejectClone('Host key verification failed')
    })

    // Why: the composer can no longer show it, and a silent failure is the bug this fixes.
    const [title, options] = mocks.toastError.mock.calls[0]
    expect(mocks.toastError).toHaveBeenCalledTimes(1)
    expect(title).toContain('Build box')
    expect(options.description).toBe('Host key verification failed')
  })

  it('toasts once when every composer that joined the clone has closed', async () => {
    const rejectClone = rejectableClone()
    const first = renderClone()
    await act(async () => first.result.current.start(option))
    first.unmount()
    const second = renderClone()
    await act(async () => second.result.current.start(option))
    second.unmount()
    await act(async () => {
      rejectClone('Repository not found')
    })

    // Why once: two closed composers dropping one clone is still one failure to report.
    expect(mocks.toastError).toHaveBeenCalledTimes(1)
  })

  it('toasts once when the same host was picked twice and the composer then closed', async () => {
    const rejectClone = rejectableClone()
    const { result, unmount } = renderClone()

    await act(async () => result.current.start(option))
    act(() => result.current.start(option))
    unmount()
    await act(async () => {
      rejectClone('Repository not found')
    })

    expect(mocks.setupProjectClone).toHaveBeenCalledTimes(1)
    expect(mocks.toastError).toHaveBeenCalledTimes(1)
  })

  it('reports a failure a reopened composer joined on its row, not as a toast', async () => {
    const rejectClone = rejectableClone()
    const first = renderClone()
    await act(async () => first.result.current.start(option))
    first.unmount()
    const second = renderClone()
    await act(async () => second.result.current.start(option))
    await act(async () => {
      rejectClone('Repository not found')
    })

    // Why: the reopened composer is where the user is looking, and the row carries Retry.
    expect(second.result.current.status).toMatchObject({
      kind: 'failed',
      message: 'Repository not found'
    })
    expect(mocks.toastError).not.toHaveBeenCalled()
  })

  it('reports a taken folder found after close without calling it a failed clone', async () => {
    let releaseDestination: (value: string) => void = () => {}
    mocks.resolveCloneParentForHost.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseDestination = resolve
        })
    )
    mocks.checkCloneTargetOn.mockResolvedValue({
      status: 'taken',
      folderName: 'app',
      suggestedFolderName: 'app-2',
      reason: 'not-empty'
    })
    const { result, unmount } = renderClone()

    act(() => result.current.start(option))
    unmount()
    await act(async () => {
      releaseDestination(DESTINATION)
    })

    // Why "didn't clone": the folder check runs before anything is cloned, so nothing failed.
    expect(mocks.setupProjectClone).not.toHaveBeenCalled()
    const [title, options] = mocks.toastWarning.mock.calls[0]
    expect(mocks.toastWarning).toHaveBeenCalledTimes(1)
    expect(title).toContain('Build box')
    // Why the path: on a remote host it is the only thing that says where the folder is.
    expect(options.description).toContain('/home/alice/orca/projects/app')
    expect(mocks.toastError).not.toHaveBeenCalled()
  })

  it('stays silent when a clone succeeds after the composer closed', async () => {
    let finish: (value: unknown) => void = () => {}
    mocks.setupProjectClone.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve
      })
    )
    const onProvisioned = vi.fn()
    const { result, unmount } = renderClone(onProvisioned)

    await act(async () => result.current.start(option))
    unmount()
    await act(async () => {
      finish({ setup: { id: 'setup-new' } })
    })

    // Why: the store's own "Project added" toast already says the host is set up.
    expect(mocks.toastError).not.toHaveBeenCalled()
    expect(mocks.toastWarning).not.toHaveBeenCalled()
    expect(onProvisioned).not.toHaveBeenCalled()
  })

  it('leaves "cloned but not added" to the store toast that already reported it', async () => {
    let finish: (value: unknown) => void = () => {}
    mocks.setupProjectClone.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve
      })
    )
    const { result, unmount } = renderClone()

    await act(async () => result.current.start(option))
    unmount()
    await act(async () => {
      finish(null)
    })

    // Why: setupProjectExistingFolder toasts this failure itself, so a second toast is a regression.
    expect(mocks.toastError).not.toHaveBeenCalled()
  })
})
