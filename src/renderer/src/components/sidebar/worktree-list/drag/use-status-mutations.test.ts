// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import type { PublicKnownRuntimeEnvironment } from '../../../../../../shared/remote-runtime/host-catalog/runtime-environments'
import type { Worktree } from '../../../../../../shared/worktree/types'
import { useWorktreeStatusMutations } from './use-status-mutations'

const { toastWarning } = vi.hoisted(() => ({ toastWarning: vi.fn() }))
vi.mock('sonner', () => ({ toast: { warning: toastWarning } }))

function pairedEnvironment(id: string, name: string): PublicKnownRuntimeEnvironment {
  return {
    id,
    name,
    createdAt: 1,
    updatedAt: 1,
    lastUsedAt: null,
    runtimeId: id,
    preferredEndpointId: 'endpoint',
    endpoints: [{ id: 'endpoint', kind: 'websocket', label: id, endpoint: 'ws://host' }]
  }
}

/** One workspace id with a copy on each host, as a paired setup produces. */
function twinCopies(): Worktree[] {
  return [
    {
      id: 'workspace-1',
      repoId: 'repo-1',
      displayName: 'Twin',
      comment: '',
      linkedIssue: null,
      linkedPR: null,
      linkedLinearIssue: null,
      isArchived: false,
      isUnread: false,
      isPinned: false,
      sortOrder: 0,
      lastActivityAt: 0,
      path: '/tmp/twin-studio',
      head: 'head',
      branch: 'twin',
      isBare: false,
      isMainWorktree: false,
      hostId: 'runtime:env-studio',
      workspaceStatus: 'backlog'
    },
    {
      id: 'workspace-1',
      repoId: 'repo-1',
      displayName: 'Twin',
      comment: '',
      linkedIssue: null,
      linkedPR: null,
      linkedLinearIssue: null,
      isArchived: false,
      isUnread: false,
      isPinned: false,
      sortOrder: 0,
      lastActivityAt: 0,
      path: '/tmp/twin-mini',
      head: 'head',
      branch: 'twin',
      isBare: false,
      isMainWorktree: false,
      hostId: 'runtime:env-mini',
      workspaceStatus: 'backlog'
    }
  ]
}

function renderMutations() {
  const updateWorktreesMeta = vi.fn().mockResolvedValue({ ok: true })
  useAppStore.setState({ updateWorktreesMeta })
  const mutations = renderHook(() =>
    useWorktreeStatusMutations({
      manualOrderCatalog: { rankByKey: new Map(), orderedKeys: [] },
      workspaceStatuses: useAppStore.getState().workspaceStatuses,
      sortBy: 'recent'
    })
  )
  return { mutations, updateWorktreesMeta }
}

beforeEach(() => {
  toastWarning.mockReset()
  useAppStore.setState({
    workspaceStatuses: [
      { id: 'backlog', label: 'Backlog' },
      { id: 'completed', label: 'Done' }
    ],
    hostWorkspaceStatuses: { 'env-mini': [{ id: 'qa', label: 'QA' }] },
    removedRuntimeEnvironmentIds: new Set<string>(),
    runtimeEnvironments: [
      pairedEnvironment('env-mini', 'mini'),
      pairedEnvironment('env-studio', 'studio')
    ],
    settings: null,
    worktreesByRepo: { 'repo-1': twinCopies() },
    folderWorkspaces: []
  })
})

describe('dropWorktreesOnWorkspaceBoard', () => {
  it('reports the copy a column refuses while still moving the one it takes', () => {
    const { mutations, updateWorktreesMeta } = renderMutations()

    act(() =>
      mutations.result.current.dropWorktreesOnWorkspaceBoard({
        worktreeIds: ['workspace-1'],
        status: 'qa',
        dropIndex: 0,
        groups: [],
        draggedCopies: [
          { id: 'workspace-1', hostId: 'runtime:env-studio' },
          { id: 'workspace-1', hostId: 'runtime:env-mini' }
        ]
      })
    )

    expect(toastWarning).toHaveBeenCalledOnce()
    const [title, options] = toastWarning.mock.calls[0] ?? []
    expect(title).toContain('1 of 2')
    expect(options?.description).toContain('studio')
    expect(updateWorktreesMeta).toHaveBeenCalledOnce()
    expect(updateWorktreesMeta.mock.calls[0]?.[0]).toContainEqual(
      expect.objectContaining({
        worktreeId: 'workspace-1',
        executionHostId: 'runtime:env-mini',
        updates: { workspaceStatus: 'qa' }
      })
    )
  })

  it('moves nothing and says why when the column refuses every dragged copy', () => {
    const { mutations, updateWorktreesMeta } = renderMutations()

    act(() =>
      mutations.result.current.dropWorktreesOnWorkspaceBoard({
        worktreeIds: ['workspace-1'],
        status: 'qa',
        dropIndex: 0,
        groups: [],
        draggedCopies: [{ id: 'workspace-1', hostId: 'runtime:env-studio' }]
      })
    )

    expect(updateWorktreesMeta).not.toHaveBeenCalled()
    expect(toastWarning).toHaveBeenCalledOnce()
  })
})
