import type { SecretAtRestProtection } from './secret-at-rest-protection'
// 'cloud' = Atlassian Cloud (email + API token, Basic auth, REST v3).
// 'server' = self-hosted Jira Server/Data Center (personal access token,
// Bearer auth, REST v2). Older stored sites omit the field and mean 'cloud'.
export type JiraAuthType = 'cloud' | 'server'

/** How an incoming comment body is written. `plain` is text to store verbatim;
 *  `markdown` is what Orca's own composer produces and what the host converts
 *  into the site's own body format. Older clients omit it and mean plain. */
export type JiraCommentBodyFormat = 'plain' | 'markdown'

export type JiraSite = {
  id: string
  siteUrl: string
  email: string
  displayName: string
  accountId: string
  authType?: JiraAuthType
}

export type JiraViewer = {
  accountId: string
  displayName: string
  email: string | null
  avatarUrl?: string
}

export type JiraSiteSelection = (string & {}) | 'all'

export type JiraConnectionStatus = {
  connected: boolean
  viewer: JiraViewer | null
  sites?: JiraSite[]
  activeSiteId?: string | null
  selectedSiteId?: JiraSiteSelection | null
  // Set when a stored token file exists but could not be decrypted, so the
  // UI can explain reads failing while the connection still looks saved.
  credentialError?: string
  // 'plaintext' when any stored token is unsealed, so Settings can warn. Optional:
  // an older remote host omits it, and absent must read as "unknown", not "sealed".
  credentialProtection?: SecretAtRestProtection | null
}

export type JiraProject = {
  id: string
  key: string
  name: string
  siteId?: string
  siteName?: string
}

export type JiraIssueType = {
  id: string
  name: string
  description?: string
  iconUrl?: string
  subtask?: boolean
}

export type JiraCreateFieldAllowedValue = {
  id?: string
  value?: string
  name?: string
}

export type JiraCreateField = {
  key: string
  name: string
  required: boolean
  /** True when Jira will supply the value itself, so a required transition
   *  field marked this way needs no prompt. */
  hasDefaultValue?: boolean
  schema?: {
    type?: string
    items?: string
    custom?: string
  }
  allowedValues?: JiraCreateFieldAllowedValue[]
}

export type JiraUser = {
  accountId: string
  displayName: string
  email?: string | null
  avatarUrl?: string
}

export type JiraPriority = {
  id: string
  name: string
  iconUrl?: string
}

export type JiraStatus = {
  id: string
  name: string
  categoryKey: string
  categoryName: string
  colorName?: string
}

export type JiraProjectStatusOrder = {
  statusIdsByColumn: string[][]
}

export type JiraBoard = {
  id: string
  name: string
  type: string
  siteId: string
  siteName: string
}

export type JiraBoardSelection = {
  boardId: string
  siteId: string
  // Why: a large Jira site returns only the first page of boards, so the settings
  // picker keeps the chosen board's name to render the setting it is showing.
  name?: string
}

export type JiraBoardColumn = {
  name: string
  statusIds: string[]
}

export type JiraSprint = {
  id: string
  name: string
  state: string
  startDate?: string
  endDate?: string
}

export type JiraBoardOverview = {
  board: JiraBoard
  columns: JiraBoardColumn[]
  activeSprints: JiraSprint[]
}

export type JiraBoardIssuePage = {
  issues: JiraIssue[]
  startAt: number
  nextPageToken: string | null
  total: number | null
  isLast: boolean
}

export type JiraBoardIssuePageRequest = {
  boardId: string
  siteId: string
  startAt?: number
  maxResults?: number
} & (
  | { scope: 'backlog'; pageToken?: string; sprintId?: never }
  | { scope: 'sprint'; pageToken?: string; sprintId: string }
)

export type JiraTransition = {
  id: string
  name: string
  to: JiraStatus
  /** Fields the transition's own screen requires. Present only when the host
   *  asked Jira for `expand=transitions.fields`; an older host omits it, and the
   *  client then submits the transition without fields exactly as it used to. */
  requiredFields?: JiraCreateField[]
}

export type JiraIssue = {
  id: string
  key: string
  siteId?: string
  siteName?: string
  title: string
  description?: string
  url: string
  project: JiraProject
  issueType: JiraIssueType
  status: JiraStatus
  labels: string[]
  assignee?: JiraUser
  reporter?: JiraUser
  priority?: JiraPriority
  updatedAt: string
  createdAt: string
}

export type JiraComment = {
  id: string
  body: string
  createdAt: string
  updatedAt?: string
  user?: JiraUser
}

export type JiraIssueUpdate = {
  title?: string
  labels?: string[]
  assigneeAccountId?: string | null
  priorityId?: string | null
  transitionId?: string
  /** Fields the transition's screen requires, submitted beside the transition.
   *  Separate from `customFields` because Jira applies them in the transition
   *  call, not the field-edit PUT. */
  transitionFields?: Record<string, unknown>
  transitionUserFieldKeys?: string[]
  /** Keys in transitionFields holding plain text the host converts for the site. */
  transitionTextFieldKeys?: string[]
  /** Fields applied through the field-edit PUT, custom fields included. A null
   *  value clears the field. */
  customFields?: Record<string, unknown>
  userFieldKeys?: string[]
  /** Keys in customFields holding plain text the host converts for the site. */
  textFieldKeys?: string[]
}

/** Jira's per-field rejection reasons, keyed by the field's Jira key. */
export type JiraFieldErrors = Record<string, string>

/** One editable field on an existing issue, as `/issue/{key}/editmeta` reports
 *  it, paired with the value the issue currently holds. */
export type JiraEditableField = {
  /** Edit-side metadata, in the same shape the create dialog consumes. */
  field: JiraCreateField
  /** The current value as a control draft, '' when the field is unset. For a user
   *  field this is the accountId (Cloud) or username (Server/DC) the ref needs. */
  value: string
  /** The current user's display name, so a picker shows a name rather than an id
   *  before any search runs. Absent for non-user fields. */
  displayName?: string
}

export type JiraIssueFilter = 'assigned' | 'reported' | 'all' | 'done'

export type JiraConnectArgs = {
  siteUrl: string
  // Ignored for 'server' auth: self-hosted PATs authenticate via Bearer
  // header alone, so the email field may be empty.
  email: string
  apiToken: string
  authType?: JiraAuthType
}

export type JiraCreateIssueArgs = {
  siteId?: string
  projectId: string
  issueTypeId: string
  title: string
  description?: string
  customFields?: Record<string, unknown>
  // Keys in customFields holding user ids; the host shapes them into the
  // {accountId} / {name} object Jira requires. Omitted by older clients.
  userFieldKeys?: string[]
  // Keys in customFields holding plain text; the host converts them to the
  // site's own body format. Omitted by older clients.
  textFieldKeys?: string[]
}

export type JiraCreateIssueResult =
  | { ok: true; id: string; key: string; url: string }
  | { ok: false; error: string }

export type JiraMutationResult =
  | { ok: true }
  | {
      ok: false
      error: string
      // Jira's own field-level rejections, so the UI can name the offending field
      // instead of showing one flattened string. Absent on transport failures.
      fieldErrors?: JiraFieldErrors
      errorMessages?: string[]
    }
