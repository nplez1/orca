// @vitest-environment happy-dom

import { act, createElement, useEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FolderWorkspace } from '../../../shared/folder-workspace-types'
import type { FilePathSearchResult } from '../../../shared/file-path-search-result'
import type { ProjectGroup } from '../../../shared/project-group-types'
import { folderWorkspaceKey } from '../../../shared/workspace-scope'
import { QUICK_OPEN_LISTING_MAX_RESULTS } from '../../../shared/quick-open-listing-limits'
import { useAppStore } from '@/store'
import { useRuntimeFileListForWorktree, type RuntimeFileListState } from './quick-open-file-list'

const listRuntimeFilesMock = vi.hoisted(() => vi.fn())
const searchFilePathsMock = vi.hoisted(() => vi.fn())

vi.mock('@/runtime/runtime-file-client', () => ({
  listRuntimeFiles: listRuntimeFilesMock,
  cancelRuntimeFileList: vi.fn(),
  searchRuntimeFilePaths: vi.fn()
}))

const initialAppState = useAppStore.getInitialState()
const roots: Root[] = []

function makeProjectGroup(): ProjectGroup {
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
    updatedAt: 1
  }
}

function makeFolderWorkspace(): FolderWorkspace {
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
    updatedAt: 1
  }
}

/** A reply the renderer accepts: it echoes the consumer fence the local search sent. */
function makeStructuredLocalNameFilterResult(
  query: string,
  consumerId: string,
  consumerSequence: number,
  files: string[]
): FilePathSearchResult {
  const scope = {
    pathSet: 'all' as const,
    includeDotfiles: true,
    includeIgnoredFiles: true,
    excludePathSegments: []
  }
  return {
    files,
    totalCount: files.length,
    truncated: false,
    workspacePathSearch: {
      requestIdentity: {
        query,
        consumer: { consumerId, sequence: consumerSequence },
        owner: {
          executionHost: { provider: 'local', incarnationId: 'local-process-1' },
          authorizedCanonicalRoot: '/srv/platform'
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
      rowClassificationFlags: files.map(() => 0),
      retainedCount: files.length,
      state: {
        coverage: 'complete',
        freshness: 'no-known-gap',
        countProvenance: 'exact-snapshot',
        searchComplete: true
      },
      count: { value: files.length, provenance: 'exact-snapshot' }
    }
  }
}

type ProbeProps = {
  enabled: boolean
  onState: (state: RuntimeFileListState) => void
  query?: string
  hostFilterWhenCapped?: boolean
  worktreeId: string | null
}

function HookProbe({ onState, ...args }: ProbeProps): null {
  const state = useRuntimeFileListForWorktree({
    ...args,
    queryMode: 'name-filter',
    queryLimit: 5_000
  })
  useEffect(() => {
    onState(state)
  })
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

async function renderProbe(args: ProbeProps): Promise<Root> {
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

/** Types a query into an already-mounted probe. */
async function typeQuery(root: Root, args: ProbeProps, query: string): Promise<void> {
  await act(async () => {
    root.render(createElement(HookProbe, { ...args, query }))
  })
  await act(async () => vi.advanceTimersByTimeAsync(16))
  await flushEffects()
}

beforeEach(() => {
  useAppStore.setState(initialAppState, true)
  listRuntimeFilesMock.mockReset().mockResolvedValue(['packages/app/package.json'])
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

describe('useRuntimeFileListForWorktree host name filter', () => {
  it('answers a name filter in a capped local workspace from the host search', async () => {
    vi.useFakeTimers()
    useAppStore.setState({
      folderWorkspaces: [makeFolderWorkspace()],
      projectGroups: [makeProjectGroup()],
      repos: [],
      worktreesByRepo: {}
    })
    listRuntimeFilesMock.mockResolvedValue(
      Array.from({ length: QUICK_OPEN_LISTING_MAX_RESULTS }, (_, i) => `src/file-${i}.ts`)
    )
    searchFilePathsMock.mockImplementation(
      (args: { query: string; consumerId: string; consumerSequence: number }) =>
        makeStructuredLocalNameFilterResult(args.query, args.consumerId, args.consumerSequence, [
          'ios/AppDelegate.swift'
        ])
    )
    const states: RuntimeFileListState[] = []
    const probeArgs: ProbeProps = {
      enabled: true,
      onState: (state) => states.push(state),
      hostFilterWhenCapped: true,
      worktreeId: folderWorkspaceKey('folder-workspace-1')
    }

    try {
      const root = await renderProbe({ ...probeArgs, query: '' })
      await waitForListRuntimeFilesCall()
      expect(states.at(-1)?.truncated).toBe(true)

      await typeQuery(root, probeArgs, 'AppDelegate')

      // Why: the match sits past the listing cap, so only the host scan can find it.
      expect(searchFilePathsMock).toHaveBeenCalledWith(
        expect.objectContaining({ query: 'AppDelegate', mode: 'name-filter', limit: 5_000 })
      )
      expect(states.at(-1)).toMatchObject({
        files: ['ios/AppDelegate.swift'],
        loading: false,
        truncated: false
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('never re-lists a capped local page with the filter applied', async () => {
    vi.useFakeTimers()
    useAppStore.setState({
      folderWorkspaces: [makeFolderWorkspace()],
      projectGroups: [makeProjectGroup()],
      repos: [],
      worktreesByRepo: {}
    })
    listRuntimeFilesMock.mockResolvedValue(
      Array.from({ length: QUICK_OPEN_LISTING_MAX_RESULTS }, (_, i) => `src/file-${i}.ts`)
    )
    searchFilePathsMock.mockResolvedValue({
      files: ['packages/app/package.json'],
      totalCount: 1,
      truncated: false
    })
    const probeArgs: ProbeProps = {
      enabled: true,
      onState: () => {},
      hostFilterWhenCapped: true,
      worktreeId: folderWorkspaceKey('folder-workspace-1')
    }

    try {
      const root = await renderProbe({ ...probeArgs, query: '' })
      await waitForListRuntimeFilesCall()

      await typeQuery(root, probeArgs, 'package')

      expect(searchFilePathsMock).toHaveBeenCalledTimes(1)
      // Why: re-listing the capped page with the filter applied is the mechanism this replaces.
      expect(listRuntimeFilesMock).toHaveBeenCalledTimes(1)
      expect(listRuntimeFilesMock.mock.calls[0]?.[1]).not.toHaveProperty('nameFilter')
    } finally {
      vi.useRealTimers()
    }
  })

  it('reports a failed host name filter instead of the capped page', async () => {
    vi.useFakeTimers()
    useAppStore.setState({
      folderWorkspaces: [makeFolderWorkspace()],
      projectGroups: [makeProjectGroup()],
      repos: [],
      worktreesByRepo: {}
    })
    const capped = Array.from({ length: QUICK_OPEN_LISTING_MAX_RESULTS }, (_, i) => `f-${i}.ts`)
    listRuntimeFilesMock.mockResolvedValue(capped)
    searchFilePathsMock.mockRejectedValue(new Error('rg list timed out'))
    const states: RuntimeFileListState[] = []
    const probeArgs: ProbeProps = {
      enabled: true,
      onState: (state) => states.push(state),
      hostFilterWhenCapped: true,
      worktreeId: folderWorkspaceKey('folder-workspace-1')
    }

    try {
      const root = await renderProbe({ ...probeArgs, query: '' })
      await waitForListRuntimeFilesCall()

      await typeQuery(root, probeArgs, 'f-1')

      expect(states.at(-1)?.loadError).toBe('rg list timed out')
    } finally {
      vi.useRealTimers()
    }
  })
})
