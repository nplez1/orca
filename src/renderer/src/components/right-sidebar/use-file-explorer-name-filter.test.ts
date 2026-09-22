// @vitest-environment happy-dom

import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import type { RuntimeFileListState } from '@/components/quick-open-file-list'
import { useFileExplorerNameFilter } from './use-file-explorer-name-filter'

const useRuntimeFileListForWorktreeMock = vi.hoisted(() => vi.fn())

vi.mock('@/components/quick-open-file-list', () => ({
  useRuntimeFileListForWorktree: useRuntimeFileListForWorktreeMock
}))

const emptyState: RuntimeFileListState = {
  files: [],
  loading: false,
  loadError: null
}

describe('useFileExplorerNameFilter', () => {
  beforeEach(() => {
    useRuntimeFileListForWorktreeMock.mockReset().mockReturnValue(emptyState)
    useAppStore.setState({ activeWorktreeId: 'worktree-1' })
  })

  afterEach(() => {
    cleanup()
  })

  it('passes the active filename query to the runtime path search', () => {
    const { result } = renderHook(() =>
      useFileExplorerNameFilter({ isFilesViewActive: true, activeWorktreeId: 'worktree-1' })
    )

    act(() => result.current.setNameFilterQuery('AppDelegate.swift'))

    expect(useRuntimeFileListForWorktreeMock).toHaveBeenLastCalledWith({
      enabled: true,
      worktreeId: 'worktree-1',
      query: 'AppDelegate.swift',
      // Why: substring-AND over a bounded page is this pane's filter contract.
      queryMode: 'name-filter',
      queryLimit: 5_000,
      // Why: the scan scope must match what the tree shows.
      includeIgnoredFiles: true
    })
    expect(result.current.nameFilterSource?.query).toBe('AppDelegate.swift')
  })

  it('filters a local full listing that no query produced', () => {
    useRuntimeFileListForWorktreeMock.mockReturnValue({
      files: ['src/a/b/drover.eve_schema'],
      loading: false,
      loadError: null,
      resolvedQuery: undefined
    })
    const { result } = renderHook(() =>
      useFileExplorerNameFilter({ isFilesViewActive: true, activeWorktreeId: 'worktree-1' })
    )

    act(() => result.current.setNameFilterQuery('drover.eve'))

    expect(result.current.nameFilterSource?.relativePaths).toEqual(['src/a/b/drover.eve_schema'])
  })

  it('fences a listing produced by a different query', () => {
    useRuntimeFileListForWorktreeMock.mockReturnValue({
      files: ['src/a/b/drover.eve_schema'],
      loading: false,
      loadError: null,
      resolvedQuery: 'drover'
    })
    const { result } = renderHook(() =>
      useFileExplorerNameFilter({ isFilesViewActive: true, activeWorktreeId: 'worktree-1' })
    )

    act(() => result.current.setNameFilterQuery('drover.eve'))

    expect(result.current.nameFilterSource?.relativePaths).toEqual([])
  })

  it('asks the host for a bounded substring-AND page instead of a truncated listing', () => {
    const { result } = renderHook(() =>
      useFileExplorerNameFilter({ isFilesViewActive: true, activeWorktreeId: 'worktree-1' })
    )

    act(() => result.current.setNameFilterQuery('drover.eve'))

    expect(useRuntimeFileListForWorktreeMock).toHaveBeenLastCalledWith({
      enabled: true,
      worktreeId: 'worktree-1',
      query: 'drover.eve',
      queryMode: 'name-filter',
      queryLimit: 5_000,
      includeIgnoredFiles: true
    })
  })

  it('carries the host-classified ignored subset so the pane need not re-ask git', () => {
    useRuntimeFileListForWorktreeMock.mockReturnValue({
      files: ['ignored/a.ts', 'src/b.ts'],
      loading: false,
      loadError: null,
      resolvedQuery: 'a.ts',
      totalCount: 2,
      truncated: false,
      ignoredFiles: ['ignored/a.ts']
    } satisfies RuntimeFileListState)
    const { result } = renderHook(() =>
      useFileExplorerNameFilter({ isFilesViewActive: true, activeWorktreeId: 'worktree-1' })
    )

    act(() => result.current.setNameFilterQuery('a.ts'))

    expect(result.current.nameFilterSource?.ignoredRelativePaths).toEqual(['ignored/a.ts'])
  })

  it('reports an exact match count and a partial page to the pane', () => {
    useRuntimeFileListForWorktreeMock.mockReturnValue({
      files: ['src/a/b/drover.eve_schema'],
      loading: false,
      loadError: null,
      resolvedQuery: 'drover.eve',
      totalCount: 182_311,
      truncated: true
    } satisfies RuntimeFileListState)
    const { result } = renderHook(() =>
      useFileExplorerNameFilter({ isFilesViewActive: true, activeWorktreeId: 'worktree-1' })
    )

    act(() => result.current.setNameFilterQuery('drover.eve'))

    expect(result.current.nameFilterSource).toMatchObject({
      totalCount: 182_311,
      truncated: true
    })
  })

  it('withholds paths while the query that produced them is still settling', () => {
    useRuntimeFileListForWorktreeMock.mockReturnValue({
      files: ['src/a/b/drover.eve_schema'],
      loading: true,
      loadError: null,
      resolvedQuery: null
    })
    const { result } = renderHook(() =>
      useFileExplorerNameFilter({ isFilesViewActive: true, activeWorktreeId: 'worktree-1' })
    )

    act(() => result.current.setNameFilterQuery('drover.eve'))

    expect(result.current.nameFilterSource?.relativePaths).toBeNull()
  })
})
