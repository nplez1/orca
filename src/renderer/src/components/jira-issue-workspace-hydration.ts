import type { JiraIssue } from '../../../shared/jira/jira-types'

const EDITABLE_JIRA_ISSUE_FIELDS = [
  'title',
  'labels',
  'status',
  'priority',
  'assignee',
  'storyPoints'
] as const
export type EditableJiraIssueField = (typeof EDITABLE_JIRA_ISSUE_FIELDS)[number]

/** Editable fields an optimistic patch touches, including ones it clears to undefined. */
export function editedJiraIssueFields(patch: Partial<JiraIssue>): EditableJiraIssueField[] {
  return EDITABLE_JIRA_ISSUE_FIELDS.filter((field) => field in patch)
}

// Preserve edits when an earlier detail request returns stale fields.
export function mergeJiraIssueHydration(
  fetched: JiraIssue,
  current: JiraIssue | null,
  edited: ReadonlySet<EditableJiraIssueField>
): JiraIssue {
  if (edited.size === 0 || !current) {
    return fetched
  }
  return {
    ...fetched,
    title: edited.has('title') ? current.title : fetched.title,
    labels: edited.has('labels') ? current.labels : fetched.labels,
    status: edited.has('status') ? current.status : fetched.status,
    priority: edited.has('priority') ? current.priority : fetched.priority,
    assignee: edited.has('assignee') ? current.assignee : fetched.assignee,
    storyPoints: edited.has('storyPoints') ? current.storyPoints : fetched.storyPoints
  }
}

export function jiraIssueRollbackPatch(
  previous: JiraIssue,
  patch: Partial<JiraIssue>
): Partial<JiraIssue> {
  const rollback: Partial<JiraIssue> = {}
  for (const field of editedJiraIssueFields(patch)) {
    Object.assign(rollback, { [field]: previous[field] })
  }
  return rollback
}

/** Deep equality for an editable field: scalars by value, a label list element-wise,
 *  and a status/priority/assignee by the id it points at. */
function referenceId(value: unknown): unknown {
  return typeof value === 'object' && value !== null && 'id' in value ? value.id : undefined
}

function sameFieldValue(left: unknown, right: unknown): boolean {
  if (left === right) {
    return true
  }
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((value, index) => value === right[index])
  }
  const leftId = referenceId(left)
  return leftId !== undefined && leftId === referenceId(right)
}

/** Whether a re-read carries the optimistic patch, for a write whose answer was lost. */
export function jiraIssueFieldsLanded(issue: JiraIssue, patch: Partial<JiraIssue>): boolean {
  return editedJiraIssueFields(patch).every((field) => sameFieldValue(issue[field], patch[field]))
}
