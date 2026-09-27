// @vitest-environment happy-dom

import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import type { FolderWorkspace } from '../../../../shared/folder-workspace-types'
import type { RuntimeFileListState } from '@/components/quick-open-file-list'
import { useFileExplorerNameFilter } from './use-file-explorer-name-filter'

const useRuntimeFileListForWorktreeMock = vi.hoisted(() => vi.fn())
const acquireLeaseMock = vi.hoisted(() => vi.fn())
const releaseLeaseMock = vi.hoisted(() => vi.fn())
const initialAppState = useAppStore.getInitialState()

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
    acquireLeaseMock.mockReset().mockResolvedValue({ leaseId: 'lease-1' })
    releaseLeaseMock.mockReset().mockResolvedValue(undefined)
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        fs: {
          acquireQuickOpenPathInventoryLease: acquireLeaseMock,
          releaseQuickOpenPathInventoryLease: releaseLeaseMock
        }
      }
    })
    useAppStore.setState(initialAppState, true)
    useAppStore.setState({ activeWorktreeId: 'worktree-1' })
  })

  afterEach(() => {
    cleanup()
    Reflect.deleteProperty(window, 'api')
  })

  it('acquires a local Files-view lease with an empty query without opening Quick Open', async () => {
    const workspace: FolderWorkspace = {
      id: 'lease-folder',
      projectGroupId: 'lease-group',
      name: 'Lease folder',
      folderPath: '/workspace/lease-folder',
      linkedTask: null,
      comment: '',
      isArchived: false,
      isUnread: false,
      isPinned: false,
      sortOrder: 0,
      lastActivityAt: 0,
      createdAt: 0,
      updatedAt: 0
    }
    useAppStore.setState({
      activeWorktreeId: 'folder:lease-folder',
      folderWorkspaces: [workspace],
      projectGroups: [],
      repos: [],
      worktreesByRepo: {}
    })

    const { rerender, unmount } = renderHook(
      ({ active }) =>
        useFileExplorerNameFilter({
          isFilesViewActive: active,
          activeWorktreeId: 'folder:lease-folder'
        }),
      { initialProps: { active: true } }
    )
    await act(async () => {
      await Promise.resolve()
    })

    expect(acquireLeaseMock).toHaveBeenCalledWith(
      expect.objectContaining({
        rootPath: '/workspace/lease-folder',
        includeIgnoredFiles: true
      })
    )
    expect(useRuntimeFileListForWorktreeMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ enabled: false, query: '' })
    )

    rerender({ active: false })
    expect(releaseLeaseMock).toHaveBeenCalledWith({ leaseId: 'lease-1' })
    unmount()
  })

  it('does not acquire a local inventory lease for a remote Files-view owner', () => {
    const workspace: FolderWorkspace = {
      id: 'remote-folder',
      projectGroupId: 'remote-group',
      name: 'Remote folder',
      folderPath: '/remote/repo',
      connectionId: 'ssh-target',
      linkedTask: null,
      comment: '',
      isArchived: false,
      isUnread: false,
      isPinned: false,
      sortOrder: 0,
      lastActivityAt: 0,
      createdAt: 0,
      updatedAt: 0
    }
    useAppStore.setState({
      activeWorktreeId: 'folder:remote-folder',
      folderWorkspaces: [workspace],
      projectGroups: [],
      repos: [],
      worktreesByRepo: {}
    })

    renderHook(() =>
      useFileExplorerNameFilter({
        isFilesViewActive: true,
        activeWorktreeId: 'folder:remote-folder'
      })
    )

    expect(acquireLeaseMock).not.toHaveBeenCalled()
  })

  it('does not acquire a local index for a runtime-owned Files view', () => {
    const workspace: FolderWorkspace = {
      id: 'runtime-folder',
      projectGroupId: 'runtime-group',
      name: 'Runtime folder',
      folderPath: '/runtime/repo',
      executionHostId: 'runtime:runtime-1',
      linkedTask: null,
      comment: '',
      isArchived: false,
      isUnread: false,
      isPinned: false,
      sortOrder: 0,
      lastActivityAt: 0,
      createdAt: 0,
      updatedAt: 0
    }
    useAppStore.setState({
      activeWorktreeId: 'folder:runtime-folder',
      folderWorkspaces: [workspace],
      projectGroups: [],
      repos: [],
      worktreesByRepo: {}
    })

    renderHook(() =>
      useFileExplorerNameFilter({
        isFilesViewActive: true,
        activeWorktreeId: 'folder:runtime-folder'
      })
    )

    expect(acquireLeaseMock).not.toHaveBeenCalled()
  })

  it('passes the active filename query to the runtime path search', () => {
    const { result } = renderHook(() =>
      useFileExplorerNameFilter({ isFilesViewActive: true, activeWorktreeId: 'worktree-1' })
    )

    act(() => result.current.setNameFilterQuery('AppDelegate.swift'))

    expect(useRuntimeFileListForWorktreeMock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        enabled: true,
        worktreeId: 'worktree-1',
        query: 'AppDelegate.swift',
        // Why: substring-AND over a bounded page is this pane's filter contract.
        queryMode: 'name-filter',
        queryLimit: 5_000,
        hostFilterWhenCapped: true,
        // Why: the scan scope must match what the tree shows.
        includeIgnoredFiles: true,
        includeDotfiles: true,
        queryInputAt: expect.any(Number)
      })
    )
    expect(result.current.nameFilterSource?.query).toBe('AppDelegate.swift')
  })

  it('keeps an explicitly previous page while the replacement query is pending', () => {
    useRuntimeFileListForWorktreeMock.mockReturnValue({
      files: ['src/old-target.ts'],
      loading: false,
      searching: true,
      previousResults: true,
      resultQuery: 'old',
      loadError: null
    } satisfies RuntimeFileListState)
    const { result } = renderHook(() =>
      useFileExplorerNameFilter({ isFilesViewActive: true, activeWorktreeId: 'worktree-1' })
    )

    act(() => result.current.setNameFilterQuery('new'))

    expect(result.current.nameFilterSource).toMatchObject({
      query: 'old',
      previousResults: true,
      searching: true,
      relativePaths: ['src/old-target.ts']
    })
  })

  it('returns to ordinary browsing immediately when the query is cleared', () => {
    const { result } = renderHook(() =>
      useFileExplorerNameFilter({ isFilesViewActive: true, activeWorktreeId: 'worktree-1' })
    )

    act(() => result.current.setNameFilterQuery('target'))
    act(() => result.current.setNameFilterQuery(''))

    expect(result.current.hasNameFilter).toBe(false)
    expect(result.current.nameFilterSource).toBeNull()
    expect(useRuntimeFileListForWorktreeMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ enabled: false, query: '' })
    )
  })

  it('can ask the host to retain a smaller page after projection budget pressure', () => {
    const { result } = renderHook(() =>
      useFileExplorerNameFilter({ isFilesViewActive: true, activeWorktreeId: 'worktree-1' })
    )

    act(() => result.current.reduceNameFilterPageLimit())

    expect(useRuntimeFileListForWorktreeMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ queryLimit: 2_500 })
    )
  })

  it('sends the active dotfile visibility setting as part of the search scope', () => {
    useAppStore.setState({ showDotfilesByWorktree: { 'worktree-1': false } })
    const { result } = renderHook(() =>
      useFileExplorerNameFilter({ isFilesViewActive: true, activeWorktreeId: 'worktree-1' })
    )

    act(() => result.current.setNameFilterQuery('target'))

    expect(useRuntimeFileListForWorktreeMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ includeDotfiles: false })
    )
  })

  it('projects the settled listing for the active query', () => {
    useRuntimeFileListForWorktreeMock.mockReturnValue({
      files: ['package.json', 'src/main.ts'],
      loading: false,
      loadError: null
    } satisfies RuntimeFileListState)

    const { result } = renderHook(() =>
      useFileExplorerNameFilter({ isFilesViewActive: true, activeWorktreeId: 'worktree-1' })
    )

    act(() => result.current.setNameFilterQuery('package.'))

    expect(result.current.nameFilterSource?.relativePaths).toEqual(['package.json', 'src/main.ts'])
  })

  it('filters a local full listing that no query produced', () => {
    useRuntimeFileListForWorktreeMock.mockReturnValue({
      files: ['src/a/b/drover.eve_schema'],
      loading: false,
      loadError: null
    })
    const { result } = renderHook(() =>
      useFileExplorerNameFilter({ isFilesViewActive: true, activeWorktreeId: 'worktree-1' })
    )

    act(() => result.current.setNameFilterQuery('drover.eve'))

    expect(result.current.nameFilterSource?.relativePaths).toEqual(['src/a/b/drover.eve_schema'])
  })

  it('asks the host for a bounded substring-AND page instead of a truncated listing', () => {
    const { result } = renderHook(() =>
      useFileExplorerNameFilter({ isFilesViewActive: true, activeWorktreeId: 'worktree-1' })
    )

    act(() => result.current.setNameFilterQuery('drover.eve'))

    expect(useRuntimeFileListForWorktreeMock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        enabled: true,
        worktreeId: 'worktree-1',
        query: 'drover.eve',
        queryMode: 'name-filter',
        queryLimit: 5_000,
        hostFilterWhenCapped: true,
        includeIgnoredFiles: true,
        includeDotfiles: true,
        queryInputAt: expect.any(Number)
      })
    )
  })

  it('carries the host-classified ignored subset so the pane need not re-ask git', () => {
    useRuntimeFileListForWorktreeMock.mockReturnValue({
      files: ['ignored/a.ts', 'src/b.ts'],
      loading: false,
      loadError: null,
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

  it('reports an unsettled source while the listing loads', () => {
    useRuntimeFileListForWorktreeMock.mockReturnValue({
      files: [],
      loading: true,
      searching: true,
      loadError: null
    } satisfies RuntimeFileListState)

    const { result } = renderHook(() =>
      useFileExplorerNameFilter({ isFilesViewActive: true, activeWorktreeId: 'worktree-1' })
    )

    act(() => result.current.setNameFilterQuery('package.'))

    expect(result.current.nameFilterSource?.relativePaths).toBeNull()
  })
})
