import type { DraggedWorktreeCopies } from '../drag/dragged-worktree-copies'
import React from 'react'
import { cn } from '@/lib/class-names'
import type { AppState } from '@/store/types'
import type { ExecutionHostId } from '../../../../../../shared/execution-host/execution-host'
import type { Worktree } from '../../../../../../shared/worktree/types'
import { getWorktreeHostIdentity } from '../../../../../../shared/worktree/host-qualified-identity'
import { isActiveSidebarWorkspace } from '../../../../../../shared/sidebar-list/selection/active-workspace'
import WorktreeCard from '../../workspace-card/surface/WorktreeCard'
import type { ActiveSurfaceVariant } from '../../workspace-card/controller/worktree-card-model'
import { PINNED_GROUP_KEY } from '../../../../../../shared/sidebar-list/sections/group-keys'
import { resolveBranchGroupSelection } from '../grouping/branch-groups'
import type { WorktreeGroupBy } from '../../../../../../shared/sidebar-list/row-types'
import type { LineageToggleHandler } from '../../workspace-card/identity/worktree-lineage-toggle-handler-cache'
import type { LineageRowFrame } from '../listing/lineage-row-projection'
import type { WorktreeItemRow } from '../listing/renderable-rows'
import { forwardOptionPressToCardSurface, getWorktreeOptionId } from './option-dom'
import type { WorktreeRowDragState } from '../drag/row-state'

export type WorktreeItemRowContext = {
  settings: AppState['settings']
  groupBy: WorktreeGroupBy
  groupKeyByRowKey: ReadonlyMap<string, string>
  groupIndexByRowKey: ReadonlyMap<string, number>
  agentSendTargetWorktreeId: string | null
  worktreeDragState: WorktreeRowDragState
  nativeLineageDropTargetIdentity: string | null
  activeWorktreeId: string | null
  activeWorkspaceExecutionHostId: ExecutionHostId | null
  currentWorktreeId: string | null
  highlightedRevealRowKey: string | null
  selectedWorktreeIds: ReadonlySet<string>
  selectedWorktrees: readonly Worktree[]
  getActiveSurfaceVariant: (row: WorktreeItemRow) => ActiveSurfaceVariant
  getLineageToggleHandler: (groupKeys: readonly string[]) => LineageToggleHandler
  /** Group by branch cards key their host choice by row key. */
  branchGroupSelection: Readonly<Record<string, ExecutionHostId>>
  onSelectBranchGroupHost: (rowKey: string, groupKey: string, hostId: ExecutionHostId) => void
  onSelectionGesture: (event: React.MouseEvent<HTMLElement>, worktree: Worktree) => boolean
  onWorktreeCardClick?: () => void
  onContextMenuSelect: (
    event: React.MouseEvent<HTMLElement>,
    worktree: Worktree
  ) => readonly Worktree[]
  onImmediateActivate: (worktreeId: string, rowKey: string | undefined) => void
  onRowClickCapture: (event: React.MouseEvent<HTMLDivElement>) => void
  onRowPointerDown: (
    event: React.PointerEvent<HTMLDivElement>,
    worktree: Worktree,
    rowKey: string
  ) => void
  onCardDragStart: (
    event: React.DragEvent<HTMLDivElement>,
    worktreeId: string,
    draggedCopies: DraggedWorktreeCopies
  ) => void
  onCardDragEnd: () => void
}

export function renderWorktreeItemRow(
  ctx: WorktreeItemRowContext,
  itemRow: WorktreeItemRow,
  frame: LineageRowFrame,
  forceActiveSurface = false
): React.JSX.Element {
  const { left: surfaceInset, right, contentIndent: cardContentIndent } = frame
  // Why: a Group by branch card stands in for every host it merged. Until the
  // user picks a host, it follows the active workspace, then falls back local-first.
  const branchSelection = itemRow.branchGroup
    ? resolveBranchGroupSelection({
        members: itemRow.branchGroup,
        groupKey: itemRow.branchGroupKey ?? '',
        selection: ctx.branchGroupSelection,
        activeWorktreeId: ctx.activeWorktreeId,
        activeExecutionHostId: ctx.activeWorkspaceExecutionHostId
      })
    : null
  const selectedBranchHostId = branchSelection?.selectedHostId
  const cardWorktree = branchSelection?.member.worktree ?? itemRow.worktree
  const cardRepo = branchSelection?.member.repo ?? itemRow.repo
  const worktreeDragGroupKey = ctx.groupKeyByRowKey.get(itemRow.rowKey)
  const worktreeIdentity = getWorktreeHostIdentity(cardWorktree)
  const isMultiSelected = ctx.selectedWorktreeIds.has(worktreeIdentity)
  const isLineageDropTarget =
    ctx.worktreeDragState.draggingWorktreeId &&
    (ctx.worktreeDragState.lineageDropTargetIdentity === worktreeIdentity ||
      ctx.nativeLineageDropTargetIdentity === worktreeIdentity)
  const isActiveWorktree =
    Boolean(branchSelection?.isActiveGroup) ||
    isActiveSidebarWorkspace(cardWorktree, {
      worktreeId: ctx.activeWorktreeId,
      hostId: ctx.activeWorkspaceExecutionHostId ?? null
    })
  const lineageToggleKeys =
    itemRow.lineageCollapseKeys ?? (itemRow.lineageGroupKey ? [itemRow.lineageGroupKey] : null)
  return (
    <div
      key={itemRow.rowKey}
      id={getWorktreeOptionId(itemRow.rowKey)}
      role="option"
      aria-selected={isMultiSelected}
      aria-current={isActiveWorktree ? 'page' : undefined}
      data-worktree-id={cardWorktree.id}
      data-worktree-host-identity={worktreeIdentity}
      data-worktree-row-key={itemRow.rowKey}
      data-worktree-section-key={itemRow.sectionKey}
      data-worktree-drag-id={worktreeDragGroupKey ? cardWorktree.id : undefined}
      data-worktree-drag-group-key={worktreeDragGroupKey}
      data-worktree-drag-group-index={ctx.groupIndexByRowKey.get(itemRow.rowKey)}
      className={cn(
        // Why: don't transition 'transform' — it lags/flashes when TanStack Virtual repositions adjacent rows.
        'relative transition-[opacity,filter] duration-150 ease-out',
        ctx.worktreeDragState.draggingWorktreeId === worktreeIdentity &&
          // Why: the fixed drag preview is the affordance; a translucent source row would bleed through sticky headers/footers.
          'pointer-events-none opacity-0'
      )}
      data-scroll-reveal-highlight={
        ctx.highlightedRevealRowKey === itemRow.rowKey ? 'true' : undefined
      }
      onClick={forwardOptionPressToCardSurface}
      onClickCapture={ctx.onRowClickCapture}
      onPointerDown={(event) => {
        ctx.onRowPointerDown(event, cardWorktree, itemRow.rowKey)
      }}
      style={{
        paddingLeft: surfaceInset > 0 ? `${surfaceInset}px` : undefined,
        paddingRight: right || undefined
      }}
    >
      <WorktreeCard
        worktree={cardWorktree}
        repo={cardRepo}
        isActive={isActiveWorktree}
        isCurrentWorktree={ctx.currentWorktreeId === cardWorktree.id}
        // Why: a child-active parent should look active without the active-card side effects (e.g. SSH reconnect UI).
        isActiveSurface={forceActiveSurface || isActiveWorktree}
        activeSurfaceVariant={isActiveWorktree ? ctx.getActiveSurfaceVariant(itemRow) : 'primary'}
        isMultiSelected={isMultiSelected}
        revealHighlight={ctx.highlightedRevealRowKey === itemRow.rowKey}
        revealHighlightTone={ctx.agentSendTargetWorktreeId === cardWorktree.id ? 'ai' : 'default'}
        // Only selected rows act on the selection; passing it to the rest would re-render every card per click.
        selectedWorktrees={isMultiSelected ? ctx.selectedWorktrees : undefined}
        nativeDragEnabled={false}
        isLineageDropTarget={Boolean(isLineageDropTarget)}
        contentIndent={cardContentIndent}
        flushSurface
        activationRowKey={itemRow.rowKey}
        onImmediateActivate={ctx.onImmediateActivate}
        onSelectionGesture={ctx.onSelectionGesture}
        onWorktreeCardClick={ctx.onWorktreeCardClick}
        onContextMenuSelect={ctx.onContextMenuSelect}
        onCardDragStart={ctx.onCardDragStart}
        onCardDragEnd={ctx.onCardDragEnd}
        hideRepoBadge={ctx.groupBy === 'repo' && !itemRow.showProjectName}
        // Why: pinned worktrees mix repos; cross-repo children opt into the existing project-name badge.
        hostContextLabel={itemRow.hostContextLabel}
        showProjectName={itemRow.showProjectName}
        inPinnedSection={itemRow.sectionKey === PINNED_GROUP_KEY}
        renameRowKey={itemRow.rowKey}
        lineageChildCount={itemRow.lineageChildCount}
        lineageChildWorktreeIds={itemRow.lineageChildWorktreeIds}
        lineageCollapsed={itemRow.lineageCollapsed}
        lineageDescendantIdentities={itemRow.lineageDescendantIdentities}
        branchGroup={itemRow.branchGroup}
        selectedBranchHostId={selectedBranchHostId}
        branchGroupKey={itemRow.branchGroupKey}
        onSelectBranchHost={(groupKey, hostId) =>
          ctx.onSelectBranchGroupHost(itemRow.rowKey, groupKey, hostId)
        }
        onLineageToggle={
          lineageToggleKeys ? ctx.getLineageToggleHandler(lineageToggleKeys) : undefined
        }
      />
    </div>
  )
}
