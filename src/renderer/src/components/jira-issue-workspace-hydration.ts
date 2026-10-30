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
 *  and a status/priority/assignee by the id it points at — `id` for a status or
 *  priority, `accountId` for a Jira user. */
function referenceKey(value: unknown): unknown {
  if (typeof value !== 'object' || value === null) {
    return undefined
  }
  if ('id' in value) {
    return value.id
  }
  return 'accountId' in value ? value.accountId : undefined
}

function sameFieldValue(left: unknown, right: unknown): boolean {
  if (left === right) {
    return true
  }
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((value, index) => value === right[index])
  }
  const leftKey = referenceKey(left)
  return leftKey !== undefined && leftKey === referenceKey(right)
}

/** Whether a re-read carries the optimistic patch, for a write whose answer was lost.
 *  An optimistic patch that names no editable field (a sprint move) proves nothing, so
 *  it counts as not landed rather than as a silent success. */
export function jiraIssueFieldsLanded(issue: JiraIssue, patch: Partial<JiraIssue>): boolean {
  const fields = editedJiraIssueFields(patch)
  return fields.length > 0 && fields.every((field) => sameFieldValue(issue[field], patch[field]))
}
