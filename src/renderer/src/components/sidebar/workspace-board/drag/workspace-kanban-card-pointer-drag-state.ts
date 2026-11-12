import type { WorkspaceKanbanCardTrackedDropTarget } from './workspace-kanban-card-pointer-drag-dom'

/** One in-flight board pointer drag; the hook mutates it per frame instead of re-rendering. */
export type WorkspaceKanbanCardPointerDragState = {
  pointerId: number
  startX: number
  startY: number
  currentX: number
  currentY: number
  worktreeIds: string[]
  worktreeIdentities: string[]
  worktreeKeys: string[]
  sourceCard: HTMLElement
  preview: HTMLElement | null
  previewOffsetX: number
  previewOffsetY: number
  started: boolean
  frameId: number | null
  latestDropTarget: WorkspaceKanbanCardTrackedDropTarget | null
}
