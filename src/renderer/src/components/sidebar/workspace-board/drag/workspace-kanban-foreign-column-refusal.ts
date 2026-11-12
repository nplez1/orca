import { toast } from 'sonner'
import type { AppState } from '@/store/types'
import {
  isWorkspaceStatusAllowedOnHost,
  selectAllKnownWorkspaceStatuses,
  selectWorkspaceStatusColumnOwnerEnvironmentIds,
  type StatusColumnOwner
} from '@/store/workspaces/status/host-workspace-status-columns'
import {
  toRuntimeExecutionHostId,
  type ExecutionHostId
} from '../../../../../../shared/execution-host'
import { selectExecutionHostDisplayLabel } from '@/runtime/hosts/display/execution-host-display-label'
import { translate } from '@/i18n/i18n'
import type { WorkspaceStatus } from '../../../../../../shared/worktree/types'

/** A dragged card: the rule's owner plus the host id its label resolves from. */
export type WorkspaceKanbanRefusalCard = StatusColumnOwner & { hostId?: ExecutionHostId }

/** Why a column will not take the dragged cards, in terms the user can act on. */
export type WorkspaceKanbanColumnRefusal = {
  status: WorkspaceStatus
  /** The column's label, as the board shows it. */
  columnLabel: string
  /** The paired host that owns the column; null when only a retired host still defines it. */
  columnHostLabel: string | null
  /** The refused cards' host, when every refused card lives on one; null for a mixed set. */
  cardHostLabel: string | null
  refusedCount: number
  /** Dragged cards this drop could resolve; unresolvable cards are neither refused nor counted. */
  totalCount: number
}

/** A paired runtime's own name, which is what the user calls that host. */
function cardHostLabel(state: AppState, card: WorkspaceKanbanRefusalCard): string {
  const environmentId = card.runtimeOwnerEnvironmentId?.trim()
  return selectExecutionHostDisplayLabel(
    state,
    environmentId ? toRuntimeExecutionHostId(environmentId) : (card.hostId ?? 'local')
  )
}

/** The column's own name, from any host that defines it, so a retired host still reads properly. */
function columnLabel(state: AppState, status: WorkspaceStatus): string {
  return (
    selectAllKnownWorkspaceStatuses(state).find((column) => column.id === status)?.label ?? status
  )
}

/** Null when every card may enter the column; otherwise the reason to show. */
export function resolveWorkspaceKanbanColumnRefusal(
  state: AppState,
  refusedCards: readonly WorkspaceKanbanRefusalCard[],
  status: WorkspaceStatus,
  totalCount: number
): WorkspaceKanbanColumnRefusal | null {
  if (refusedCards.length === 0) {
    return null
  }
  const ownerEnvironmentId = selectWorkspaceStatusColumnOwnerEnvironmentIds(state, status)[0]
  const hostLabels = [...new Set(refusedCards.map((card) => cardHostLabel(state, card)))]
  return {
    status,
    columnLabel: columnLabel(state, status),
    columnHostLabel: ownerEnvironmentId
      ? selectExecutionHostDisplayLabel(state, toRuntimeExecutionHostId(ownerEnvironmentId))
      : null,
    cardHostLabel: hostLabels.length === 1 ? (hostLabels[0] ?? null) : null,
    refusedCount: refusedCards.length,
    totalCount: Math.max(totalCount, refusedCards.length)
  }
}

/** Whether every dragged card is barred, i.e. the lane must refuse the drag rather than partly take it. */
export function isWorkspaceKanbanColumnRefused(
  state: AppState,
  cards: readonly WorkspaceKanbanRefusalCard[],
  status: WorkspaceStatus
): boolean {
  return (
    cards.length > 0 && cards.every((card) => !isWorkspaceStatusAllowedOnHost(state, card, status))
  )
}

export function formatWorkspaceKanbanColumnRefusal(refusal: WorkspaceKanbanColumnRefusal): {
  title: string
  description: string
} {
  const column = refusal.columnHostLabel
    ? translate(
        'auto.components.sidebar.WorkspaceKanbanDrawer.foreignColumnOwner',
        "'{{column}}' is a column on {{host}}",
        { column: refusal.columnLabel, host: refusal.columnHostLabel }
      )
    : translate(
        'auto.components.sidebar.WorkspaceKanbanDrawer.foreignColumnRetiredOwner',
        "'{{column}}' is another host's column",
        { column: refusal.columnLabel }
      )
  const livesOn = refusal.cardHostLabel
  if (refusal.refusedCount < refusal.totalCount) {
    return {
      title: translate(
        'auto.components.sidebar.WorkspaceKanbanDrawer.foreignColumnPartialTitle',
        "{{count}} of {{total}} workspaces weren't moved",
        { count: refusal.refusedCount, total: refusal.totalCount }
      ),
      description: livesOn
        ? translate(
            'auto.components.sidebar.WorkspaceKanbanDrawer.foreignColumnPartialDescription',
            '{{column}} — they live on {{host}}.',
            { column, host: livesOn }
          )
        : translate(
            'auto.components.sidebar.WorkspaceKanbanDrawer.foreignColumnPartialOtherHosts',
            '{{column}} — they live on other hosts.',
            { column }
          )
    }
  }
  return {
    title: column,
    description: livesOn
      ? translate(
          'auto.components.sidebar.WorkspaceKanbanDrawer.foreignColumnRefusedDescription',
          'These {{count}} workspaces live on {{host}}.',
          {
            count: refusal.refusedCount,
            host: livesOn,
            defaultValue_one: 'This workspace lives on {{host}}.'
          }
        )
      : translate(
          'auto.components.sidebar.WorkspaceKanbanDrawer.foreignColumnRefusedOtherHosts',
          'These {{count}} workspaces live on other hosts.',
          { count: refusal.refusedCount, defaultValue_one: 'This workspace lives on another host.' }
        )
  }
}

/** One warning per refused drop: the cards stayed put and this is why. */
export function notifyWorkspaceKanbanColumnRefusal(
  refusal: WorkspaceKanbanColumnRefusal | null
): void {
  if (!refusal) {
    return
  }
  const { title, description } = formatWorkspaceKanbanColumnRefusal(refusal)
  toast.warning(title, { description })
}
