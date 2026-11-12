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
import { getWorkspaceStatus } from '../../../../../../shared/workspace-statuses'
import { translate } from '@/i18n/i18n'
import type { WorkspaceStatus, Worktree } from '../../../../../../shared/worktree/types'

/** A dragged card: the rule's owner plus the host and status its label and no-op check read. */
export type WorkspaceKanbanRefusalCard = StatusColumnOwner &
  Pick<Worktree, 'workspaceStatus'> & { hostId?: ExecutionHostId }

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

/**
 * Null when the column took every card it would move; otherwise the reason to show.
 * `refusedCards` and `totalCount` come from `partitionWorkspaceKanbanDropCards`.
 */
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

/** A card already in the column is a no-op, never a refusal, so it says nothing about hosts. */
function isCardMovingTo(
  state: AppState,
  card: WorkspaceKanbanRefusalCard,
  status: WorkspaceStatus
): boolean {
  return getWorkspaceStatus(card, selectAllKnownWorkspaceStatuses(state)) !== status
}

/**
 * Splits the dragged cards the way the commit does: accepted cards, cards this drop would move that
 * the column bars, and how many would move at all (the count a message quotes).
 */
export function partitionWorkspaceKanbanDropCards<C extends WorkspaceKanbanRefusalCard>(
  state: AppState,
  cards: readonly C[],
  status: WorkspaceStatus
): { accepted: C[]; refused: C[]; movableCount: number } {
  const accepted: C[] = []
  const refused: C[] = []
  let movableCount = 0
  for (const card of cards) {
    if (isCardMovingTo(state, card, status)) {
      movableCount += 1
    }
    if (isWorkspaceStatusAllowedOnHost(state, card, status)) {
      accepted.push(card)
    } else if (isCardMovingTo(state, card, status)) {
      refused.push(card)
    }
  }
  return { accepted, refused, movableCount }
}

/** Whether every card this drop would move is barred, so the lane must refuse rather than partly take it. */
export function isWorkspaceKanbanColumnRefused(
  state: AppState,
  cards: readonly WorkspaceKanbanRefusalCard[],
  status: WorkspaceStatus
): boolean {
  const { refused, movableCount } = partitionWorkspaceKanbanDropCards(state, cards, status)
  return refused.length > 0 && refused.length === movableCount
}

/** False when a local column or no paired host defines this id, so no refusal is possible and no scan is needed. */
export function canRefuseWorkspaceKanbanColumn(state: AppState, status: WorkspaceStatus): boolean {
  if (state.workspaceStatuses.some((column) => column.id === status)) {
    return false
  }
  return Object.values(state.hostWorkspaceStatuses ?? {}).some((columns) =>
    columns.some((column) => column.id === status)
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
  // Why the id: retrying the same refused drop replaces the warning instead of stacking it.
  toast.warning(title, { description, id: `workspace-board-foreign-column:${refusal.status}` })
}
