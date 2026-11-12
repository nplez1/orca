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

function boardCard(id: string, hostId: Worktree['hostId']): Worktree {
  return {
    id,
    repoId: 'repo-1',
    displayName: id,
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0,
    path: `/tmp/${id}`,
    head: 'head',
    branch: id,
    isBare: false,
    isMainWorktree: false,
    hostId,
    workspaceStatus: 'backlog'
  }
}

const STUDIO_CARD = boardCard('workspace-studio', 'runtime:env-studio')
const MINI_CARD = boardCard('workspace-mini', 'runtime:env-mini')

function renderDropActions(cards: readonly Worktree[]) {
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
      worktreeById: new Map(cards.map((card) => [card.id, card])),
      worktreeByKey: new Map(cards.map((card) => [getWorktreeHostIdentity(card), card])),
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
    const { actions, updateWorktreesMeta } = renderDropActions([STUDIO_CARD])

    act(() => actions.result.current.dropWorktreesAtEndOfStatus([STUDIO_CARD.id], 'qa'))

    expect(updateWorktreesMeta).not.toHaveBeenCalled()
    expect(toastWarning).toHaveBeenCalledOnce()
    const [title, options] = toastWarning.mock.calls[0] ?? []
    expect(title).toContain('QA')
    expect(title).toContain('mini')
    expect(options?.description).toContain('studio')
  })

  it('moves the allowed cards and reports the ones the column skipped', () => {
    const { actions, updateWorktreesMeta } = renderDropActions([STUDIO_CARD, MINI_CARD])

    act(() =>
      actions.result.current.dropWorktreesAtEndOfStatus([STUDIO_CARD.id, MINI_CARD.id], 'qa')
    )

    expect(updateWorktreesMeta).toHaveBeenCalledOnce()
    expect(updateWorktreesMeta).toHaveBeenCalledWith([
      expect.objectContaining({
        worktreeId: MINI_CARD.id,
        updates: { workspaceStatus: 'qa' }
      })
    ])
    const [title] = toastWarning.mock.calls[0] ?? []
    expect(title).toContain('1 of 2')
  })

  it('moves an allowed card silently', () => {
    const { actions, updateWorktreesMeta } = renderDropActions([STUDIO_CARD])

    act(() => actions.result.current.dropWorktreesAtEndOfStatus([STUDIO_CARD.id], 'completed'))

    expect(toastWarning).not.toHaveBeenCalled()
    expect(updateWorktreesMeta).toHaveBeenCalledWith([
      expect.objectContaining({
        worktreeId: STUDIO_CARD.id,
        updates: { workspaceStatus: 'completed' }
      })
    ])
  })
})
