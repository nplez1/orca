import type { SecretAtRestProtection } from '../secret-at-rest-protection'
import type { TaskProviderErrorCode } from '../task-provider-failure'
// Cloud uses email/token Basic auth and REST v3; Server/Data Center uses PAT Bearer auth and REST v2. Legacy absent values mean cloud.
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
  // REST gateway for scoped Cloud tokens; siteUrl remains the browse-link origin.
  apiBaseUrl?: string
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
  // Saved token decryption failures explain unreadable credentials while the connection remains configured.
  credentialError?: string
  // Plaintext means some tokens are unsealed; older hosts omit protection, which means unknown rather than sealed.
  credentialProtection?: SecretAtRestProtection | null
  // Absent on older remote hosts, which require a Cloud email and unscoped token.
  supportsScopedTokens?: boolean
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
  /** What the issue already holds, as the paired control's draft. Jira marks a
   *  field required by the transition screen rather than by the issue's own
   *  emptiness, so a field this fills is not input the user owes us. Absent when
   *  the host could not read the values, which keeps the field asked for. */
  currentValue?: string
  /** True when the issue holds any value at all, whatever its shape. Separate from
   *  `currentValue` because that one only exists when a control can seed from it: a
   *  value Orca has no control for still means the user owes nothing. */
  hasCurrentValue?: boolean
  /** Human label for a `currentValue` that carries an id, so a form can show it. */
  currentDisplayValue?: string
  /** The people a multi-user field already holds, so a picker names them rather than
   *  showing accountIds. Absent for every other field kind. */
  currentUsers?: JiraUser[]
  schema?: {
    type?: string
    items?: string
    custom?: string
    system?: string
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
  columns?: { name: string; statusIds: string[] }[]
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
  /** The sprint's own board (Jira's `originBoardId`); `undefined` on a response that omits it. */
  boardId?: string
}

/** Which sprint an issue sits in, and the sprints it can be moved into.
 *  `sprint: null` means the item is in the board's backlog. */
export type JiraSprintAssignment = {
  sprint: JiraSprint | null
  sprints: JiraSprint[]
}

export type JiraBoardOverview = {
  board: JiraBoard
  columns: JiraBoardColumn[]
  activeSprints: JiraSprint[]
  /** Sprints an issue can be moved into (active + future). Optional because a
   *  host that predates sprint assignment omits it; absence must hide the control
   *  rather than offer an empty picker. */
  sprints?: JiraSprint[]
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
  /** Fields the transition's own screen requires, present only when the host
   *  asked Jira for `expand=transitions.fields`; an older host omits them, and the
   *  client then submits the transition without fields exactly as it used to. */
  fields?: JiraCreateField[]
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
  /** Users holding one of the issue's user-picker custom fields — the site's Dev/QE
   *  roles. Absent when those fields were never read; `[]` when nobody holds one. */
  roleAssignees?: JiraUser[]
  priority?: JiraPriority
  /** Parent issue (epic for stories, parent story for subtasks). */
  parent?: { key: string; title: string; issueTypeName?: string }
  sprint?: string
  storyPoints?: number
  /** The custom-field id `storyPoints` was read from. A site can expose more than
   *  one story-points field, so a writer has to know which one produced the value
   *  on screen; a host that predates this omits it. */
  storyPointsFieldId?: string
  originalEstimateSeconds?: number
  remainingEstimateSeconds?: number
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
  labelOperations?: { add?: string[]; remove?: string[] }
  title?: string
  labels?: string[]
  assigneeAccountId?: string | null
  priorityId?: string | null
  transitionId?: string
  /** Fields the transition's screen requires, submitted beside the transition.
   *  Separate from `customFields` because Jira applies them in the transition
   *  call, not the field-edit PUT. */
  transitionFields?: Record<string, unknown>
  /** Comment posted with the transition. */
  transitionComment?: string
  transitionUserFieldKeys?: string[]
  /** Keys in transitionFields holding plain text the host converts for the site. */
  transitionTextFieldKeys?: string[]
  /** Fields applied through the field-edit PUT, custom fields included. A null
   *  value clears the field. */
  customFields?: Record<string, unknown>
  userFieldKeys?: string[]
  /** Keys in customFields holding plain text the host converts for the site. */
  textFieldKeys?: string[]
  /** Target sprint, or null to move the issue back to the board's backlog. */
  sprintId?: string | null
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
  /** The display names behind a user-field draft, so a picker shows names rather than
   *  ids before any search runs. Absent for non-user fields. */
  displayName?: string
  /** The users a multi-user field already holds, in draft order, so the picker can name
   *  each of them without a search. Absent for every other field. */
  users?: JiraUser[]
}

export type JiraIssueFilter = 'assigned' | 'reported' | 'all' | 'done'
export type JiraIssueListFilters = { statuses?: string[]; currentSprint?: boolean }

export type JiraConnectArgs = {
  siteUrl: string
  // Empty for Bearer authentication: self-hosted PAT or scoped Cloud token.
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
  // Host wraps these custom-field user IDs as Jira accountId/name objects; older clients omit them.
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
      // Why: the deadline fired, so the host may still commit. A caller must re-read
      // the issue instead of rolling its optimistic patch back as a failure.
      timedOut?: boolean
      // Why: the provider code lets a surface choose its own copy for the same failure;
      // `taskProviderErrorMessage` reads it, and a Jira rejection without one renders raw.
      errorCode?: TaskProviderErrorCode
    }
