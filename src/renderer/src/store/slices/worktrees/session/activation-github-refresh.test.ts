import { beforeEach, describe, expect, it, vi } from 'vitest'

const scheduleAfterInputQuietMock = vi.hoisted(() => vi.fn())
const shouldDeferActivationTerminalPrepMock = vi.hoisted(() => vi.fn())

vi.mock('@/lib/input-quiet-scheduler', () => ({
  scheduleAfterInputQuiet: scheduleAfterInputQuietMock
}))

vi.mock('./activation-terminal-prep', () => ({
  shouldDeferActivationTerminalPrep: shouldDeferActivationTerminalPrepMock
}))

import { refreshGitHubAfterWorktreeActivation } from './activation-github-refresh'

describe('refreshGitHubAfterWorktreeActivation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    shouldDeferActivationTerminalPrepMock.mockReturnValue(true)
  })

  it('waits for the interactive activation turn before refreshing provider data', () => {
    const refreshGitHubForWorktreeIfStale = vi.fn()
    let activeWorktreeId: string | null = 'workspace-a'
    let scheduledCallback: (() => void) | undefined
    scheduleAfterInputQuietMock.mockImplementation((callback: () => void) => {
      scheduledCallback = callback
      return vi.fn()
    })

    refreshGitHubAfterWorktreeActivation(
      () => ({ activeWorktreeId, refreshGitHubForWorktreeIfStale }),
      'workspace-a'
    )

    expect(refreshGitHubForWorktreeIfStale).not.toHaveBeenCalled()
    expect(scheduleAfterInputQuietMock).toHaveBeenCalledWith(expect.any(Function), {
      delayMs: 300,
      quietMs: 450,
      idleTimeoutMs: 180
    })

    scheduledCallback?.()

    expect(refreshGitHubForWorktreeIfStale).toHaveBeenCalledWith('workspace-a')
    activeWorktreeId = null
  })

  it('cancels an obsolete refresh when the user switches again', () => {
    const refreshGitHubForWorktreeIfStale = vi.fn()
    let activeWorktreeId: string | null = 'workspace-a'
    const callbacks: (() => void)[] = []
    const cancellations: ReturnType<typeof vi.fn>[] = []
    scheduleAfterInputQuietMock.mockImplementation((callback: () => void) => {
      callbacks.push(callback)
      const cancel = vi.fn()
      cancellations.push(cancel)
      return cancel
    })

    refreshGitHubAfterWorktreeActivation(
      () => ({ activeWorktreeId, refreshGitHubForWorktreeIfStale }),
      'workspace-a'
    )
    activeWorktreeId = 'workspace-b'
    refreshGitHubAfterWorktreeActivation(
      () => ({ activeWorktreeId, refreshGitHubForWorktreeIfStale }),
      'workspace-b'
    )

    expect(cancellations[0]).toHaveBeenCalledOnce()

    callbacks[0]()
    callbacks[1]()

    expect(refreshGitHubForWorktreeIfStale).toHaveBeenCalledTimes(1)
    expect(refreshGitHubForWorktreeIfStale).toHaveBeenCalledWith('workspace-b')
  })

  it('does not let a canceled callback clear a newer refresh', () => {
    const refreshGitHubForWorktreeIfStale = vi.fn()
    let activeWorktreeId: string | null = 'workspace-a'
    const callbacks: (() => void)[] = []
    const cancellations: ReturnType<typeof vi.fn>[] = []
    scheduleAfterInputQuietMock.mockImplementation((callback: () => void) => {
      callbacks.push(callback)
      const cancel = vi.fn()
      cancellations.push(cancel)
      return cancel
    })

    refreshGitHubAfterWorktreeActivation(
      () => ({ activeWorktreeId, refreshGitHubForWorktreeIfStale }),
      'workspace-a'
    )
    activeWorktreeId = 'workspace-b'
    refreshGitHubAfterWorktreeActivation(
      () => ({ activeWorktreeId, refreshGitHubForWorktreeIfStale }),
      'workspace-b'
    )
    callbacks[0]()
    activeWorktreeId = 'workspace-c'
    refreshGitHubAfterWorktreeActivation(
      () => ({ activeWorktreeId, refreshGitHubForWorktreeIfStale }),
      'workspace-c'
    )

    expect(cancellations[1]).toHaveBeenCalledOnce()

    callbacks[1]()
    callbacks[2]()

    expect(refreshGitHubForWorktreeIfStale).toHaveBeenCalledTimes(1)
    expect(refreshGitHubForWorktreeIfStale).toHaveBeenCalledWith('workspace-c')
  })

  it('keeps synchronous activation refreshes in test and non-renderer environments', () => {
    const refreshGitHubForWorktreeIfStale = vi.fn()
    shouldDeferActivationTerminalPrepMock.mockReturnValue(false)

    refreshGitHubAfterWorktreeActivation(
      () => ({ activeWorktreeId: 'workspace-a', refreshGitHubForWorktreeIfStale }),
      'workspace-a'
    )

    expect(refreshGitHubForWorktreeIfStale).toHaveBeenCalledWith('workspace-a')
    expect(scheduleAfterInputQuietMock).not.toHaveBeenCalled()
  })
})
