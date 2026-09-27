// @vitest-environment happy-dom

import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import { useFileExplorerVisibleRowProjection } from './useFileExplorerVisibleRowProjection'
import { FILE_EXPLORER_IGNORED_QUERY_DEBOUNCE_MS } from './use-file-explorer-ignored-paths'

const getRuntimeGitIgnoredPathsMock = vi.hoisted(() => vi.fn())
vi.mock('@/runtime/runtime-git-client', () => ({
  getRuntimeGitIgnoredPaths: getRuntimeGitIgnoredPathsMock
}))

const initialAppState = useAppStore.getInitialState()
const relativePaths = Array.from({ length: 100 }, (_, index) => `src/generated-${index}.ts`)

function useProjection(query: string) {
  return useFileExplorerVisibleRowProjection('worktree-1', '/repo', {}, new Set(), true, true, {
    query,
    relativePaths
  })
}

/** A fresh object per call: a wave-batched refresh commits a new dirCache identity per wave. */
function treeDirCache() {
  return {
    '/repo': {
      children: [
        {
          name: 'src',
          path: '/repo/src',
          relativePath: 'src',
          isDirectory: true,
          depth: 0
        }
      ]
    }
  }
}

function useTreeProjection(dirCache = treeDirCache()) {
  return useFileExplorerVisibleRowProjection(
    'worktree-1',
    '/repo',
    dirCache,
    new Set(),
    true,
    true,
    null
  )
}

describe('file explorer ignored-path query debounce', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    getRuntimeGitIgnoredPathsMock.mockReset().mockResolvedValue([])
    useAppStore.setState(initialAppState, true)
    useAppStore.setState({
      settings: { activeRuntimeEnvironmentId: null } as AppState['settings']
    })
  })

  afterEach(() => {
    cleanup()
    useAppStore.setState(initialAppState, true)
    vi.useRealTimers()
  })

  it('coalesces a broad typing burst into one final ignored-path request', async () => {
    const hook = renderHook(({ query }) => useProjection(query), {
      initialProps: { query: 's' }
    })

    await act(async () => vi.advanceTimersByTimeAsync(100))
    hook.rerender({ query: 'sr' })
    await act(async () => vi.advanceTimersByTimeAsync(100))
    hook.rerender({ query: 'src' })

    await act(async () => vi.advanceTimersByTimeAsync(FILE_EXPLORER_IGNORED_QUERY_DEBOUNCE_MS - 1))
    expect(getRuntimeGitIgnoredPathsMock).not.toHaveBeenCalled()

    await act(async () => vi.advanceTimersByTimeAsync(1))
    expect(getRuntimeGitIgnoredPathsMock).toHaveBeenCalledTimes(1)
    expect(getRuntimeGitIgnoredPathsMock.mock.calls[0]?.[1]).toHaveLength(relativePaths.length)
  })

  it('cancels the pending ignored-path request when the explorer unmounts', async () => {
    const hook = renderHook(() => useProjection('src'))
    hook.unmount()

    await act(async () => vi.advanceTimersByTimeAsync(FILE_EXPLORER_IGNORED_QUERY_DEBOUNCE_MS))
    expect(getRuntimeGitIgnoredPathsMock).not.toHaveBeenCalled()
  })

  it('keeps ordinary expanded-tree ignored checks immediate', () => {
    renderHook(() => useTreeProjection())

    expect(getRuntimeGitIgnoredPathsMock).toHaveBeenCalledTimes(1)
    expect(getRuntimeGitIgnoredPathsMock.mock.calls[0]?.[1]).toEqual(['src'])
  })

  it('commits a chunked projection only after the complete synthetic tree is ready', async () => {
    const paths = Array.from({ length: 150 }, (_, index) => `root/dir-${index}/target-${index}.ts`)
    const nameFilter = { query: 'target', relativePaths: paths, ignoredRelativePaths: [] }
    const hook = renderHook(() =>
      useFileExplorerVisibleRowProjection(
        'worktree-1',
        '/repo',
        {},
        new Set(),
        true,
        true,
        nameFilter
      )
    )

    expect(hook.result.current.projectionPending).toBe(true)
    expect(hook.result.current.rowProjection.getVisibleCount()).toBe(0)

    await act(async () => vi.runAllTimersAsync())

    expect(hook.result.current.projectionPending).toBe(false)
    expect(hook.result.current.rowProjection.getVisibleCount()).toBe(301)
  })

  it('reuses an unchanged filtered projection across unrelated browse-cache refreshes', () => {
    const nameFilter = {
      query: 'target',
      relativePaths: ['src/target.ts'],
      ignoredRelativePaths: []
    }
    const hook = renderHook(
      ({ dirCache }) =>
        useFileExplorerVisibleRowProjection(
          'worktree-1',
          '/repo',
          dirCache,
          new Set(),
          true,
          true,
          nameFilter
        ),
      { initialProps: { dirCache: treeDirCache() } }
    )
    const originalProjection = hook.result.current.rowProjection

    hook.rerender({ dirCache: treeDirCache() })

    expect(hook.result.current.rowProjection).toBe(originalProjection)
  })

  it('does not re-issue the ignored check for a dirCache commit that changes no path', () => {
    // A wave-batched tree refresh commits a fresh dirCache object per wave. The
    // ignored query is an uncancellable remote git check-ignore over the whole
    // visible tree, so identical contents must not re-issue it.
    const hook = renderHook(({ dirCache }) => useTreeProjection(dirCache), {
      initialProps: { dirCache: treeDirCache() }
    })
    expect(getRuntimeGitIgnoredPathsMock).toHaveBeenCalledTimes(1)

    hook.rerender({ dirCache: treeDirCache() })
    hook.rerender({ dirCache: treeDirCache() })

    expect(getRuntimeGitIgnoredPathsMock).toHaveBeenCalledTimes(1)
  })
})
