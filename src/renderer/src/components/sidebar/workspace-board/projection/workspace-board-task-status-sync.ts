import { getLinearSourceScope } from '@/store/slices/linear/linear-slice-scope'
import { confirmLinearIssueWrite } from '@/store/slices/linear/linear-issue-publication'
import { linearGetIssue, linearUpdateIssue } from '@/runtime/linear/runtime-linear-issue-client'
import { linearTeamStates } from '@/runtime/linear/runtime-linear-project-client'
import type {
  LinearMutationResult,
  RuntimeLinearSettings
} from '@/runtime/linear/runtime-linear-client'
import type { LinearIssue } from '../../../../../../shared/linear/issue-types'
import type { LinearWorkflowState } from '../../../../../../shared/linear/workspace-types'
import type {
  WorkspaceStatus,
  WorkspaceStatusDefinition,
  Worktree
} from '../../../../../../shared/worktree/types'
import type { Repo } from '../../../../../../shared/repo-types'
import {
  defaultJiraStatusSyncDeps,
  syncJiraWorktreeStatus,
  type JiraIssueTransitioned,
  type JiraStatusSyncDeps,
  type JiraStatusSyncMessage
} from './workspace-board-jira-status-sync'

export type WorkspaceBoardTaskStatusSyncResult = {
  updated: number
  skipped: number
  failed: number
  messages: WorkspaceBoardTaskStatusSyncMessage[]
}

export type WorkspaceBoardTaskStatusSyncMessage =
  | { kind: 'issue-read-failed'; issueIdentifier: string }
  | { kind: 'missing-workflow-state'; statusLabel: string }
  | { kind: 'ambiguous-workflow-state'; statusLabel: string }
  | { kind: 'update-failed'; issueIdentifier: string; detail?: string }
  | { kind: 'provider-error'; issueIdentifier: string; detail?: string }
  | { kind: 'owner-ambiguous'; issueIdentifier: string }
  | { kind: 'unexpected-error'; detail?: string }
  | JiraStatusSyncMessage

type WorkspaceBoardTaskStatusSyncDependencies = {
  getIssue: typeof linearGetIssue
  teamStates: typeof linearTeamStates
  updateIssue: typeof linearUpdateIssue
}

/** Cards are keyed by host identity: same-id copies on two hosts each sync their own linked issue. */
export type SyncWorkspaceBoardTaskStatusesArgs = {
  worktreeKeys: readonly string[]
  targetStatus: WorkspaceStatusDefinition
  worktreesByKey: ReadonlyMap<string, Worktree>
  settings?: RuntimeLinearSettings
  /** `null` refuses the worktree: its owner is ambiguous, so no host's Linear settings apply. */
  getSettingsForWorktree?: (worktreeKey: string) => RuntimeLinearSettings | null
  getLatestWorkspaceStatus: (worktreeKey: string) => WorkspaceStatus | null | undefined
  /** The card's repository row, so a Jira source built from the workspace names its account host. */
  getRepoForWorktree?: (worktreeKey: string) => Repo | undefined
  deps?: Partial<WorkspaceBoardTaskStatusSyncDependencies>
  jiraDeps?: Partial<JiraStatusSyncDeps>
  /** Patches the provider cache after a Jira transition, so a pane does not show the old status. */
  onJiraIssueTransitioned?: (transition: JiraIssueTransitioned) => void
}

const defaultDeps: WorkspaceBoardTaskStatusSyncDependencies = {
  getIssue: linearGetIssue,
  teamStates: linearTeamStates,
  updateIssue: linearUpdateIssue
}

const worktreeSyncQueues = new Map<string, Promise<unknown>>()

function emptyResult(): WorkspaceBoardTaskStatusSyncResult {
  return { updated: 0, skipped: 0, failed: 0, messages: [] }
}

function normalizeStateName(name: string): string {
  return name.trim().toLowerCase()
}

function matchingWorkflowStates(
  states: readonly LinearWorkflowState[],
  targetStatus: WorkspaceStatusDefinition
): LinearWorkflowState[] {
  const targetName = normalizeStateName(targetStatus.label)
  return states.filter((state) => normalizeStateName(state.name) === targetName)
}

function getMessageKey(message: WorkspaceBoardTaskStatusSyncMessage): string {
  return JSON.stringify(message)
}

function addMessage(
  result: WorkspaceBoardTaskStatusSyncResult,
  message: WorkspaceBoardTaskStatusSyncMessage
): void {
  const key = getMessageKey(message)
  if (!result.messages.some((item) => getMessageKey(item) === key)) {
    result.messages.push(message)
  }
}

function skipped(
  result: WorkspaceBoardTaskStatusSyncResult,
  message?: WorkspaceBoardTaskStatusSyncMessage
): WorkspaceBoardTaskStatusSyncResult {
  result.skipped += 1
  if (message) {
    addMessage(result, message)
  }
  return result
}

function failed(
  result: WorkspaceBoardTaskStatusSyncResult,
  message: WorkspaceBoardTaskStatusSyncMessage
): WorkspaceBoardTaskStatusSyncResult {
  result.failed += 1
  addMessage(result, message)
  return result
}

function isAlreadyInState(issue: LinearIssue, workflowState: LinearWorkflowState): boolean {
  return (
    normalizeStateName(issue.state.name) === normalizeStateName(workflowState.name) &&
    issue.state.type === workflowState.type
  )
}

function mergeResult(
  aggregate: WorkspaceBoardTaskStatusSyncResult,
  item: WorkspaceBoardTaskStatusSyncResult
): void {
  aggregate.updated += item.updated
  aggregate.skipped += item.skipped
  aggregate.failed += item.failed
  for (const message of item.messages) {
    addMessage(aggregate, message)
  }
}

async function enqueueWorktreeSync(
  worktreeKey: string,
  task: () => Promise<WorkspaceBoardTaskStatusSyncResult>
): Promise<WorkspaceBoardTaskStatusSyncResult> {
  const previous = worktreeSyncQueues.get(worktreeKey) ?? Promise.resolve()
  const next = previous.catch(() => undefined).then(task)
  const cleanup = next.finally(() => {
    if (worktreeSyncQueues.get(worktreeKey) === cleanup) {
      worktreeSyncQueues.delete(worktreeKey)
    }
  })
  worktreeSyncQueues.set(worktreeKey, cleanup)
  return next
}

async function syncLinearWorktreeStatus(
  args: SyncWorkspaceBoardTaskStatusesArgs,
  worktreeKey: string,
  deps: WorkspaceBoardTaskStatusSyncDependencies
): Promise<WorkspaceBoardTaskStatusSyncResult> {
  const result = emptyResult()
  const worktree = args.worktreesByKey.get(worktreeKey)
  if (!worktree?.linkedLinearIssue) {
    return skipped(result)
  }

  // Legacy callers without source settings route to this computer.
  const settings = args.getSettingsForWorktree
    ? args.getSettingsForWorktree(worktreeKey)
    : (args.settings ?? { kind: 'local' })
  if (!settings) {
    return skipped(result, { kind: 'owner-ambiguous', issueIdentifier: worktree.linkedLinearIssue })
  }
  const scope = getLinearSourceScope(settings)
  const linkedWorkspaceId = worktree.linkedLinearIssueWorkspaceId ?? undefined

  try {
    const issue = await deps.getIssue(settings, worktree.linkedLinearIssue, linkedWorkspaceId)
    if (!issue?.team?.id) {
      return skipped(result, {
        kind: 'issue-read-failed',
        issueIdentifier: worktree.linkedLinearIssue
      })
    }

    const workspaceId = linkedWorkspaceId ?? issue.workspaceId
    const states = await deps.teamStates(settings, issue.team.id, workspaceId)
    const matches = matchingWorkflowStates(states, args.targetStatus)
    if (matches.length === 0) {
      return skipped(result, {
        kind: 'missing-workflow-state',
        statusLabel: args.targetStatus.label
      })
    }
    if (matches.length > 1) {
      return skipped(result, {
        kind: 'ambiguous-workflow-state',
        statusLabel: args.targetStatus.label
      })
    }

    const [workflowState] = matches
    if (isAlreadyInState(issue, workflowState)) {
      return skipped(result)
    }

    // Board moves are local-first; a slow provider read must not let an older move overwrite a newer one.
    if (args.getLatestWorkspaceStatus(worktreeKey) !== args.targetStatus.id) {
      return skipped(result)
    }

    const updateResult: LinearMutationResult = await deps.updateIssue(
      settings,
      issue.id,
      { stateId: workflowState.id },
      workspaceId
    )
    if (updateResult.ok === false) {
      return failed(result, {
        kind: 'update-failed',
        issueIdentifier: issue.identifier,
        detail: updateResult.error
      })
    }
    confirmLinearIssueWrite({ scope, id: issue.id })
    result.updated += 1
    return result
  } catch (error) {
    return failed(result, {
      kind: 'provider-error',
      issueIdentifier: worktree.linkedLinearIssue,
      detail: error instanceof Error ? error.message : undefined
    })
  }
}

/** One tracker write per card: Linear's slot wins, then a Jira link, then nothing to sync. */
async function syncWorktreeTaskStatus(
  args: SyncWorkspaceBoardTaskStatusesArgs,
  worktreeKey: string,
  deps: WorkspaceBoardTaskStatusSyncDependencies,
  jiraDeps: JiraStatusSyncDeps
): Promise<WorkspaceBoardTaskStatusSyncResult> {
  const worktree = args.worktreesByKey.get(worktreeKey)
  // Why the Linear slot first: a workspace linked to both synced Linear before Jira existed.
  if (worktree?.linkedLinearIssue) {
    return syncLinearWorktreeStatus(args, worktreeKey, deps)
  }
  const result = emptyResult()
  if (!worktree) {
    return result
  }
  const outcome = await syncJiraWorktreeStatus(
    {
      worktree,
      repo: args.getRepoForWorktree?.(worktreeKey),
      targetStatus: args.targetStatus,
      // Why not `??`: a present callback answering null is an ambiguous owner, not a fallback.
      settings: args.getSettingsForWorktree
        ? args.getSettingsForWorktree(worktreeKey)
        : (args.settings ?? { kind: 'local' }),
      getLatestWorkspaceStatus: () => args.getLatestWorkspaceStatus(worktreeKey)
    },
    jiraDeps
  )
  if (outcome.status === 'updated') {
    args.onJiraIssueTransitioned?.(outcome)
    result.updated += 1
    return result
  }
  return outcome.status === 'failed'
    ? failed(result, outcome.message)
    : skipped(result, outcome.message)
}

export async function syncWorkspaceBoardTaskStatuses(
  args: SyncWorkspaceBoardTaskStatusesArgs
): Promise<WorkspaceBoardTaskStatusSyncResult> {
  const deps = { ...defaultDeps, ...args.deps }
  const jiraDeps = { ...defaultJiraStatusSyncDeps, ...args.jiraDeps }
  const aggregate = emptyResult()

  const uniqueKeys = new Set(args.worktreeKeys)
  await Promise.all(
    [...uniqueKeys].map(async (worktreeKey) => {
      const item = await enqueueWorktreeSync(worktreeKey, () =>
        syncWorktreeTaskStatus(args, worktreeKey, deps, jiraDeps)
      )
      mergeResult(aggregate, item)
    })
  )

  return aggregate
}
