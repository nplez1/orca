// @vitest-environment happy-dom

import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { makeWorktree } from '@/store/slices/worktrees-slice-test-fixtures'
import type { PRCheckDetail } from '../../../../../shared/github/check-types'
import type * as GitLabReviewClient from './gitlab-review-client'

const poller = vi.hoisted<{
  install: Mock<() => void>
  run: null | (() => Promise<void> | void)
  getDelayMs: null | (() => number | null)
  cleanup: Mock<() => void>
}>(() => ({
  install: vi.fn(),
  run: null,
  getDelayMs: null,
  cleanup: vi.fn()
}))
const gitlab = vi.hoisted(() => ({ fetchDetails: vi.fn() }))

vi.mock('@/lib/window-visibility-timeout-poller', () => ({
  installWindowVisibilityTimeoutPoller: vi.fn(
    (config: { run: () => Promise<void> | void; getDelayMs: () => number | null }) => {
      poller.run = config.run
      poller.getDelayMs = config.getDelayMs
      poller.install()
      return Object.assign(poller.cleanup, { refresh: vi.fn() })
    }
  )
}))
vi.mock('./gitlab-review-client', async (importOriginal) => {
  const original = await importOriginal<typeof GitLabReviewClient>()
  return { ...original, fetchGitLabMRDetailsForChecks: gitlab.fetchDetails }
})

import { useChecksPanelPolling, type ChecksPanelPollingInput } from './use-checks-panel-polling'

import { createModel } from './checks-panel-polling-test-model'

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(1_000_000)
  poller.install.mockReset()
  poller.cleanup.mockReset()
  poller.run = null
  poller.getDelayMs = null
  gitlab.fetchDetails.mockReset().mockResolvedValue({
    item: { projectRef: null },
    pipelineJobs: [],
    comments: []
  })
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('useChecksPanelPolling live behavior', () => {
  it('gates installation by panel visibility and cleans the active poller', () => {
    const model = createModel({ isPanelVisible: false })
    const hook = renderHook(({ input }) => useChecksPanelPolling(input), {
      initialProps: { input: model }
    })

    expect(poller.install).not.toHaveBeenCalled()

    hook.rerender({ input: { ...model, isPanelVisible: true } })
    expect(poller.install).toHaveBeenCalledOnce()
    // Nothing has been read yet for this panel, so the first attempt is due immediately.
    expect(poller.getDelayMs?.()).toBe(0)

    hook.rerender({ input: { ...model, isPanelVisible: false } })
    expect(poller.cleanup).toHaveBeenCalledOnce()
  })

  it.each([
    ['open', 'success', 60_000],
    ['open', 'pending', 10_000],
    ['draft', 'neutral', 60_000],
    ['merged', 'success', null],
    ['merged', 'pending', 60_000],
    ['closed', 'success', 15 * 60_000]
  ] as const)('paces %s checks with %s status', async (state, checksStatus, interval) => {
    const model = createModel()
    renderHook(() =>
      useChecksPanelPolling({
        ...model,
        pr: model.pr ? { ...model.pr, state, checksStatus } : null
      })
    )
    await act(async () => poller.run?.())
    expect(poller.getDelayMs?.()).toBe(interval)
  })

  it('keeps an unfinished run on the focused loop, easing off while its rows do not move', async () => {
    const model = createModel()
    renderHook(() => useChecksPanelPolling(model))

    await act(async () => poller.run?.())
    expect(model.pollIntervalRef.current).toBe(60_000)
    // Why: the settled backoff is 60s and the failure backoff is longer still; a live run is what
    // someone is watching, so neither may stretch it.
    expect(poller.getDelayMs?.()).toBe(10_000)
    vi.setSystemTime(Date.now() + 10_000)
    await act(async () => poller.run?.())
    expect(model.pollIntervalRef.current).toBe(120_000)
    // The mock answers identically each read, so this is the stuck-run shape.
    expect(poller.getDelayMs?.()).toBe(20_000)
  })

  it('lets a settled review keep the unchanged-details backoff', async () => {
    const model = createModel()
    renderHook(() =>
      useChecksPanelPolling({
        ...model,
        pr: model.pr ? { ...model.pr, checksStatus: 'success' } : null
      })
    )

    await act(async () => poller.run?.())
    expect(poller.getDelayMs?.()).toBe(60_000)
    vi.setSystemTime(Date.now() + 60_000)
    await act(async () => poller.run?.())
    expect(model.pollIntervalRef.current).toBe(120_000)
    expect(poller.getDelayMs?.()).toBe(120_000)
  })

  it('never reschedules a skipped attempt at zero or infinity, and still lands the force', async () => {
    const model = createModel()
    const mergedPR: ChecksPanelPollingInput['pr'] = model.pr
      ? { ...model.pr, state: 'merged', checksStatus: 'success' }
      : null
    const fetch = vi.fn().mockResolvedValue([])
    model.fetchPRChecks = fetch
    const hook = renderHook(({ input }) => useChecksPanelPolling(input), {
      initialProps: { input: { ...model, pr: mergedPR } }
    })

    await act(async () => poller.run?.())
    expect(fetch).toHaveBeenCalledOnce()
    expect(poller.getDelayMs?.()).toBe(null)
    // A pending flip arms a force whose cooldown ends before the merged cadence would.
    vi.setSystemTime(Date.now() + 1_000)
    hook.rerender({
      input: { ...model, pr: mergedPR ? { ...mergedPR, checksStatus: 'pending' } : null }
    })
    for (let i = 0; i < 8; i++) {
      const step = 1_000
      vi.setSystemTime(Date.now() + step)
      const before = fetch.mock.calls.length
      await act(async () => poller.run?.())
      if (fetch.mock.calls.length === before) {
        // Why: a 0 here re-arms the poller immediately and Infinity is clamped to the same 0ms.
        const delay = poller.getDelayMs?.()
        expect(delay).not.toBe(0)
        expect(Number.isFinite(delay ?? Infinity)).toBe(true)
      }
    }
    // The cooldown is up, so the forced read lands instead of waiting out the 60s cadence.
    vi.setSystemTime(Date.now() + 1_000)
    await act(async () => poller.run?.())
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(fetch).toHaveBeenLastCalledWith(
      '/workspace/repo',
      42,
      'main',
      'head-1',
      model.pr?.prRepo,
      expect.objectContaining({ force: true })
    )
  })

  it('does not schedule against a request that is already running', async () => {
    const model = createModel()
    let finish: (checks: PRCheckDetail[]) => void = () => {}
    const fetch = vi.fn(() => new Promise<PRCheckDetail[]>((resolve) => (finish = resolve)))
    model.fetchPRChecks = fetch
    const hook = renderHook(({ input }) => useChecksPanelPolling(input), {
      initialProps: { input: model }
    })
    await act(async () => {
      void poller.run?.()
    })
    expect(fetch).toHaveBeenCalledOnce()
    // Reopening reinstalls the poller while the read is still out. A delay here — Infinity included —
    // is clamped to 0ms by the browser, so the panel would spin for as long as the request runs.
    hook.rerender({ input: { ...model, isPanelVisible: false } })
    hook.rerender({ input: { ...model, isPanelVisible: true } })
    await act(async () => poller.run?.())
    expect(poller.getDelayMs?.()).toBe(null)
    expect(fetch).toHaveBeenCalledOnce()
    await act(async () => finish([]))
  })

  it('clears the loading state when a foreground read overlaps a scheduled one', async () => {
    const model = createModel({
      activeGitLabReview: {
        provider: 'gitlab',
        number: 17,
        headSha: 'head',
        title: 'MR',
        state: 'open',
        url: '',
        status: 'pending',
        updatedAt: '',
        mergeable: 'UNKNOWN'
      }
    })
    const resolvers: ((value: unknown) => void)[] = []
    gitlab.fetchDetails.mockImplementation(() => new Promise((resolve) => resolvers.push(resolve)))
    const { result } = renderHook(() => useChecksPanelPolling(model))
    await act(async () => {
      void poller.run?.()
    })
    await act(async () =>
      resolvers[0]?.({ item: { projectRef: null }, pipelineJobs: [], comments: [] })
    )
    // A foreground pass takes the loading state; a scheduled poll then starts beside it.
    const foreground = result.current.fetchGitLabDetails()
    await act(() => Promise.resolve())
    vi.setSystemTime(Date.now() + 10_000)
    await act(async () => {
      void poller.run?.()
    })
    expect(gitlab.fetchDetails).toHaveBeenCalledTimes(3)
    await act(async () =>
      resolvers[1]?.({ item: { projectRef: null }, pipelineJobs: [], comments: [] })
    )
    await act(async () => foreground)
    await act(async () =>
      resolvers[2]?.({ item: { projectRef: null }, pipelineJobs: [], comments: [] })
    )
    // Why: the scheduled read must not claim the generation the foreground read has to clear.
    expect(model.setCommentsLoading).toHaveBeenLastCalledWith(false)
    expect(model.setChecksLoading).toHaveBeenLastCalledWith(false)
  })

  it('does not flash the loading state on a scheduled refresh', async () => {
    const model = createModel()
    renderHook(() => useChecksPanelPolling(model))

    await act(async () => poller.run?.())
    expect(model.setChecksLoading).toHaveBeenCalledWith(true)
    vi.mocked(model.setChecksLoading).mockClear()
    vi.setSystemTime(Date.now() + 10_000)
    await act(async () => poller.run?.())
    // Why: rows are already on screen; flipping loading blanks counts and disables buttons.
    expect(model.setChecksLoading).not.toHaveBeenCalled()
  })

  it('does not flash the comment loading state on a scheduled MR refresh', async () => {
    const model = createModel({
      activeGitLabReview: {
        provider: 'gitlab',
        number: 17,
        headSha: 'head',
        title: 'MR',
        state: 'open',
        url: '',
        status: 'pending',
        updatedAt: '',
        mergeable: 'UNKNOWN'
      }
    })
    renderHook(() => useChecksPanelPolling(model))

    await act(async () => poller.run?.())
    expect(model.setCommentsLoading).toHaveBeenCalledWith(true)
    vi.mocked(model.setCommentsLoading).mockClear()
    vi.setSystemTime(Date.now() + 10_000)
    await act(async () => poller.run?.())
    // Why: every tick would otherwise disable the comment-send buttons for the whole request.
    expect(model.setCommentsLoading).not.toHaveBeenCalled()
  })

  it('lets the read that opens the panel start a stopped WSL distro, but not later polls (E9)', async () => {
    const model = createModel()
    const hook = renderHook(({ input }) => useChecksPanelPolling(input), {
      initialProps: { input: model }
    })
    const wakes = (): unknown[] =>
      vi.mocked(model.fetchPRChecks).mock.calls.map((call) => call[5]?.wakeWslDistro)

    await act(async () => poller.run?.())
    vi.setSystemTime(Date.now() + 60_000)
    await act(async () => poller.run?.())
    expect(wakes()).toEqual([true, undefined])

    hook.rerender({ input: { ...model, isPanelVisible: false } })
    hook.rerender({ input: model })
    vi.setSystemTime(Date.now() + 15 * 60_000)
    await act(async () => poller.run?.())
    expect(wakes()).toEqual([true, undefined, true])
  })

  it('reads a picked review without passing this worktree branch', async () => {
    const model = createModel({ prNumber: 9, showsPickedReview: true })
    const hook = renderHook(({ input }) => useChecksPanelPolling(input), {
      initialProps: { input: model }
    })

    await act(async () => poller.run?.())

    // Why no branch: it is what the store writes a PR's check status onto, and this branch's cached
    // PR is a different review.
    expect(vi.mocked(model.fetchPRChecks).mock.calls[0]?.[2]).toBeUndefined()
    // Why not retracted: that refresh error belongs to this branch's PR, and a successful read of
    // another review says nothing about it.
    expect(model.retractStalePRRefreshError).not.toHaveBeenCalled()
    hook.unmount()
  })

  it('polls GitLab MR details in the background after the opening read (E9)', async () => {
    const model = createModel({
      activeGitLabReview: {
        provider: 'gitlab',
        number: 17,
        headSha: 'gitlab-head',
        title: 'MR',
        state: 'open',
        url: '',
        status: 'pending',
        updatedAt: '',
        mergeable: 'UNKNOWN'
      }
    })
    renderHook(() => useChecksPanelPolling(model))

    await act(async () => poller.run?.())
    vi.setSystemTime(Date.now() + 60_000)
    await act(async () => poller.run?.())

    expect(gitlab.fetchDetails.mock.calls.map((call) => call[0].background)).toEqual([false, true])
  })

  it('selects the GitLab adapter without calling the GitHub checks provider', async () => {
    const model = createModel({
      activeGitLabReview: {
        provider: 'gitlab',
        number: 17,
        headSha: 'gitlab-head',
        title: 'MR',
        state: 'open',
        url: '',
        status: 'pending',
        updatedAt: '',
        mergeable: 'UNKNOWN'
      }
    })
    renderHook(() => useChecksPanelPolling(model))

    await act(async () => poller.run?.())

    expect(gitlab.fetchDetails).toHaveBeenCalledOnce()
    expect(model.fetchPRChecks).not.toHaveBeenCalled()
  })

  it('uses the workspace owner and missing head override for a replacement MR', async () => {
    const model = createModel({
      activeGitLabReview: {
        provider: 'gitlab',
        number: 17,
        headSha: 'old-head',
        title: 'MR',
        state: 'open',
        url: '',
        status: 'pending',
        updatedAt: '',
        mergeable: 'UNKNOWN'
      },
      activeWorktree: makeWorktree({
        id: 'worktree-1',
        repoId: 'repo-1',
        hostId: 'runtime:owner-runtime'
      })
    })
    const { result } = renderHook(() => useChecksPanelPolling(model))

    await act(async () =>
      result.current.fetchGitLabDetails({
        mrNumberOverride: 18,
        headShaOverride: null,
        commitAsCurrent: true
      })
    )

    expect(gitlab.fetchDetails).toHaveBeenCalledWith(
      expect.objectContaining({ iid: 18, repoOwnerExecutionHostId: 'runtime:owner-runtime' })
    )
    expect(model.asyncResultKeyRef.current).toContain('::18::none')
    expect(model.asyncResultKeyRef.current).not.toContain('old-head')
  })

  it('reports a failed MR read as an error naming the machine, not as no checks (#24264)', async () => {
    gitlab.fetchDetails.mockRejectedValue(new Error('glab: not logged in'))
    const model = createModel({
      activeGitLabReview: {
        provider: 'gitlab',
        number: 17,
        headSha: 'head',
        title: 'MR',
        state: 'open',
        url: '',
        status: 'pending',
        updatedAt: '',
        mergeable: 'UNKNOWN'
      },
      activeWorktree: makeWorktree({ id: 'worktree-1', repoId: 'repo-1', hostId: 'ssh:devbox' })
    })
    renderHook(() => useChecksPanelPolling(model))

    await act(async () => poller.run?.())

    const message = 'Could not load from this computer: glab: not logged in'
    expect(model.setChecksError).toHaveBeenCalledWith(message)
    expect(model.setCommentsError).toHaveBeenCalledWith(message)
    // Later resets would clear the error; only the scope reset may precede it.
    const setChecks = vi.mocked(model.setChecks).mock
    const setChecksError = vi.mocked(model.setChecksError).mock
    expect(Math.max(0, ...setChecks.invocationCallOrder)).toBeLessThan(
      setChecksError.invocationCallOrder[0]
    )
  })

  it('retracts a refresh error an earlier read predates, and only on a read that lands', async () => {
    const model = createModel()
    renderHook(() => useChecksPanelPolling(model))

    await act(async () => poller.run?.())

    expect(model.retractStalePRRefreshError).toHaveBeenCalledExactlyOnceWith('cache', 1_000_000)

    vi.mocked(model.retractStalePRRefreshError).mockClear()
    vi.mocked(model.fetchPRChecks).mockRejectedValueOnce(new Error('gh: 502'))
    vi.setSystemTime(2_000_000)
    await act(async () => poller.run?.())

    expect(model.retractStalePRRefreshError).not.toHaveBeenCalled()
  })

  it('drops replacement MR details when the relink scope changes in flight', async () => {
    let resolveDetails!: (value: {
      item: { projectRef: null }
      pipelineJobs: PRCheckDetail[]
      comments: []
    }) => void
    gitlab.fetchDetails.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveDetails = resolve
      })
    )
    let requestCurrent = true
    const model = createModel()
    const { result } = renderHook(() => useChecksPanelPolling(model))

    const request = result.current.fetchGitLabDetails({
      mrNumberOverride: 18,
      commitAsCurrent: true,
      isRequestCurrent: () => requestCurrent
    })
    await act(() => Promise.resolve())
    requestCurrent = false
    resolveDetails({
      item: { projectRef: null },
      pipelineJobs: [],
      comments: []
    })
    await act(async () => request)

    expect(model.setChecks).toHaveBeenCalledExactlyOnceWith([])
    expect(model.setComments).toHaveBeenCalledExactlyOnceWith([])
    expect(model.setChecksLoading).toHaveBeenLastCalledWith(false)
    expect(model.setCommentsLoading).toHaveBeenLastCalledWith(false)
  })

  it('keeps loading owned by the newest replacement MR details request', async () => {
    const detailsResolvers: ((value: {
      item: { projectRef: null }
      pipelineJobs: []
      comments: []
    }) => void)[] = []
    gitlab.fetchDetails.mockImplementation(
      () =>
        new Promise((resolve) => {
          detailsResolvers.push(resolve)
        })
    )
    let firstRequestCurrent = true
    const model = createModel()
    const { result } = renderHook(() => useChecksPanelPolling(model))

    const firstRequest = result.current.fetchGitLabDetails({
      mrNumberOverride: 18,
      commitAsCurrent: true,
      isRequestCurrent: () => firstRequestCurrent
    })
    await act(() => Promise.resolve())
    firstRequestCurrent = false
    const secondRequest = result.current.fetchGitLabDetails({
      mrNumberOverride: 18,
      commitAsCurrent: true
    })
    await act(() => Promise.resolve())

    detailsResolvers[0]?.({ item: { projectRef: null }, pipelineJobs: [], comments: [] })
    await act(async () => firstRequest)
    expect(model.setChecksLoading).not.toHaveBeenCalledWith(false)
    expect(model.setCommentsLoading).not.toHaveBeenCalledWith(false)

    detailsResolvers[1]?.({ item: { projectRef: null }, pipelineJobs: [], comments: [] })
    await act(async () => secondRequest)
    expect(model.setChecksLoading).toHaveBeenLastCalledWith(false)
    expect(model.setCommentsLoading).toHaveBeenLastCalledWith(false)
  })
})
