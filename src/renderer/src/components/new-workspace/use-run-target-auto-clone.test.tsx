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
    const { result } = renderClone()

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
