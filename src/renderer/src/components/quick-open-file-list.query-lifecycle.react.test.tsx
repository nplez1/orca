// @vitest-environment happy-dom

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FolderWorkspace } from '../../../shared/folder-workspace-types'
import type { ProjectGroup } from '../../../shared/project-group-types'
import type { Worktree } from '../../../shared/worktree/types'
import { folderWorkspaceKey } from '../../../shared/workspace-scope'
import type { FilePathSearchResult } from '../../../shared/file-path-search-result'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import { useRuntimeFileListForWorktree, type RuntimeFileListState } from './quick-open-file-list'

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
const roots: Root[] = []

function makeStructuredNameFilterResult(
  query: string,
  correlationId: string,
  includeDotfiles = true
): FilePathSearchResult {
  const scope = {
    pathSet: 'all' as const,
    includeDotfiles,
    includeIgnoredFiles: true,
    excludePathSegments: []
  }
  const files = ['src/target.ts']
  return {
    files,
    totalCount: 1,
    truncated: false,
    workspacePathSearch: {
      requestIdentity: {
        query,
        consumer: { consumerId: correlationId, sequence: 1 },
        owner: {
          executionHost: { provider: 'runtime', incarnationId: 'environment:env-1' },
          authorizedCanonicalRoot: '/srv/remote'
        },
        generationId: null,
        mode: 'name-filter',
        scope,
        pageBudget: { maxPaths: 5_000, maxSerializedBytes: 100_000 }
      },
      generationId: 'generation-1',
      scopeFingerprint: JSON.stringify(scope),
      scopeRuleVersion: 'live-path-search-v1',
      rows: files.map((relativePath) => ({ relativePath })),
      rowClassificationFlags: [0],
      retainedCount: 1,
      state: {
        coverage: 'complete',
        freshness: 'no-known-gap',
        countProvenance: 'exact-snapshot',
        searchComplete: true
      },
      count: { value: 1, provenance: 'exact-snapshot' }
    }
  }
}

function makeStructuredLocalNameFilterResult(
  query: string,
  consumerId: string,
  sequence: number,
  maxPaths = 5_000,
  totalCount = 1
): FilePathSearchResult {
  const result = makeStructuredNameFilterResult(query, 'unused-consumer')
  const response = result.workspacePathSearch
  if (!response) {
    throw new Error('Structured test response was not created')
  }
  return {
    ...result,
    workspacePathSearch: {
      ...response,
      requestIdentity: {
        ...response.requestIdentity,
        consumer: { consumerId, sequence },
        owner: {
          executionHost: { provider: 'local', incarnationId: 'local-process-1' },
          authorizedCanonicalRoot: '/srv/platform'
        },
        pageBudget: { ...response.requestIdentity.pageBudget, maxPaths }
      },
      state: {
        coverage: 'complete',
        freshness: 'no-known-gap',
        countProvenance: 'exact-snapshot',
        searchComplete: true
      },
      count: { value: totalCount, provenance: 'exact-snapshot' }
    },
    totalCount,
    truncated: totalCount > response.retainedCount
  }
}

function makeProjectGroup(overrides: Partial<ProjectGroup> = {}): ProjectGroup {
  return {
    id: 'group-1',
    name: 'Platform',
    parentPath: '/srv/platform',
    connectionId: null,
    parentGroupId: null,
    createdFrom: 'folder-scan',
    tabOrder: 0,
    isCollapsed: false,
    color: null,
    createdAt: 1,
    updatedAt: 1,
    ...overrides
  }
}

function makeFolderWorkspace(overrides: Partial<FolderWorkspace> = {}): FolderWorkspace {
  return {
    id: 'folder-workspace-1',
    projectGroupId: 'group-1',
    name: 'Platform workspace',
    folderPath: '/srv/platform',
    connectionId: null,
    linkedTask: null,
    comment: '',
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 1,
    lastActivityAt: 0,
    createdAt: 1,
    updatedAt: 1,
    ...overrides
  }
}

function makeRemoteWorktree(): Worktree {
  return {
    id: 'wt-remote',
    repoId: 'repo-remote',
    hostId: 'runtime:env-1',
    runtimeOwnerEnvironmentId: 'env-1',
    path: '/srv/remote',
    head: 'abc123',
    branch: 'refs/heads/main',
    isBare: false,
    isMainWorktree: true,
    displayName: 'Remote',
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0
  }
}

function seedRemoteWorktree(): void {
  useAppStore.setState({
    settings: { ...initialAppState.settings, activeRuntimeEnvironmentId: 'env-1' },
    repos: [],
    worktreesByRepo: { 'repo-remote': [makeRemoteWorktree()] }
  } as Partial<AppState>)
}

function HookProbe({
  enabled,
  onState,
  query,
  queryMode,
  queryLimit,
  worktreeId
}: {
  enabled: boolean
  onState: (state: RuntimeFileListState) => void
  query?: string
  queryMode?: 'quick-open' | 'name-filter'
  queryLimit?: number
  worktreeId: string | null
}): null {
  onState(useRuntimeFileListForWorktree({ enabled, worktreeId, query, queryMode, queryLimit }))
  return null
}

async function flushEffects(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

async function waitForListRuntimeFilesCall(): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await flushEffects()
    if (listRuntimeFilesMock.mock.calls.length > 0) {
      return
    }
  }
  throw new Error('listRuntimeFiles was not called')
}

async function renderProbe(args: {
  enabled: boolean
  onState: (state: RuntimeFileListState) => void
  query?: string
  queryMode?: 'quick-open' | 'name-filter'
  queryLimit?: number
  worktreeId: string | null
}): Promise<Root> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push(root)
  await act(async () => {
    root.render(createElement(HookProbe, args))
  })
  await flushEffects()
  return root
}

beforeEach(() => {
  useAppStore.setState(initialAppState, true)
  listRuntimeFilesMock.mockReset().mockResolvedValue(['packages/app/package.json'])
  cancelRuntimeFileListMock.mockReset()
  searchRuntimeFilePathsMock.mockReset().mockResolvedValue({ files: [], truncated: false })
  searchFilePathsMock.mockReset().mockResolvedValue({ files: [], truncated: false })
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { fs: { searchFilePaths: searchFilePathsMock } }
  })
})

afterEach(async () => {
  for (const root of roots) {
    await act(async () => {
      root.unmount()
    })
  }
  roots.length = 0
  Reflect.deleteProperty(window, 'api')
  useAppStore.setState(initialAppState, true)
})

describe('useRuntimeFileListForWorktree query lifecycle', () => {
  it('labels the previous remote page while the replacement query is pending', async () => {
    vi.useFakeTimers()
    seedRemoteWorktree()
    const states: RuntimeFileListState[] = []
    let resolveReplacement!: (value: { files: string[]; truncated: boolean }) => void
    searchRuntimeFilePathsMock
      .mockResolvedValueOnce({
        files: ['src/tar.ts'],
        totalCount: 1,
        truncated: true
      })
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveReplacement = resolve
          })
      )

    try {
      const root = await renderProbe({
        enabled: true,
        onState: (state) => states.push(state),
        query: 'tar',
        queryMode: 'name-filter',
        worktreeId: 'wt-remote'
      })
      await act(async () => vi.advanceTimersByTimeAsync(16))
      await flushEffects()
      expect(states.at(-1)).toMatchObject({ files: ['src/tar.ts'], truncated: true })

      const rendersBeforeChange = states.length
      await act(async () => {
        root.render(
          createElement(HookProbe, {
            enabled: true,
            onState: (state: RuntimeFileListState) => states.push(state),
            query: 'target',
            queryMode: 'name-filter',
            worktreeId: 'wt-remote'
          })
        )
      })

      expect(states.length).toBeGreaterThan(rendersBeforeChange)
      for (const state of states.slice(rendersBeforeChange)) {
        expect(state).toMatchObject({
          files: ['src/tar.ts'],
          previousResults: true,
          resultQuery: 'tar',
          searching: true,
          loading: false,
          truncated: false,
          totalCount: null
        })
      }
      await act(async () => vi.advanceTimersByTimeAsync(16))
      await act(async () => vi.advanceTimersByTimeAsync(100))
      expect(states.at(-1)).toMatchObject({
        previousResults: true,
        searching: true,
        loading: false
      })
      await act(async () => {
        resolveReplacement({ files: ['src/target.ts'], truncated: false })
        await Promise.resolve()
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('reports the new remote query as loading after the previous one failed', async () => {
    vi.useFakeTimers()
    seedRemoteWorktree()
    const states: RuntimeFileListState[] = []
    let resolveRetry!: (value: { files: string[]; truncated: boolean }) => void
    searchRuntimeFilePathsMock
      .mockRejectedValueOnce(new Error('scan failed'))
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveRetry = resolve
          })
      )

    try {
      const root = await renderProbe({
        enabled: true,
        onState: (state) => states.push(state),
        query: 'tar',
        worktreeId: 'wt-remote'
      })
      await act(async () => vi.advanceTimersByTimeAsync(16))
      await flushEffects()
      expect(states.at(-1)).toMatchObject({ files: [], loading: false, loadError: 'scan failed' })

      const rendersBeforeChange = states.length
      await act(async () => {
        root.render(
          createElement(HookProbe, {
            enabled: true,
            onState: (state: RuntimeFileListState) => states.push(state),
            query: 'target',
            worktreeId: 'wt-remote'
          })
        )
      })

      expect(states.length).toBeGreaterThan(rendersBeforeChange)
      for (const state of states.slice(rendersBeforeChange)) {
        expect(state).toMatchObject({ files: [], searching: true, loading: false })
      }
      await act(async () => vi.advanceTimersByTimeAsync(16))
      await act(async () => vi.advanceTimersByTimeAsync(100))
      expect(states.at(-1)?.loading).toBe(true)
      await act(async () => {
        resolveRetry({ files: ['src/target.ts'], truncated: false })
        await Promise.resolve()
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('passes and matches the renderer consumer sequence for local structured responses', async () => {
    const workspaceKey = folderWorkspaceKey('folder-workspace-1')
    useAppStore.setState({
      folderWorkspaces: [makeFolderWorkspace()],
      projectGroups: [makeProjectGroup()],
      repos: [],
      worktreesByRepo: {}
    } as Partial<AppState>)
    vi.useFakeTimers()
    const states: RuntimeFileListState[] = []
    searchFilePathsMock.mockImplementation((args) =>
      makeStructuredLocalNameFilterResult(args.query, args.consumerId, args.consumerSequence)
    )

    try {
      await renderProbe({
        enabled: true,
        onState: (state) => states.push(state),
        query: 'target',
        queryMode: 'name-filter',
        queryLimit: 5_000,
        worktreeId: workspaceKey
      })
      await act(async () => vi.advanceTimersByTimeAsync(16))
      await flushEffects()

      expect(searchFilePathsMock).toHaveBeenCalledWith(
        expect.objectContaining({ consumerId: expect.any(String), consumerSequence: 1 })
      )
      const sentRequest = searchFilePathsMock.mock.calls[0]?.[0]
      expect(states.at(-1)?.workspacePathSearch?.requestIdentity.consumer).toEqual({
        consumerId: sentRequest.consumerId,
        sequence: sentRequest.consumerSequence
      })
      expect(states.at(-1)).toMatchObject({ files: ['src/target.ts'], totalCount: 1 })
    } finally {
      vi.useRealTimers()
    }
  })

  it('rejects a local structured response that does not echo the renderer consumer fence', async () => {
    const workspaceKey = folderWorkspaceKey('folder-workspace-1')
    useAppStore.setState({
      folderWorkspaces: [makeFolderWorkspace()],
      projectGroups: [makeProjectGroup()],
      repos: [],
      worktreesByRepo: {}
    } as Partial<AppState>)
    vi.useFakeTimers()
    const states: RuntimeFileListState[] = []
    searchFilePathsMock.mockImplementation((args) =>
      makeStructuredLocalNameFilterResult(args.query, 'different-renderer', 9)
    )

    try {
      await renderProbe({
        enabled: true,
        onState: (state) => states.push(state),
        query: 'target',
        queryMode: 'name-filter',
        queryLimit: 5_000,
        worktreeId: workspaceKey
      })
      await act(async () => vi.advanceTimersByTimeAsync(16))
      await flushEffects()

      expect(states.at(-1)).toMatchObject({
        files: [],
        loadError: 'The file search response did not match the current workspace request.'
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('preserves the host exact total when a projection-budget retry requests a smaller page', async () => {
    const workspaceKey = folderWorkspaceKey('folder-workspace-1')
    useAppStore.setState({
      folderWorkspaces: [makeFolderWorkspace()],
      projectGroups: [makeProjectGroup()],
      repos: [],
      worktreesByRepo: {}
    } as Partial<AppState>)
    vi.useFakeTimers()
    const states: RuntimeFileListState[] = []
    searchFilePathsMock.mockImplementation((args) =>
      makeStructuredLocalNameFilterResult(
        args.query,
        args.consumerId,
        args.consumerSequence,
        args.limit,
        10_000
      )
    )

    try {
      const root = await renderProbe({
        enabled: true,
        onState: (state) => states.push(state),
        query: 'target',
        queryMode: 'name-filter',
        queryLimit: 5_000,
        worktreeId: workspaceKey
      })
      await act(async () => vi.advanceTimersByTimeAsync(16))
      await flushEffects()

      expect(states.at(-1)).toMatchObject({
        totalCount: 10_000,
        truncated: true,
        workspacePathSearch: { count: { value: 10_000 }, retainedCount: 1 }
      })

      await act(async () => {
        root.render(
          createElement(HookProbe, {
            enabled: true,
            onState: (state) => states.push(state),
            query: 'target',
            queryMode: 'name-filter',
            queryLimit: 2_500,
            worktreeId: workspaceKey
          })
        )
      })
      await act(async () => vi.advanceTimersByTimeAsync(16))
      await flushEffects()

      expect(searchFilePathsMock).toHaveBeenCalledTimes(2)
      expect(searchFilePathsMock.mock.calls[1]?.[0]).toMatchObject({ limit: 2_500 })
      expect(states.at(-1)).toMatchObject({
        totalCount: 10_000,
        truncated: true,
        workspacePathSearch: {
          requestIdentity: { pageBudget: { maxPaths: 2_500 } },
          count: { value: 10_000 },
          retainedCount: 1
        }
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('searches local files by query with host-applied visibility scope', async () => {
    const workspaceKey = folderWorkspaceKey('folder-workspace-1')
    useAppStore.setState({
      folderWorkspaces: [makeFolderWorkspace()],
      projectGroups: [makeProjectGroup()],
      repos: [],
      worktreesByRepo: {}
    } as Partial<AppState>)
    vi.useFakeTimers()
    const states: RuntimeFileListState[] = []
    searchFilePathsMock.mockResolvedValue({
      files: ['src/a/b/drover.eve_schema'],
      totalCount: 1,
      truncated: false
    })

    try {
      await renderProbe({
        enabled: true,
        onState: (state) => states.push(state),
        query: 'drover.eve',
        queryMode: 'name-filter',
        queryLimit: 5_000,
        worktreeId: workspaceKey
      })
      await act(async () => vi.advanceTimersByTimeAsync(16))
      await flushEffects()

      expect(listRuntimeFilesMock).not.toHaveBeenCalled()
      expect(searchFilePathsMock).toHaveBeenCalledWith(
        expect.objectContaining({
          rootPath: '/srv/platform',
          query: 'drover.eve',
          limit: 5_000,
          mode: 'name-filter',
          includeDotfiles: true,
          correlationId: expect.any(String)
        })
      )
      expect(states.at(-1)).toMatchObject({
        files: ['src/a/b/drover.eve_schema'],
        totalCount: 1,
        truncated: false
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps the unscoped local listing while the query is empty', async () => {
    const workspaceKey = folderWorkspaceKey('folder-workspace-1')
    useAppStore.setState({
      folderWorkspaces: [makeFolderWorkspace()],
      projectGroups: [makeProjectGroup()],
      repos: [],
      worktreesByRepo: {}
    } as Partial<AppState>)
    const states: RuntimeFileListState[] = []

    await renderProbe({
      enabled: true,
      onState: (state) => states.push(state),
      query: '',
      worktreeId: workspaceKey
    })
    await waitForListRuntimeFilesCall()
    await flushEffects()
    expect(states.at(-1)?.files).toEqual(['packages/app/package.json'])

    expect(searchRuntimeFilePathsMock).not.toHaveBeenCalled()
  })

  it('repeats a local query search instead of filtering one listing', async () => {
    const workspaceKey = folderWorkspaceKey('folder-workspace-1')
    useAppStore.setState({
      folderWorkspaces: [makeFolderWorkspace()],
      projectGroups: [makeProjectGroup()],
      repos: [],
      worktreesByRepo: {}
    } as Partial<AppState>)
    vi.useFakeTimers()

    try {
      const root = await renderProbe({
        enabled: true,
        onState: () => {},
        query: 'one',
        worktreeId: workspaceKey
      })
      await act(async () => vi.advanceTimersByTimeAsync(16))
      await flushEffects()

      await act(async () => {
        root.render(
          createElement(HookProbe, {
            enabled: true,
            onState: () => {},
            query: 'two',
            worktreeId: workspaceKey
          })
        )
      })
      await act(async () => vi.advanceTimersByTimeAsync(16))
      await flushEffects()

      expect(listRuntimeFilesMock).not.toHaveBeenCalled()
      expect(searchRuntimeFilePathsMock).toHaveBeenCalledTimes(2)
      expect(searchRuntimeFilePathsMock).toHaveBeenLastCalledWith(
        expect.anything(),
        expect.objectContaining({ query: 'two' })
      )
    } finally {
      vi.useRealTimers()
    }
  })
})
