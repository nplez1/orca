import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../shared/constants'
import { useAppStore } from '../../store'
import { armFloatingPanelReclaimIntent } from '@/lib/floating-workspace-focus-reclaim'
import { isFloatingWorkspacePanelFocused } from '@/lib/floating-workspace-terminal-actions'
import { selectFloatingVisibleTabCount } from '@/store/selectors'

const NO_REACTION = (): void => {}

/**
 * What a close does if it leaves its workspace with no tabs. Capture it when the close is requested
 * and run it once the close lands: removing the focused pane blurs it, so panel ownership has to be
 * read up front.
 */
export function captureWorkspaceEmptiedReaction(
  worktreeId: string,
  options?: { floatingPanelGuestOwned?: boolean }
): () => void {
  // Why per workspace: an emptied worktree stays selected and renders its own empty-tabs surface,
  // so the close has nothing to hand back (#96). The floating panel is never the active worktree —
  // emptying it from inside instead keeps keyboard ownership for the next Cmd/Ctrl+T.
  if (worktreeId !== FLOATING_TERMINAL_WORKTREE_ID) {
    return NO_REACTION
  }
  const panelOwned = options?.floatingPanelGuestOwned === true || isFloatingWorkspacePanelFocused()
  return () => {
    if (panelOwned && selectFloatingVisibleTabCount(useAppStore.getState()) === 0) {
      armFloatingPanelReclaimIntent()
    }
  }
}
