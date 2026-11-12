// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import type { PublicKnownRuntimeEnvironment } from '../../../../../../shared/remote-runtime/host-catalog/runtime-environments'
import type { Worktree } from '../../../../../../shared/worktree/types'
import { getWorktreeHostIdentity } from '../../../../../../shared/worktree/host-qualified-identity'
import { useWorkspaceKanbanWorktreeActions } from './use-workspace-kanban-worktree-actions'

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

function studioCard(): Worktree {
  return {
    id: 'workspace-1',
    repoId: 'repo-1',
    displayName: 'Feature',
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0,
    path: '/tmp/workspace-1',
    head: 'head',
    branch: 'feature',
    isBare: false,
    isMainWorktree: false,
    hostId: 'runtime:env-studio',
    workspaceStatus: 'backlog'
  }
}

function renderDropActions(card: Worktree) {
  const updateWorktreesMeta = vi.fn().mockResolvedValue({ ok: true })
  const actions = renderHook(() =>
    useWorkspaceKanbanWorktreeActions({
      boardDragGroups: [],
      laneFullWorktreeIds: new Map(),
      laneViews: new Map(),
      maybeSyncTaskStatuses: vi.fn(),
      sortBy: 'recent',
      updateWorktreeMeta: vi.fn(),
      updateWorktreesMeta,
      workspaceStatuses: useAppStore.getState().workspaceStatuses,
      worktreeById: new Map([[card.id, card]]),
      worktreeByKey: new Map([[getWorktreeHostIdentity(card), card]]),
      manualOrderCatalog: { rankByKey: new Map(), orderedKeys: [] },
      worktreesByStatus: new Map()
    })
  )
  return { actions, updateWorktreesMeta }
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
    settings: null
  })
})

describe('dropWorktreesAtEndOfStatus', () => {
  it('says why a card stayed put when the column belongs to another host', () => {
    const { actions, updateWorktreesMeta } = renderDropActions(studioCard())

    act(() => actions.result.current.dropWorktreesAtEndOfStatus(['workspace-1'], 'qa'))

    expect(updateWorktreesMeta).not.toHaveBeenCalled()
    expect(toastWarning).toHaveBeenCalledOnce()
    expect(toastWarning).toHaveBeenCalledWith("'QA' is a column on mini", {
      description: 'This workspace lives on studio.'
    })
  })

  it('moves an allowed card silently', () => {
    const { actions, updateWorktreesMeta } = renderDropActions(studioCard())

    act(() => actions.result.current.dropWorktreesAtEndOfStatus(['workspace-1'], 'completed'))

    expect(toastWarning).not.toHaveBeenCalled()
    expect(updateWorktreesMeta).toHaveBeenCalledWith([
      expect.objectContaining({
        worktreeId: 'workspace-1',
        updates: { workspaceStatus: 'completed' }
      })
    ])
  })
})
