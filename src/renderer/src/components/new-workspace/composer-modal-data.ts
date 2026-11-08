import type { ExecutionHostId } from '../../../../shared/execution-host'
import type { GitHubWorkItem } from '../../../../shared/github/work-item-types'
import type { LinkedWorkItemSummary } from '@/lib/new-workspace'
import type { WorkspaceCreationTargetHint } from '@/lib/project-host-workspace-target'
import type { TaskSourceContext } from '../../../../shared/task-source-context'
import type { WorkspaceSource as WorkspaceCreateTelemetrySource } from '../../../../shared/workspace-source'
import type { GitPushTarget, WorkspaceStatus } from '../../../../shared/worktree/types'

/** What an opener hands the new-workspace composer. */
export type ComposerModalData = {
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
  /** The remote the copied branch publishes to, which the target host has to recreate. */
  lockedWorkspacePushTarget?: GitPushTarget
  /** Host the copied workspace already lives on; recreating it there would only rename the branch. */
  lockedWorkspaceSourceHostId?: ExecutionHostId
  /** Paired-runtime owner of the source workspace, which counts as the same host. */
  lockedWorkspaceSourceRuntimeOwnerEnvironmentId?: string
  initialWorkspaceStatus?: WorkspaceStatus
  enableIssueAutomation?: boolean
  /** Creation-surface telemetry; each opener supplies it, otherwise use unknown. */
  telemetrySource?: WorkspaceCreateTelemetrySource
  contextualTourSource?: string
  setupGuideTourRequestId?: string
}
