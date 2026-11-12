import { describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import type { PublicKnownRuntimeEnvironment } from '../../../../../../shared/remote-runtime/host-catalog/runtime-environments'
import type { WorkspaceStatusDefinition } from '../../../../../../shared/worktree/types'
import {
  canRefuseWorkspaceKanbanColumn,
  isWorkspaceKanbanColumnRefused,
  notifyWorkspaceKanbanColumnRefusal,
  partitionWorkspaceKanbanDropCards,
  resolveWorkspaceKanbanColumnRefusal,
  type WorkspaceKanbanRefusalCard
} from './workspace-kanban-foreign-column-refusal'

const { toastWarning } = vi.hoisted(() => ({ toastWarning: vi.fn() }))
vi.mock('sonner', () => ({ toast: { warning: toastWarning } }))

const LOCAL_COLUMNS: WorkspaceStatusDefinition[] = [
  { id: 'backlog', label: 'Backlog' },
  { id: 'completed', label: 'Done' }
]

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

function makeState(overrides: Partial<AppState> = {}): AppState {
  useAppStore.setState({
    workspaceStatuses: LOCAL_COLUMNS,
    hostWorkspaceStatuses: { 'env-mini': [{ id: 'qa', label: 'QA' }] },
    removedRuntimeEnvironmentIds: new Set<string>(),
    runtimeEnvironments: [
      pairedEnvironment('env-mini', 'mini'),
      pairedEnvironment('env-studio', 'studio')
    ],
    settings: null,
    ...overrides
  })
  return useAppStore.getState()
}

const STUDIO_CARD: WorkspaceKanbanRefusalCard = {
  hostId: 'runtime:env-studio',
  workspaceStatus: 'backlog'
}
const MINI_CARD: WorkspaceKanbanRefusalCard = {
  hostId: 'runtime:env-mini',
  workspaceStatus: 'backlog'
}

describe('partitionWorkspaceKanbanDropCards', () => {
  it('splits the cards the way the commit does and counts only the ones that would move', () => {
    const state = makeState()
    const alreadyInColumn: WorkspaceKanbanRefusalCard = {
      hostId: 'runtime:env-studio',
      workspaceStatus: 'qa'
    }

    const partition = partitionWorkspaceKanbanDropCards(
      state,
      [STUDIO_CARD, MINI_CARD, alreadyInColumn],
      'qa'
    )

    expect(partition.accepted).toEqual([MINI_CARD])
    expect(partition.refused).toEqual([STUDIO_CARD])
    // The card already in the column moves nowhere, so it is not refused and not counted.
    expect(partition.movableCount).toBe(2)
  })
})

describe('resolveWorkspaceKanbanColumnRefusal', () => {
  it('names the refused column, its host, and the host the cards live on', () => {
    const refusal = resolveWorkspaceKanbanColumnRefusal(makeState(), [STUDIO_CARD], 'qa', 1)

    expect(refusal).toEqual({
      status: 'qa',
      columnLabel: 'QA',
      columnHostLabel: 'mini',
      cardHostLabel: 'studio',
      refusedCount: 1,
      totalCount: 1
    })
  })

  it('counts the refused cards against the ones that would have moved', () => {
    const refusal = resolveWorkspaceKanbanColumnRefusal(
      makeState(),
      [STUDIO_CARD, STUDIO_CARD],
      'qa',
      5
    )

    expect(refusal).toMatchObject({ refusedCount: 2, totalCount: 5 })
  })

  it('names no card host when the refused cards sit on different hosts', () => {
    const refusal = resolveWorkspaceKanbanColumnRefusal(
      makeState(),
      [STUDIO_CARD, { hostId: 'runtime:env-third', workspaceStatus: 'backlog' }],
      'qa',
      2
    )

    expect(refusal?.cardHostLabel).toBeNull()
  })

  it('falls back to an anonymous host when only a retired host still defines the column', () => {
    const state = makeState({ removedRuntimeEnvironmentIds: new Set(['env-mini']) })

    expect(
      resolveWorkspaceKanbanColumnRefusal(state, [STUDIO_CARD], 'qa', 1)?.columnHostLabel
    ).toBeNull()
  })

  it('resolves nothing when no card was refused', () => {
    expect(resolveWorkspaceKanbanColumnRefusal(makeState(), [], 'qa', 3)).toBeNull()
  })
})

describe('isWorkspaceKanbanColumnRefused', () => {
  it('refuses the lane when the column takes none of the dragged cards', () => {
    const state = makeState()

    expect(isWorkspaceKanbanColumnRefused(state, [STUDIO_CARD, STUDIO_CARD], 'qa')).toBe(true)
    expect(isWorkspaceKanbanColumnRefused(state, [STUDIO_CARD, MINI_CARD], 'qa')).toBe(false)
  })

  it('keeps a lane droppable when a card it takes already sits in it', () => {
    const state = makeState()
    const alreadyInColumn: WorkspaceKanbanRefusalCard = {
      hostId: 'runtime:env-mini',
      workspaceStatus: 'qa'
    }

    // The mini copy is already there, so the lane must stay droppable for the barred studio card.
    expect(isWorkspaceKanbanColumnRefused(state, [alreadyInColumn, STUDIO_CARD], 'qa')).toBe(false)
  })

  it('keeps a lane droppable when the cards already sit in it', () => {
    const state = makeState()
    const alreadyInColumn: WorkspaceKanbanRefusalCard = {
      hostId: 'runtime:env-studio',
      workspaceStatus: 'qa'
    }

    expect(isWorkspaceKanbanColumnRefused(state, [alreadyInColumn], 'qa')).toBe(false)
    expect(isWorkspaceKanbanColumnRefused(state, [alreadyInColumn, STUDIO_CARD], 'qa')).toBe(true)
  })

  it('keeps a local column and an unknown column droppable', () => {
    const state = makeState()

    expect(isWorkspaceKanbanColumnRefused(state, [STUDIO_CARD], 'backlog')).toBe(false)
    expect(isWorkspaceKanbanColumnRefused(state, [STUDIO_CARD], 'never-defined')).toBe(false)
    expect(isWorkspaceKanbanColumnRefused(state, [], 'qa')).toBe(false)
  })
})

describe('canRefuseWorkspaceKanbanColumn', () => {
  it('is false wherever the rule can never refuse, so the scan can be skipped', () => {
    const state = makeState()

    expect(canRefuseWorkspaceKanbanColumn(state, 'qa')).toBe(true)
    expect(canRefuseWorkspaceKanbanColumn(state, 'backlog')).toBe(false)
    expect(canRefuseWorkspaceKanbanColumn(state, 'never-defined')).toBe(false)
    expect(canRefuseWorkspaceKanbanColumn(makeState({ hostWorkspaceStatuses: {} }), 'qa')).toBe(
      false
    )
  })
})

describe('notifyWorkspaceKanbanColumnRefusal', () => {
  it('raises one warning naming the host mismatch', () => {
    toastWarning.mockReset()

    notifyWorkspaceKanbanColumnRefusal(
      resolveWorkspaceKanbanColumnRefusal(makeState(), [STUDIO_CARD], 'qa', 1)
    )
    notifyWorkspaceKanbanColumnRefusal(null)

    expect(toastWarning).toHaveBeenCalledOnce()
    const [title, options] = toastWarning.mock.calls[0] ?? []
    expect(title).toContain('QA')
    expect(title).toContain('mini')
    expect(options).toMatchObject({ id: 'workspace-board-foreign-column:qa' })
    expect(options?.description).toContain('studio')
  })
})
