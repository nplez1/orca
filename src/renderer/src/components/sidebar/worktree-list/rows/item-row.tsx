import type { DraggedWorktreeCopies } from '../drag/dragged-worktree-copies'
import React from 'react'
import { cn } from '@/lib/utils'
import type { AppState } from '@/store/types'
import type { ExecutionHostId } from '../../../../../../shared/execution-host'
import type { Worktree } from '../../../../../../shared/worktree/types'
import { getWorktreeHostIdentity } from '../../../../../../shared/worktree/host-qualified-identity'
import { isActiveSidebarWorkspace } from '../../../../../../shared/sidebar-list/active-workspace'
import WorktreeCard, { type ActiveSurfaceVariant } from '../../WorktreeCard'
import { PINNED_GROUP_KEY } from '../../../../../../shared/sidebar-list/group-keys'
import { resolveBranchGroupSelection } from '../grouping/branch-groups'
import type { WorktreeGroupBy } from '../../../../../../shared/sidebar-list/row-types'
import {
  getFolderBackedRepoWorktreeCardContentIndent,
  getFolderBackedRepoWorktreeCardSurfaceInset,
  getLineageChildrenInlineStyle,
  getWorktreeCardContentIndent,
  getWorktreeCardSurfaceInset,
  LINEAGE_CHILDREN_INLINE_OFFSET,
  LINEAGE_NESTED_ROW_SURFACE_INSET
} from './indentation'
import type { LineageToggleHandler } from '../../worktree-lineage-toggle-handler-cache'
import { stopNestedWorktreeCardBubble } from './header-event-guards'
import type { WorktreeItemRow } from '../listing/renderable-rows'
import { forwardOptionPressToCardSurface, getWorktreeOptionId } from './option-dom'
import type { WorktreeRowDragState } from '../drag/row-state'

export type WorktreeItemRowContext = {
  settings: AppState['settings']
  groupBy: WorktreeGroupBy
  folderBackedProjectGroupIds: ReadonlySet<string>
  groupKeyByRowKey: ReadonlyMap<string, string>
  groupIndexByRowKey: ReadonlyMap<string, number>
  agentSendTargetWorktreeId: string | null
  worktreeDragState: WorktreeRowDragState
  nativeLineageDropTargetId: string | null
  activeWorktreeId: string | null
  activeWorkspaceExecutionHostId: ExecutionHostId | null
  currentWorktreeId: string | null
  highlightedRevealRowKey: string | null
  selectedWorktreeIds: ReadonlySet<string>
  selectedWorktrees: readonly Worktree[]
  getActiveSurfaceVariant: (row: WorktreeItemRow) => ActiveSurfaceVariant
  getLineageToggleHandler: (groupKey: string) => LineageToggleHandler
  /** Group by branch cards key their host choice by row key. */
  branchGroupSelection: Readonly<Record<string, ExecutionHostId>>
  onSelectBranchGroupHost: (groupKey: string, hostId: ExecutionHostId) => void
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

// Handle plain rows, inherited lineage offsets and folder-backed project geometry separately.
function getWorktreeItemRowGeometry(
  ctx: WorktreeItemRowContext,
  itemRow: WorktreeItemRow,
  nested: boolean
): { surfaceInset: number; cardContentIndent: number } {
  // Why: the shared child wrapper already inherits the parent's group and content offsets.
  if (nested) {
    return { surfaceInset: LINEAGE_NESTED_ROW_SURFACE_INSET, cardContentIndent: 0 }
  }

  const projectGroupId = itemRow.repo?.projectGroupId
  const isFolderBackedRepoChild =
    ctx.groupBy === 'repo' &&
    Boolean(projectGroupId && ctx.folderBackedProjectGroupIds.has(projectGroupId))
  const getCardContentIndent = (lineageDepth: number): number =>
    isFolderBackedRepoChild
      ? getFolderBackedRepoWorktreeCardContentIndent({
          groupDepth: itemRow.groupDepth,
          lineageDepth
        })
      : getWorktreeCardContentIndent({
          isGrouped: ctx.groupBy !== 'none',
          groupDepth: itemRow.groupDepth,
          lineageDepth
        })
  const paddingLeft = getCardContentIndent(itemRow.depth)
  const surfaceInset = isFolderBackedRepoChild
    ? getFolderBackedRepoWorktreeCardSurfaceInset({
        groupDepth: itemRow.groupDepth,
        lineageDepth: itemRow.depth
      })
    : getWorktreeCardSurfaceInset({
        isGrouped: ctx.groupBy !== 'none',
        groupDepth: itemRow.groupDepth
      })
  return {
    surfaceInset,
    cardContentIndent: Math.max(0, paddingLeft - surfaceInset)
  }
}

export function renderWorktreeItemRow(
  ctx: WorktreeItemRowContext,
  itemRow: WorktreeItemRow,
  nested: boolean,
  lineageChildren?: React.ReactNode,
  forceActiveSurface = false
): React.JSX.Element {
  const { surfaceInset, cardContentIndent } = getWorktreeItemRowGeometry(ctx, itemRow, nested)
  const lineageChildrenStyle = lineageChildren
    ? getLineageChildrenInlineStyle(LINEAGE_CHILDREN_INLINE_OFFSET)
    : undefined
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
    (ctx.worktreeDragState.lineageDropTargetId === itemRow.worktree.id ||
      ctx.nativeLineageDropTargetId === itemRow.worktree.id)
  const isActiveWorktree =
    Boolean(branchSelection?.isActiveGroup) ||
    isActiveSidebarWorkspace(cardWorktree, {
      worktreeId: ctx.activeWorktreeId,
      hostId: ctx.activeWorkspaceExecutionHostId ?? null
    })
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
      onClick={(event) => {
        forwardOptionPressToCardSurface(event)
        // Why: nested child cards live inside the parent's clickable body; bubbling would activate/edit the parent too.
        if (nested) {
          event.stopPropagation()
        }
      }}
      onClickCapture={ctx.onRowClickCapture}
      onDoubleClick={nested ? stopNestedWorktreeCardBubble : undefined}
      onDragStart={nested ? stopNestedWorktreeCardBubble : undefined}
      onPointerDown={(event) => {
        if (nested) {
          event.stopPropagation()
        }
        ctx.onRowPointerDown(event, cardWorktree, itemRow.rowKey)
      }}
      style={{
        paddingLeft: surfaceInset > 0 ? `${surfaceInset}px` : undefined
      }}
    >
      <WorktreeCard
        worktree={cardWorktree}
        repo={cardRepo}
        isActive={isActiveWorktree}
        isCurrentWorktree={ctx.currentWorktreeId === cardWorktree.id}
        // Why: a child-active parent should look active without the active-card side effects (e.g. SSH reconnect UI).
        isActiveSurface={forceActiveSurface || isActiveWorktree}
        activeSurfaceVariant={
          isActiveWorktree && !forceActiveSurface ? ctx.getActiveSurfaceVariant(itemRow) : 'primary'
        }
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
        lineageCollapsed={itemRow.lineageCollapsed}
        lineageChildren={lineageChildren}
        lineageChildrenStyle={lineageChildrenStyle}
        branchGroup={itemRow.branchGroup}
        selectedBranchHostId={selectedBranchHostId}
        branchGroupKey={itemRow.branchGroupKey}
        onSelectBranchHost={ctx.onSelectBranchGroupHost}
        onLineageToggle={
          itemRow.lineageGroupKey ? ctx.getLineageToggleHandler(itemRow.lineageGroupKey) : undefined
        }
      />
    </div>
  )
}

// Rebuild the visible lineage subtree so each card renders its own children inline.
export function renderWorktreeLineageDescendants(
  ctx: WorktreeItemRowContext,
  parent: WorktreeItemRow,
  descendants: readonly WorktreeItemRow[]
): React.ReactNode | undefined {
  const childNodes: React.ReactNode[] = []
  let cursor = 0
  while (cursor < descendants.length) {
    const child = descendants[cursor]
    if (!child || child.depth !== parent.depth + 1) {
      cursor++
      continue
    }

    let nextSiblingIndex = cursor + 1
    while (
      nextSiblingIndex < descendants.length &&
      descendants[nextSiblingIndex]!.depth > child.depth
    ) {
      nextSiblingIndex++
    }

    const childLineageChildren = renderWorktreeLineageDescendants(
      ctx,
      child,
      descendants.slice(cursor + 1, nextSiblingIndex)
    )
    childNodes.push(renderWorktreeItemRow(ctx, child, true, childLineageChildren))
    cursor = nextSiblingIndex
  }
  return childNodes.length > 0 ? childNodes : undefined
}
