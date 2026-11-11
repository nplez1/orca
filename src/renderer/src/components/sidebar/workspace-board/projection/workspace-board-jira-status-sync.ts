import {
  jiraGetIssue,
  jiraListTransitions,
  jiraUpdateIssue
} from '@/runtime/jira/runtime-jira-client'
import { getJiraRuntimeTarget, type RuntimeJiraSettings } from '@/runtime/jira/runtime-jira-target'
import {
  getSingleJiraProjectScope,
  getTaskPageJiraStatusOrderRuntimeScopeKey,
  loadTaskPageJiraProjectStatusOrder
} from '@/components/task-page/jira/task-page-jira-status-order'
import { getTaskPageJiraBoardTransitionTargets } from '@/components/task-page-jira-board-model'
import {
  resolveIssuePaneIssues,
  type SupportedWorkspaceLinkedIssue
} from '@/components/right-sidebar/workspace-linked-issue'
import { getWorkspaceAttachmentSourceContext } from '@/components/sidebar/workspace-card/review/workspace-attachment-source-result'
import { classifyTransitionRequirements } from '../../../../../../shared/jira/jira-transition-fields'
import type {
  JiraBoardColumn,
  JiraIssue,
  JiraStatus,
  JiraTransition
} from '../../../../../../shared/jira/jira-types'
import type {
  WorkspaceStatus,
  WorkspaceStatusDefinition,
  Worktree
} from '../../../../../../shared/worktree/types'
import type { TaskSourceContext } from '../../../../../../shared/work-items/task-source-context'
import type { Repo } from '../../../../../../shared/repo-types'

/** The Jira failures a board move can report; the board owns the copy for each. */
export type JiraStatusSyncMessage =
  | { kind: 'jira-issue-read-failed'; issueKey: string }
  | { kind: 'jira-missing-transition'; statusLabel: string }
  | { kind: 'jira-ambiguous-transition'; statusLabel: string }
  | { kind: 'jira-transition-needs-fields'; issueKey: string; statusLabel: string }
  | { kind: 'jira-update-failed'; issueKey: string; detail?: string }
  | { kind: 'jira-provider-error'; issueKey: string; detail?: string }
  | { kind: 'jira-owner-ambiguous'; issueKey: string }

/** What the store needs to stop showing the issue's previous status without a refetch. */
export type JiraIssueTransitioned = {
  issue: JiraIssue
  to: JiraStatus
  source: RuntimeJiraSettings
}

export type JiraStatusSyncOutcome =
  | ({ status: 'updated' } & JiraIssueTransitioned)
  | { status: 'skipped'; message?: JiraStatusSyncMessage }
  | { status: 'failed'; message: JiraStatusSyncMessage }

export type JiraStatusSyncDeps = {
  getIssue: typeof jiraGetIssue
  listTransitions: typeof jiraListTransitions
  updateIssue: typeof jiraUpdateIssue
  loadStatusOrder: typeof loadTaskPageJiraProjectStatusOrder
}

export const defaultJiraStatusSyncDeps: JiraStatusSyncDeps = {
  getIssue: jiraGetIssue,
  listTransitions: jiraListTransitions,
  updateIssue: jiraUpdateIssue,
  loadStatusOrder: loadTaskPageJiraProjectStatusOrder
}

export type SyncJiraWorktreeStatusArgs = {
  worktree: Worktree
  /** The workspace's repository, so the fallback source routes through the account its row names. */
  repo?: Repo
  targetStatus: WorkspaceStatusDefinition
  /** The workspace owner's host, or `null` when its captured copy is gone or ambiguous. */
  settings: RuntimeJiraSettings | null
  getLatestWorkspaceStatus: () => WorkspaceStatus | null | undefined
}

// One board's cache scope; the status order is keyed by runtime and project, not by issue.
const SYNC_SCOPE_KEY = 'workspace-board-status-sync'

type LinkedJiraIssue = Extract<SupportedWorkspaceLinkedIssue, { provider: 'jira' }>

type TransitionMatch =
  | { kind: 'found'; transition: JiraTransition }
  | { kind: 'already-there' }
  | { kind: 'missing' }
  | { kind: 'ambiguous' }

function normalizeName(name: string): string {
  return name.trim().toLowerCase()
}

/** The workspace's active issue when it is a Jira link, resolved the way the issue pane does. */
function activeJiraIssue(
  worktree: Worktree
): { issue: LinkedJiraIssue; sourceContext: TaskSourceContext | null } | null {
  const active = resolveIssuePaneIssues(worktree)[0]
  return active?.issue.provider === 'jira'
    ? { issue: active.issue, sourceContext: active.sourceContext }
    : null
}

function linkedSiteId(source: RuntimeJiraSettings): string | null {
  if (source.kind !== 'task-source') {
    return null
  }
  const identity = source.provider === 'jira' ? source.providerIdentity : null
  return identity?.provider === 'jira' ? (identity.siteId ?? null) : null
}

/** Why the field-free candidate: a transition that needs a form cannot be filled from a card move. */
function pickTransition(candidates: readonly JiraTransition[]): JiraTransition {
  return (
    candidates.find((transition) => classifyTransitionRequirements(transition).kind === 'none') ??
    candidates[0]
  )
}

/** Several transitions to one destination are interchangeable; to different ones is a guess. */
function matchDestination(candidates: readonly JiraTransition[]): TransitionMatch {
  if (candidates.length === 0) {
    return { kind: 'missing' }
  }
  if (new Set(candidates.map((item) => item.to.id)).size > 1) {
    return { kind: 'ambiguous' }
  }
  return { kind: 'found', transition: pickTransition(candidates) }
}

async function columnsNamed(
  args: SyncJiraWorktreeStatusArgs,
  source: RuntimeJiraSettings,
  issue: JiraIssue,
  siteId: string | null,
  deps: JiraStatusSyncDeps
): Promise<JiraBoardColumn[]> {
  const scope = getSingleJiraProjectScope([{ ...issue, siteId: siteId ?? undefined }])
  if (!scope) {
    return []
  }
  // Why cached and best-effort: a project with no single proven board answers no columns, and the
  // board column is only ever the fallback for a name that matched no status.
  const order = await deps.loadStatusOrder(
    source,
    getTaskPageJiraStatusOrderRuntimeScopeKey(SYNC_SCOPE_KEY, getJiraRuntimeTarget(source)),
    scope
  )
  const target = normalizeName(args.targetStatus.label)
  return (order.columns ?? []).filter((column) => normalizeName(column.name) === target)
}

async function resolveTransition(
  args: SyncJiraWorktreeStatusArgs,
  source: RuntimeJiraSettings,
  issue: JiraIssue,
  transitions: readonly JiraTransition[],
  siteId: string | null,
  deps: JiraStatusSyncDeps
): Promise<TransitionMatch> {
  const columns = await columnsNamed(args, source, issue, siteId, deps)
  const [column] = columns
  // Why the column before the name: a column groups several statuses, so an issue sitting in a
  // sibling status of the card's own column is already where the user dropped it — and a name match
  // would otherwise move it between two statuses the user sees as one lane.
  if (columns.length === 1 && column.statusIds.includes(issue.status.id)) {
    return { kind: 'already-there' }
  }
  const target = normalizeName(args.targetStatus.label)
  const byName = transitions.filter((transition) => normalizeName(transition.to.name) === target)
  if (byName.length > 0) {
    return matchDestination(byName)
  }
  if (columns.length > 1) {
    return { kind: 'ambiguous' }
  }
  if (columns.length === 0) {
    return { kind: 'missing' }
  }
  return matchDestination(getTaskPageJiraBoardTransitionTargets(transitions, column.statusIds))
}

/**
 * Moves a Jira-linked workspace's issue to the card's status. Name match first because it is the
 * cheapest and the workspace label is a name; the Jira board column of that name is the fallback,
 * since a column groups several statuses and is what the Tasks board drops into.
 */
export async function syncJiraWorktreeStatus(
  args: SyncJiraWorktreeStatusArgs,
  deps: JiraStatusSyncDeps
): Promise<JiraStatusSyncOutcome> {
  const active = activeJiraIssue(args.worktree)
  if (!active) {
    return { status: 'skipped' }
  }
  const issueKey = active.issue.key
  if (!args.settings) {
    return { status: 'skipped', message: { kind: 'jira-owner-ambiguous', issueKey } }
  }
  // Why the attachment's own account first: the link records the site it was attached from, so a
  // workspace linked to another site must not read back through whichever site is selected now.
  const source =
    active.sourceContext ?? getWorkspaceAttachmentSourceContext('jira', args.repo, args.worktree)
  if (!source) {
    return { status: 'skipped' }
  }
  const linkedSite = linkedSiteId(source)
  try {
    const issue = await deps.getIssue(source, issueKey, linkedSite)
    if (!issue) {
      return { status: 'skipped', message: { kind: 'jira-issue-read-failed', issueKey } }
    }
    // Why before the transitions read: a card moved back to the status its issue already holds owes Jira nothing.
    if (normalizeName(issue.status.name) === normalizeName(args.targetStatus.label)) {
      return { status: 'skipped' }
    }
    const siteId = issue.siteId ?? linkedSite
    const transitions = await deps.listTransitions(source, issue.key, siteId)
    const match = await resolveTransition(args, source, issue, transitions, siteId, deps)
    if (match.kind === 'already-there') {
      return { status: 'skipped' }
    }
    if (match.kind === 'missing') {
      return {
        status: 'skipped',
        message: { kind: 'jira-missing-transition', statusLabel: args.targetStatus.label }
      }
    }
    if (match.kind === 'ambiguous') {
      return {
        status: 'skipped',
        message: { kind: 'jira-ambiguous-transition', statusLabel: args.targetStatus.label }
      }
    }
    // Why reported, not submitted: the board has no form for a transition's required fields.
    if (classifyTransitionRequirements(match.transition).kind !== 'none') {
      return {
        status: 'skipped',
        message: {
          kind: 'jira-transition-needs-fields',
          issueKey: issue.key,
          statusLabel: args.targetStatus.label
        }
      }
    }
    // Board moves are local-first; a slow provider read must not let an older move overwrite a newer one.
    if (args.getLatestWorkspaceStatus() !== args.targetStatus.id) {
      return { status: 'skipped' }
    }
    const result = await deps.updateIssue(
      source,
      issue.key,
      { transitionId: match.transition.id },
      siteId
    )
    if (!result.ok) {
      return {
        status: 'failed',
        message: { kind: 'jira-update-failed', issueKey: issue.key, detail: result.error }
      }
    }
    return { status: 'updated', issue, to: match.transition.to, source }
  } catch (error) {
    return {
      status: 'failed',
      message: {
        kind: 'jira-provider-error',
        issueKey,
        detail: error instanceof Error ? error.message : undefined
      }
    }
  }
}
