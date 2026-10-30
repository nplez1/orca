import type {
  JiraComment,
  JiraEditableField,
  JiraFieldErrors,
  JiraIssue,
  JiraIssueUpdate,
  JiraMutationResult,
  JiraPriority,
  JiraSprintAssignment,
  JiraTransition,
  JiraUser
} from '../../../shared/jira/jira-types'

export type JiraIssueWorkspaceDetailState = {
  displayed: JiraIssue | null
  issueLoading: boolean
  comments: JiraComment[]
  commentsLoading: boolean
  commentsError: string | null
  transitions: JiraTransition[]
  transitionsLoading: boolean
  transitionsError: string | null
  priorities: JiraPriority[]
  /** Why: a picker that failed to load must say so, not render as an empty list. */
  prioritiesError: string | null
  users: JiraUser[]
  usersError: string | null
  /** Custom fields Jira allows editing on this issue, with their current values. */
  editFields: JiraEditableField[]
  editFieldsLoading: boolean
  editFieldsError: string | null
  sprintAssignment: JiraSprintAssignment | null
  sprintAssignmentError: string | null
  /** Re-lists the issue's editable fields; the fields control's Retry. */
  reloadEditFields: () => Promise<void>
  pendingField: string | null
  titleDraft: string
  setTitleDraft: (value: string) => void
  labelsDraft: string
  setLabelsDraft: (value: string) => void
  commentDraft: string
  setCommentDraft: (value: string) => void
  commentSubmitting: boolean
  canSubmitComment: boolean
  handleSaveTitle: () => void
  handleSaveLabels: () => void
  handleSubmitComment: () => Promise<void>
  retryComments: () => void
  refreshing: boolean
  refresh: () => Promise<void>
  /** Re-runs the initial issue fetch; used before anything is displayed. */
  reload: () => void
  /** Re-lists the issue's available transitions; the transition control's Retry. */
  reloadTransitions: () => Promise<void>
  mutateIssue: (
    field: string,
    updates: JiraIssueUpdate,
    optimistic?: Partial<JiraIssue>,
    options?: { reportsInline?: boolean }
  ) => Promise<JiraMutationResult>
  /** Applies a custom-field edit and reports Jira's own rejection reasons back
   *  to the calling form instead of swallowing them into a toast. */
  submitIssueFields: (
    updates: JiraIssueUpdate
  ) => Promise<{ ok: true } | { ok: false; error: string; fieldErrors?: JiraFieldErrors }>
}
