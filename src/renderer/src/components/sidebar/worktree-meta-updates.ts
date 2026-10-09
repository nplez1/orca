import { parseGitHubIssueOrPRLink, parseGitHubIssueOrPRNumber } from '@/lib/github-links'
import {
  buildLinearIssueLinkUpdates,
  LINEAR_ISSUE_LINK_CLEARED
} from '../../../../shared/linear/links'
import { parseIssueLinkInput, type IssueLinkProvider } from '../../../../shared/issue-link-input'
import { getJiraSiteIdentityKey } from '../../../../shared/jira-issue-url'
import type { WorkspaceSourceProvider } from '../../../../shared/new-workspace/workspace-source'
import type { TaskSourceContext } from '../../../../shared/task-source-context'
import type { WorktreeMeta } from '../../../../shared/worktree/meta-types'
import type { WorkspaceLinkedItem } from '../../../../shared/worktree/types'
import { parseGitLabIssueOrMRLink } from '../../../../shared/new-workspace/gitlab-links'

export type WorktreeReviewProvider = 'github' | 'gitlab'

export type WorktreeMetaSavedPayload = {
  worktreeId: string
  updates: Partial<WorktreeMeta>
}

/** What the user currently has typed in the dialog. */
export type WorktreeMetaDraft = {
  displayNameInput: string
  issueInput: string
  issueProvider: IssueLinkProvider
  reviewInput: string
  commentInput: string
}

/** The persisted state the dialog was seeded from. Captured once when the
 *  dialog opens: comparing a frozen draft against a live store would let a
 *  background write move the baseline and make an untouched field "dirty". */
export type WorktreeMetaSnapshot = {
  displayName: string
  comment: string
  issueInput: string
  issueProvider: IssueLinkProvider
  prInput: string
  /** Stands in for an org key the typed value omits, so re-saving a stored bare
   *  identifier does not read as a change. */
  linkedLinearIssueOrganizationUrlKey?: string | null
}

/** The link state as it stands now, read at save time rather than at open.
 *  Displacement is decided against this: a CLI or background write that landed
 *  while the dialog was open must not survive a save the dialog warned would
 *  displace it, and a clear must not be emitted for a slot that is already empty
 *  — persistence gates the remote Linear capability on key presence, not value. */
export type WorktreeMetaLiveLinks = {
  linkedPR?: number | null
  linkedIssue?: number | null
  linkedLinearIssue?: string | null
  linkedLinearIssueOrganizationUrlKey?: string | null
  linkedWorkItemProvider?: WorkspaceSourceProvider | null
  /** `linkedWorkItem` also describes PRs and MRs, which this row does not own. */
  linkedWorkItemType?: WorkspaceLinkedItem['type'] | null
  /** The item's own URL, so a Jira link can tell "same issue" from "same key, another site". */
  linkedWorkItemUrl?: string | null
  linkedWorkItemJiraIdentifier?: string | null
}

/** A Jira issue resolved to the shape a workspace link is stored in. Jira has no
 *  dedicated slot, so the dialog cannot write one from the typed text alone: the
 *  stored item needs the issue's title and URL, and the read needs its site. */
export type ResolvedJiraIssueLink = {
  linkedWorkItem: WorkspaceLinkedItem
  linkedTaskSourceContext: TaskSourceContext
}

export function parseExplicitGitHubIssueUrl(input: string): string | null {
  const trimmed = input.trim()
  const link = parseGitHubIssueOrPRLink(trimmed)
  if (!link || link.type !== 'issue') {
    return null
  }

  return trimmed
}

export function parseGitHubWorkItemNumberForMetaField(
  input: string,
  expectedType: 'issue' | 'pr'
): number | null {
  const link = parseGitHubIssueOrPRLink(input)
  if (link) {
    // Why: issue and PR numbers live in separate GitHub namespaces for refs;
    // a URL path mismatch must not silently link the other field.
    return link.type === expectedType ? link.number : null
  }

  return parseGitHubIssueOrPRNumber(input)
}

export function parseGitLabMergeRequestNumberForMetaField(input: string): number | null {
  const trimmed = input.trim()
  const direct = trimmed.startsWith('!') ? trimmed.slice(1) : trimmed
  if (/^\d+$/.test(direct)) {
    const number = Number(direct)
    return Number.isSafeInteger(number) && number > 0 ? number : null
  }
  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return null
  }
  const link = parseGitLabIssueOrMRLink(trimmed)
  return link?.type === 'mr' && Number.isSafeInteger(link.number) && link.number > 0
    ? link.number
    : null
}

// Why: blanking the field means "fall back to the branch/folder name", and the
// empty string is how that intent is persisted. Emitting `undefined` instead
// put a present-but-undefined key into the store spread, wiping the live name
// and crashing the worktree palette (crash a1f81ea1).
function buildDisplayNameUpdate(
  draft: WorktreeMetaDraft,
  current: WorktreeMetaSnapshot
): Partial<WorktreeMeta> {
  const trimmed = draft.displayNameInput.trim()
  return trimmed === current.displayName ? {} : { displayName: trimmed }
}

// Why: persistence bumps lastActivityAt whenever a `comment` key is present, so
// re-emitting an unchanged note reorders the workspace under the time-decay
// sidebar sort on a save that only touched the issue link.
function buildCommentUpdate(
  draft: WorktreeMetaDraft,
  current: WorktreeMetaSnapshot
): Partial<WorktreeMeta> {
  const trimmed = draft.commentInput.trim()
  return trimmed === current.comment ? {} : { comment: trimmed }
}

/** Which issue a value names, ignoring spelling: `42` and `#42` are one GitHub
 *  link, `sta-335`, `STA-335` and its linear.app URL are one Linear link. A
 *  Linear URL still refines a
 *  stored org key, so the key belongs to the identity — with the stored one
 *  standing in when the input omits it. Unparseable text compares as raw text:
 *  there is nothing to normalize, and the builder writes nothing for it anyway. */
function issueLinkIdentity(
  input: string,
  provider: IssueLinkProvider,
  storedLinearOrganizationUrlKey: string | null
): string {
  const trimmed = input.trim()
  if (trimmed === '') {
    return ''
  }
  const parsed = parseIssueLinkInput(trimmed, provider)
  if (!parsed) {
    return `raw:${provider}:${trimmed}`
  }
  if (parsed.provider === 'github') {
    return `github:${parsed.number}`
  }
  if (parsed.provider === 'jira') {
    // Why: two sites can hold the same key, so a typed URL names the site it
    // means. A bare key names none and matches either spelling of the same issue.
    const site = getJiraSiteIdentityKey(parsed.siteUrl)
    return site ? `jira:${parsed.key.toUpperCase()}@${site}` : `jira:${parsed.key.toUpperCase()}`
  }
  const organizationUrlKey = parsed.organizationUrlKey ?? storedLinearOrganizationUrlKey ?? ''
  return `linear:${parsed.identifier}:${organizationUrlKey.trim().toLowerCase()}`
}

// Why: normalized identity rather than trimmed text. Retyping the same issue in
// another spelling — `42` to `#42`, `STA-335` to its URL — would otherwise enter
// the displacement path and clear the title and source context of the very link
// it re-states. A provider switch is only visible through the identity when
// there is a value to reinterpret, which is the intent an empty field lacks.
export function isIssueFieldDirty(
  draft: WorktreeMetaDraft,
  current: WorktreeMetaSnapshot
): boolean {
  const storedOrganizationUrlKey = current.linkedLinearIssueOrganizationUrlKey ?? null
  return (
    issueLinkIdentity(draft.issueInput, draft.issueProvider, storedOrganizationUrlKey) !==
    issueLinkIdentity(current.issueInput, current.issueProvider, storedOrganizationUrlKey)
  )
}

/** Whether the value being saved names the very issue `linkedWorkItem` already
 *  describes. Org keys only disagree when both are known: a stored link without
 *  one is not evidence of a different organization, so a URL that supplies it
 *  refines the link rather than replacing it. */
export function keepsLinkedWorkItem(
  input: string,
  provider: IssueLinkProvider,
  live: WorktreeMetaLiveLinks
): boolean {
  const parsed = parseIssueLinkInput(input.trim(), provider)
  if (!parsed || live.linkedWorkItemType !== 'issue') {
    return false
  }
  if (parsed.provider === 'github') {
    return live.linkedWorkItemProvider === 'github' && parsed.number === live.linkedIssue
  }
  if (parsed.provider === 'jira') {
    if (
      live.linkedWorkItemProvider !== 'jira' ||
      parsed.key.toUpperCase() !== (live.linkedWorkItemJiraIdentifier ?? '').trim().toUpperCase()
    ) {
      return false
    }
    const typedSite = getJiraSiteIdentityKey(parsed.siteUrl)
    const liveSite = getJiraSiteIdentityKey(live.linkedWorkItemUrl)
    // Why: org keys only disagree when both are known — the same rule as Linear.
    // A bare key re-states the stored link; a URL naming another site does not.
    return !typedSite || !liveSite || typedSite === liveSite
  }
  if (
    live.linkedWorkItemProvider !== 'linear' ||
    parsed.identifier.toUpperCase() !== live.linkedLinearIssue?.trim().toUpperCase()
  ) {
    return false
  }
  const storedOrganizationUrlKey = live.linkedLinearIssueOrganizationUrlKey?.trim()
  const nextOrganizationUrlKey = parsed.organizationUrlKey?.trim()
  return (
    !storedOrganizationUrlKey ||
    !nextOrganizationUrlKey ||
    storedOrganizationUrlKey.toLowerCase() === nextOrganizationUrlKey.toLowerCase()
  )
}

/** Owns both provider slot families. One issue per workspace: writing one
 *  provider clears the other. Emits nothing at all unless the field changed —
 *  the dialog opens focused on Comment, so an untouched field must never
 *  destroy a link the user came here to keep.
 *
 *  `jiraLink` is the resolved Jira issue for a dirty Jira field; it is null for
 *  every other provider, and null when the save path could not resolve one. */
/** Whether the Issue field may replace the work item the workspace holds.
 *
 *  It owns an absent item and its own Jira issue; the GitHub and Linear issue it
 *  also displaces carry their own provider slots and a warning. A PR/MR-typed item
 *  and a GitLab issue belong to surfaces this row has no editor for, so replacing
 *  one would drop a title, URL and read-routing context nothing here can restore. */
export function canReplaceLinkedWorkItem(live: WorktreeMetaLiveLinks): boolean {
  const provider = live.linkedWorkItemProvider
  if (provider === null || provider === undefined) {
    return true
  }
  return live.linkedWorkItemType === 'issue' && provider !== 'gitlab'
}

/** Whether the draft re-states the Jira issue the workspace already holds, in
 *  which case saving rewrites nothing and needs no Jira read. */
export function keepsLiveJiraWorkItem(
  draft: WorktreeMetaDraft,
  live: WorktreeMetaLiveLinks
): boolean {
  return keepsLinkedWorkItem(draft.issueInput, draft.issueProvider, live)
}

/** The writes that clear the issue this workspace is linked to.
 *
 *  A workspace holds one issue at a time and stores it in whichever slot its
 *  provider owns, so a clear has to empty all of them rather than the one the
 *  caller happens to be looking at: the GitHub number, the Linear key, and the
 *  created-from work item with its read-routing context. A PR/MR work item is
 *  left alone — it belongs to the review surfaces, not to this link.
 *
 *  Shared by the meta dialog's empty Issue field and the issue pane's Unlink
 *  action so the two cannot drift. */
export function buildIssueUnlinkUpdates(live: WorktreeMetaLiveLinks): Partial<WorktreeMeta> {
  const clearsCreatedFromIssue =
    live.linkedWorkItemType === 'issue' &&
    (live.linkedWorkItemProvider === 'github' ||
      live.linkedWorkItemProvider === 'linear' ||
      live.linkedWorkItemProvider === 'jira')
  return {
    linkedIssue: null,
    ...(live.linkedLinearIssue ? LINEAR_ISSUE_LINK_CLEARED : {}),
    ...(clearsCreatedFromIssue ? { linkedWorkItem: null, linkedTaskSourceContext: null } : {})
  }
}

function buildIssueLinkUpdates(
  draft: WorktreeMetaDraft,
  current: WorktreeMetaSnapshot,
  live: WorktreeMetaLiveLinks,
  jiraLink: ResolvedJiraIssueLink | null
): Partial<WorktreeMeta> {
  if (!isIssueFieldDirty(draft, current)) {
    return {}
  }

  const trimmed = draft.issueInput.trim()
  // Why: the linked work item and its source context describe the issue being
  // replaced. Leaving them would keep a stale title badge and mis-scope Linear
  // reads — but only when the save names a *different* issue: a value that
  // re-states the same one, such as a URL adding an org key, must keep its own
  // title and SSH/runtime routing context. Narrow on purpose: `type` because the
  // field also records the PR or MR a workspace was created from, and provider
  // because GitLab issues have no slot in this row — displacing what it cannot
  // display would destroy a link the user was never shown and has no other
  // editor to restore it from.
  const displacedWorkItem: Partial<WorktreeMeta> =
    !keepsLinkedWorkItem(trimmed, draft.issueProvider, live) &&
    (live.linkedWorkItemProvider === 'github' ||
      live.linkedWorkItemProvider === 'linear' ||
      live.linkedWorkItemProvider === 'jira') &&
    live.linkedWorkItemType === 'issue'
      ? { linkedWorkItem: null, linkedTaskSourceContext: null }
      : {}

  // Why: persistence gates the remote Linear capability on key presence, not
  // value. A synthetic clear on a workspace that never held a Linear link would
  // fail a GitHub-only save against an older runtime, citing Linear. Read live,
  // not from the snapshot: a link added since the dialog opened would otherwise
  // outlive a save that just promised to displace it.
  const displacedLinear: Partial<WorktreeMeta> = live.linkedLinearIssue
    ? LINEAR_ISSUE_LINK_CLEARED
    : {}

  if (trimmed === '') {
    return buildIssueUnlinkUpdates(live)
  }

  const parsed = parseIssueLinkInput(trimmed, draft.issueProvider)
  if (!parsed) {
    // Why: unparseable input leaves every link untouched. `canSave` already
    // blocks this path, but the builder stays pure rather than relying on it.
    return {}
  }

  if (parsed.provider === 'github') {
    return {
      linkedIssue: parsed.number,
      ...displacedLinear,
      ...displacedWorkItem
    }
  }

  if (parsed.provider === 'jira') {
    if (keepsLinkedWorkItem(trimmed, draft.issueProvider, live)) {
      return { linkedIssue: null, ...displacedLinear }
    }
    // Why: a Jira link is the stored item plus its source context, so there is
    // nothing to write without one, and nothing the field may replace either —
    // `canReplaceLinkedWorkItem` is what stops a Jira save from silently throwing
    // away a work item another surface owns.
    if (!jiraLink || !canReplaceLinkedWorkItem(live)) {
      return {}
    }
    return {
      linkedIssue: null,
      ...displacedLinear,
      linkedWorkItem: jiraLink.linkedWorkItem,
      linkedTaskSourceContext: jiraLink.linkedTaskSourceContext
    }
  }

  const linearUpdates = buildLinearIssueLinkUpdates(trimmed)
  return linearUpdates ? { linkedIssue: null, ...linearUpdates, ...displacedWorkItem } : {}
}

function buildReviewLinkUpdate(
  draft: WorktreeMetaDraft,
  current: WorktreeMetaSnapshot,
  live: WorktreeMetaLiveLinks,
  provider: WorktreeReviewProvider
): Partial<WorktreeMeta> {
  const trimmed = draft.reviewInput.trim()
  if (provider === 'github' && trimmed === current.prInput.trim()) {
    return {}
  }
  if (trimmed === '') {
    return provider === 'gitlab'
      ? { linkedGitLabMR: null }
      : {
          linkedPR: null,
          ...(typeof live.linkedPR === 'number' ? { suppressedGitHubPR: live.linkedPR } : {})
        }
  }
  const number =
    provider === 'gitlab'
      ? parseGitLabMergeRequestNumberForMetaField(trimmed)
      : parseGitHubWorkItemNumberForMetaField(trimmed, 'pr')
  if (number === null) {
    return {}
  }
  return provider === 'gitlab' ? { linkedGitLabMR: number } : { linkedPR: number }
}

/** Pure save-payload builder for the worktree meta dialog: empty inputs clear
 *  the link (null), unparseable inputs leave it untouched (omitted). No key is
 *  ever emitted holding `undefined` — persistence raw-spreads updates, so a
 *  present-but-undefined key erases the stored value. */
export function buildWorktreeMetaUpdates(
  draft: WorktreeMetaDraft,
  current: WorktreeMetaSnapshot,
  live: WorktreeMetaLiveLinks,
  reviewProvider: WorktreeReviewProvider = 'github',
  jiraLink: ResolvedJiraIssueLink | null = null
): Partial<WorktreeMeta> {
  return {
    ...buildCommentUpdate(draft, current),
    ...buildDisplayNameUpdate(draft, current),
    ...buildIssueLinkUpdates(draft, current, live, jiraLink),
    ...buildReviewLinkUpdate(draft, current, live, reviewProvider)
  }
}
