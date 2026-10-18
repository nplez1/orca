import {
  activateAndRevealFolderWorkspace,
  activateAndRevealWorktree,
  type ActivateAndRevealResult
} from '@/lib/worktree-activation'
import { parseWorkspaceKey } from '../../../shared/workspace-scope'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import type { ExecutionHostId } from '../../../shared/execution-host'
import { refreshEphemeralVmRuntimesAfterMutation } from '@/hooks/useEphemeralVmRuntimes'

// Why: a sidebar click must switch app state before any wake round-trip, so the
// wake is fire-and-forget and the caller still gets the synchronous activation.
async function wakeEphemeralVmWorkspace(worktreeId: string): Promise<void> {
  if (typeof window === 'undefined' || !window.api?.ephemeralVm?.resumeWorkspace) {
    return
  }
  try {
    const runtime = await window.api.ephemeralVm.resumeWorkspace({ workspaceId: worktreeId })
    // Why: a wake can change the lease surfaces (a resumed host is no longer released).
    refreshEphemeralVmRuntimesAfterMutation()
    if (runtime?.runtimeEnvironmentId) {
      const store = (await import('@/store')).useAppStore
      store.getState().setRuntimeEnvironments(await window.api.runtimeEnvironments.list())
      await store.getState().refreshRuntimeEnvironmentStatus(runtime.runtimeEnvironmentId)
    }
  } catch (error) {
    toast.error(
      translate(
        'auto.lib.sidebarWorktreeActivation.wakeEphemeralVmFailed',
        'Failed to wake ephemeral VM workspace'
      ),
      {
        description: error instanceof Error ? error.message : String(error)
      }
    )
  }
}

export function activateWorktreeFromSidebar(
  worktreeId: string,
  executionHostId?: ExecutionHostId
): ActivateAndRevealResult | false {
  const workspaceScope = parseWorkspaceKey(worktreeId)
  if (workspaceScope?.type === 'folder') {
    return activateAndRevealFolderWorkspace(workspaceScope.folderWorkspaceId, {
      navigationIntent: 'user-open',
      ...(executionHostId ? { executionHostId } : {})
    })
  }
  // Keep navigation independent from an optional runtime wake IPC.
  const activation = activateAndRevealWorktree(worktreeId, {
    navigationIntent: 'user-open',
    revealInSidebar: false,
    ...(executionHostId ? { executionHostId } : {})
  })
  void wakeEphemeralVmWorkspace(worktreeId)
  return activation
}
