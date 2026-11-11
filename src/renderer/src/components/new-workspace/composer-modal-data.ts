import type {
  AgentPickerDraft,
  AgentPickerEntry
} from '../../../../shared/agent-launch/picker/agent-launch-picker'
import type { AgentLaunchSurface } from '@/lib/agent-session/launch/routing/agent-session-launch-plan'
import type { DirectWorkItemSetupRequest } from '@/lib/workspace/creation/work-item/direct-work-item-setup'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import type { GitHubWorkItem } from '../../../../shared/github/work-item-types'
import type { LinkedWorkItemSummary } from '@/lib/new-workspace'
import type { WorkspaceCreationTargetHint } from '@/lib/project-host-workspace-target'
import type { TaskSourceContext } from '../../../../shared/work-items/task-source-context'
import type { TuiAgent } from '../../../../shared/agent-launch/catalog/tui-agent'
import type { WorkspaceSource as WorkspaceCreateTelemetrySource } from '../../../../shared/workspace-source'
import type { GitPushTarget, WorkspaceStatus } from '../../../../shared/worktree/types'

/** What an opener hands the new-workspace composer. */
export type ComposerModalData = {
  recovery?: {
    note: string
    agent: TuiAgent | null
    surface?: AgentLaunchSurface
    draft?: AgentPickerDraft
    entry?: AgentPickerEntry
    contextKey?: string
  }
  directSetup?: DirectWorkItemSetupRequest
  prefilledName?: string
  initialRepoId?: string
  initialEphemeralVmRecipeId?: string
  initialProjectGroupId?: string
  linkedWorkItem?: LinkedWorkItemSummary | null
  initialGitHubWorkItem?: GitHubWorkItem | null
  taskSourceContext?: TaskSourceContext | null
  initialWorkspaceTarget?: WorkspaceCreationTargetHint | null
  initialBaseBranch?: string
  /** Set when an existing workspace is being copied to another host: the name and branch are
   *  implied by that workspace, so the composer shows them as fixed facts. */
  lockedWorkspaceBranch?: string
  // fork-comment-ok: the clone of a primary checkout is the copy; of any other, it is not.
  lockedWorkspaceIsPrimary?: boolean
  /** The remote the copied branch publishes to, which the target host has to recreate. */
  lockedWorkspacePushTarget?: GitPushTarget
  /** Host the copied workspace already lives on; recreating it there would only rename the branch. */
  lockedWorkspaceSourceHostId?: ExecutionHostId
  /** Paired-runtime owner of the source workspace, which counts as the same host. */
  lockedWorkspaceSourceRuntimeOwnerEnvironmentId?: string
  initialParentWorktreeId?: string
  initialWorkspaceStatus?: WorkspaceStatus
  enableIssueAutomation?: boolean
  /** Creation-surface telemetry; each opener supplies it, otherwise use unknown. */
  telemetrySource?: WorkspaceCreateTelemetrySource
  contextualTourSource?: string
  setupGuideTourRequestId?: string
}
