// @vitest-environment happy-dom
//
// Why this file exists separately from use-file-explorer-name-filter.test.ts: that suite mocks
// useRuntimeFileListForWorktree, so it can only assert the name filter against a hand-written
// RuntimeFileListState. #21423 shipped a P0 through exactly that gap — the mock encoded a result
// shape local workspaces never produce, and the filter discarded every local result. These specs
// mock only the IPC boundary so the filter runs against the answer the hook really returns.
//
// Why the local specs assert a host answer: a local name filter is served by the execution host's
// worker-owned path index, so the hook no longer narrows a capped browse listing in the renderer.
// The invariants #21423 and #22369 established still hold — a local query's answer is projected
// rather than dropped, and one query at a time is ever shown as current.

import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FolderWorkspace } from '../../../../shared/folder-workspace-types'
import type { ProjectGroup } from '../../../../shared/project-group-types'
import { folderWorkspaceKey } from '../../../../shared/workspace-scope'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import { useFileExplorerNameFilter } from './use-file-explorer-name-filter'

const listRuntimeFilesMock = vi.hoisted(() => vi.fn())
const cancelRuntimeFileListMock = vi.hoisted(() => vi.fn())
const searchRuntimeFilePathsMock = vi.hoisted(() => vi.fn())
const searchFilePathsMock = vi.hoisted(() => vi.fn())

vi.mock('@/runtime/runtime-file-client', () => ({
  listRuntimeFiles: listRuntimeFilesMock,
  cancelRuntimeFileList: cancelRuntimeFileListMock,
  searchRuntimeFilePaths: searchRuntimeFilePathsMock
}))

const initialAppState = useAppStore.getInitialState()
const LOCAL_KEY = folderWorkspaceKey('local-workspace')
const REMOTE_KEY = folderWorkspaceKey('remote-workspace')

function projectGroup(id: string, parentPath: string, connectionId: string | null): ProjectGroup {
  return {
    id,
    name: id,
    parentPath,
    connectionId,
    parentGroupId: null,
    createdFrom: 'folder-scan',
    tabOrder: 0,
    isCollapsed: false,
    color: null,
    createdAt: 1,
    updatedAt: 1
  }
}

function folderWorkspace(
  id: string,
  projectGroupId: string,
  folderPath: string,
  connectionId: string | null
): FolderWorkspace {
  return {
    id,
    projectGroupId,
    name: id,
    folderPath,
    connectionId,
    linkedTask: null,
    comment: '',
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 1,
    lastActivityAt: 0,
    createdAt: 1,
    updatedAt: 1
  }
}

function seedWorkspaces(): void {
  const workspaces: Partial<AppState> = {
    folderWorkspaces: [
      folderWorkspace('local-workspace', 'local-group', '/local/proj', null),
      folderWorkspace('remote-workspace', 'remote-group', '/srv/remote', 'ssh-1')
    ],
    projectGroups: [
      projectGroup('local-group', '/local/proj', null),
      projectGroup('remote-group', '/srv/remote', 'ssh-1')
    ],
    repos: [],
    worktreesByRepo: {}
  }
  useAppStore.setState(workspaces)
}

/** Drain the request/settle microtask chain well past any intermediate render. */
async function settle(): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    await act(async () => {
      await Promise.resolve()
    })
  }
}

/** The scheduler dispatches on the next animation frame, so a typed query needs a frame tick. */
async function advanceToDispatch(): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(16)
  })
  await settle()
}

function renderNameFilter(activeWorktreeId: string) {
  return renderHook(() => useFileExplorerNameFilter({ isFilesViewActive: true, activeWorktreeId }))
}

beforeEach(() => {
  useAppStore.setState(initialAppState, true)
  listRuntimeFilesMock.mockReset().mockResolvedValue(['packages/app/package.json', 'src/main.ts'])
  cancelRuntimeFileListMock.mockReset()
  searchRuntimeFilePathsMock.mockReset().mockResolvedValue({ files: [], truncated: false })
  searchFilePathsMock.mockReset().mockResolvedValue({ files: [], truncated: false })
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { fs: { searchFilePaths: searchFilePathsMock } }
  })
  seedWorkspaces()
})

afterEach(() => {
  cleanup()
  Reflect.deleteProperty(window, 'api')
  useAppStore.setState(initialAppState, true)
})

describe('useFileExplorerNameFilter over the real runtime listing', () => {
  // #21423 regression: the filter must never discard the answer a local workspace produces.
  it('projects a settled local answer instead of dropping it', async () => {
    vi.useFakeTimers()
    searchFilePathsMock.mockResolvedValue({
      files: ['packages/app/package.json'],
      totalCount: 1,
      truncated: false
    })
    try {
      const { result } = renderNameFilter(LOCAL_KEY)

      await act(async () => {
        result.current.setNameFilterQuery('package.')
      })
      await advanceToDispatch()

      expect(searchFilePathsMock).toHaveBeenCalledTimes(1)
      expect(searchFilePathsMock.mock.calls[0]?.[0]).toMatchObject({
        query: 'package.',
        mode: 'name-filter'
      })
      expect(result.current.nameFilterSource?.relativePaths).toEqual(['packages/app/package.json'])
    } finally {
      vi.useRealTimers()
    }
  })

  it('answers each local query edit from the host without reusing a stale answer', async () => {
    vi.useFakeTimers()
    searchFilePathsMock.mockResolvedValue({
      files: ['packages/app/package.json'],
      totalCount: 1,
      truncated: false
    })
    try {
      const { result } = renderNameFilter(LOCAL_KEY)

      await act(async () => {
        result.current.setNameFilterQuery('pack')
      })
      await advanceToDispatch()

      searchFilePathsMock.mockResolvedValue({
        files: ['packages/app/package.json'],
        totalCount: 1,
        truncated: false
      })
      await act(async () => {
        result.current.setNameFilterQuery('package.json')
      })
      await advanceToDispatch()

      // Why: a new query is a new host request; the pane must not re-serve the first answer.
      expect(searchFilePathsMock.mock.calls.map((call) => call[0]?.query)).toEqual([
        'pack',
        'package.json'
      ])
      expect(result.current.nameFilterSource?.relativePaths).toEqual(['packages/app/package.json'])
    } finally {
      vi.useRealTimers()
    }
  })

  // The host answers one query at a time, so the previous answer must never be shown as the
  // current one — it would name files that do not match what the user typed.
  it('never projects the previous query answer after a remote query edit', async () => {
    vi.useFakeTimers()
    searchFilePathsMock.mockResolvedValue({ files: ['first/hit.ts'], truncated: false })
    const projected: {
      paths: readonly string[] | null | undefined
      previousResults: boolean | undefined
    }[] = []
    try {
      const { result } = renderHook(() => {
        const filter = useFileExplorerNameFilter({
          isFilesViewActive: true,
          activeWorktreeId: REMOTE_KEY
        })
        projected.push({
          paths: filter.nameFilterSource?.relativePaths,
          previousResults: filter.nameFilterSource?.previousResults
        })
        return filter
      })

      await act(async () => {
        result.current.setNameFilterQuery('first')
      })
      await advanceToDispatch()
      expect(result.current.nameFilterSource?.relativePaths).toEqual(['first/hit.ts'])

      searchFilePathsMock.mockResolvedValue({ files: ['second/hit.ts'], truncated: false })
      const rendersBeforeEdit = projected.length
      await act(async () => {
        result.current.setNameFilterQuery('second')
      })

      // Why: the render before the effect restarts the request is the one that can leak. Either
      // the pane shows nothing yet, or it labels the answer as the previous one.
      expect(projected.length).toBeGreaterThan(rendersBeforeEdit)
      for (const render of projected.slice(rendersBeforeEdit)) {
        expect(
          render.paths === null || render.paths === undefined || render.previousResults === true
        ).toBe(true)
      }

      await advanceToDispatch()
      expect(result.current.nameFilterSource?.relativePaths).toEqual(['second/hit.ts'])
    } finally {
      vi.useRealTimers()
    }
  })
})
