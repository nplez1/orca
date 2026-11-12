import { describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import type { PublicKnownRuntimeEnvironment } from '../../../../../../shared/remote-runtime/host-catalog/runtime-environments'
import type { WorkspaceStatusDefinition } from '../../../../../../shared/worktree/types'
import {
  formatWorkspaceKanbanColumnRefusal,
  isWorkspaceKanbanColumnRefused,
  notifyWorkspaceKanbanColumnRefusal,
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

const STUDIO_CARD: WorkspaceKanbanRefusalCard = { hostId: 'runtime:env-studio' }
const MINI_CARD: WorkspaceKanbanRefusalCard = { hostId: 'runtime:env-mini' }

describe('resolveWorkspaceKanbanColumnRefusal', () => {
  it('names the refused column, its host, and the host the cards live on', () => {
    const refusal = resolveWorkspaceKanbanColumnRefusal(makeState(), [STUDIO_CARD], 'qa', 1)

    expect(refusal).toMatchObject({
      columnLabel: 'QA',
      columnHostLabel: 'mini',
      cardHostLabel: 'studio',
      refusedCount: 1,
      totalCount: 1
    })
    expect(formatWorkspaceKanbanColumnRefusal(refusal!)).toEqual({
      title: "'QA' is a column on mini",
      description: 'This workspace lives on studio.'
    })
  })

  it('reports how many of a partly refused drop stayed put', () => {
    const refusal = resolveWorkspaceKanbanColumnRefusal(
      makeState(),
      [STUDIO_CARD, STUDIO_CARD],
      'qa',
      5
    )

    expect(formatWorkspaceKanbanColumnRefusal(refusal!)).toEqual({
      title: "2 of 5 workspaces weren't moved",
      description: "'QA' is a column on mini — they live on studio."
    })
  })

  it('names no card host when the refused cards sit on different hosts', () => {
    const refusal = resolveWorkspaceKanbanColumnRefusal(
      makeState(),
      [STUDIO_CARD, { hostId: 'runtime:env-third' }],
      'qa',
      2
    )

    expect(refusal?.cardHostLabel).toBeNull()
    expect(formatWorkspaceKanbanColumnRefusal(refusal!).description).toBe(
      'These 2 workspaces live on other hosts.'
    )
  })

  it('falls back to an anonymous host when only a retired host still defines the column', () => {
    const state = makeState({ removedRuntimeEnvironmentIds: new Set(['env-mini']) })

    const refusal = resolveWorkspaceKanbanColumnRefusal(state, [STUDIO_CARD], 'qa', 1)

    expect(refusal?.columnHostLabel).toBeNull()
    expect(formatWorkspaceKanbanColumnRefusal(refusal!).title).toBe("'QA' is another host's column")
  })

  it('resolves nothing when no card was refused', () => {
    expect(resolveWorkspaceKanbanColumnRefusal(makeState(), [], 'qa', 3)).toBeNull()
  })
})

describe('isWorkspaceKanbanColumnRefused', () => {
  it('refuses the lane only when every dragged card is barred', () => {
    const state = makeState()

    expect(isWorkspaceKanbanColumnRefused(state, [STUDIO_CARD, STUDIO_CARD], 'qa')).toBe(true)
    expect(isWorkspaceKanbanColumnRefused(state, [STUDIO_CARD, MINI_CARD], 'qa')).toBe(false)
  })

  it('keeps a local column and an unknown column droppable', () => {
    const state = makeState()

    expect(isWorkspaceKanbanColumnRefused(state, [STUDIO_CARD], 'backlog')).toBe(false)
    expect(isWorkspaceKanbanColumnRefused(state, [STUDIO_CARD], 'never-defined')).toBe(false)
    expect(isWorkspaceKanbanColumnRefused(state, [], 'qa')).toBe(false)
  })
})

describe('notifyWorkspaceKanbanColumnRefusal', () => {
  it('raises one warning naming the host mismatch', () => {
    toastWarning.mockReset()
    const state = makeState()

    notifyWorkspaceKanbanColumnRefusal(
      resolveWorkspaceKanbanColumnRefusal(state, [STUDIO_CARD], 'qa', 1)
    )
    notifyWorkspaceKanbanColumnRefusal(null)

    expect(toastWarning).toHaveBeenCalledOnce()
    expect(toastWarning).toHaveBeenCalledWith("'QA' is a column on mini", {
      description: 'This workspace lives on studio.'
    })
  })
})
