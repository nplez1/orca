import type { ExecutionHostId } from '../../../shared/execution-host'
import type { Worktree } from '../../../shared/worktree/types'
import { revealRepoInProjectFilter } from '@/components/sidebar/project-filter-reveal'
import { isDetachedHeadWorkspace } from '@/components/sidebar/visible-worktrees'
import type { useAppStore } from '@/store'
import type { PendingSidebarWorktreeReveal } from '@/store/slices/ui'

type SidebarRevealState = ReturnType<typeof useAppStore.getState>

type SidebarRevealActivationOptions = {
  clearSidebarFilters?: boolean
  revealInSidebar?: boolean
  sidebarRevealBehavior?: PendingSidebarWorktreeReveal['behavior']
  executionHostId?: ExecutionHostId
}

export function revealWorktreeInSidebarForActivation(
  state: SidebarRevealState,
  worktreeId: string,
  worktree: Worktree,
  opts?: SidebarRevealActivationOptions
): void {
  // Why: reveal needs the card rendered, else it silently no-ops.
  if (opts?.clearSidebarFilters !== false) {
    revealRepoInProjectFilter(state, worktree.repoId)
    if (
      state.hideAutomationGeneratedWorkspaces &&
      worktree.automationProvenance?.kind === 'created-by-automation'
    ) {
      state.setHideAutomationGeneratedWorkspaces(false)
    }
    if (state.hideCliCreatedWorkspaces && worktree.cliProvenance?.kind === 'created-by-cli') {
      state.setHideCliCreatedWorkspaces(false)
    }
    if (state.hideDetachedHeadWorkspaces && isDetachedHeadWorkspace(worktree)) {
      state.setHideDetachedHeadWorkspaces(false)
    }
    if (
      worktree.workspaceStatus &&
      state.hiddenWorkspaceStatusIds.includes(worktree.workspaceStatus)
    ) {
      state.setHiddenWorkspaceStatusIds(
        state.hiddenWorkspaceStatusIds.filter((id) => id !== worktree.workspaceStatus)
      )
    }
  }

  if (opts?.revealInSidebar !== false) {
    if (opts?.sidebarRevealBehavior || opts?.executionHostId) {
      state.revealWorktreeInSidebar(worktreeId, {
        ...(opts.sidebarRevealBehavior ? { behavior: opts.sidebarRevealBehavior } : {}),
        ...(opts.executionHostId ? { executionHostId: opts.executionHostId } : {})
      })
    } else {
      state.revealWorktreeInSidebar(worktreeId)
    }
  }
}

export function revealFolderWorkspaceInSidebar(
  state: SidebarRevealState,
  workspaceKey: string,
  opts?: Pick<SidebarRevealActivationOptions, 'revealInSidebar' | 'sidebarRevealBehavior'>
): void {
  if (opts?.revealInSidebar !== false) {
    state.revealWorktreeInSidebar(
      workspaceKey,
      opts?.sidebarRevealBehavior ? { behavior: opts.sidebarRevealBehavior } : undefined
    )
  }
}
