import type { LinearIssue } from '../../../shared/linear/issue-types'
import type { RuntimeLinearSettings } from '../runtime/linear/runtime-linear-client'
import type { TaskSourceContext } from '../../../shared/work-items/task-source-context'

export type LinearItemDrawerProps = {
  issue: LinearIssue | null
  onUse: (issue: LinearIssue) => void
  onClose: () => void
  sourceContext?: TaskSourceContext | null
}

export type LinearEditState = {
  state: LinearIssue['state']
  priority: number
  estimate: number | null | undefined
  assignee: LinearIssue['assignee']
  labelIds: string[]
  labels: string[]
}

export type LinearIssueEditSectionProps = {
  issue: LinearIssue
  editState: LinearEditState
  layout?: 'chips' | 'properties'
  /** Owner-routed source for this issue's reads and writes. Decided by the rendering surface so
   *  an edit can never land on whichever server is focused. */
  providerSettings: RuntimeLinearSettings
  sourceContext?: TaskSourceContext | null
}

export type LinearLocalComment = { id: string; body: string; createdAt: string }

export function initLinearIssueEditState(issue: LinearIssue): LinearEditState {
  return {
    state: issue.state,
    priority: issue.priority,
    estimate: issue.estimate,
    assignee: issue.assignee,
    labelIds: issue.labelIds,
    labels: issue.labels
  }
}
