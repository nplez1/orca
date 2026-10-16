import type { JiraIssue, JiraSite } from '../../../shared/jira-types'
import {
  getJiraSiteIdentityKey,
  getMatchingJiraSites,
  parseJiraIssueUrl,
  JIRA_ISSUE_KEY_PATTERN
} from '../../../shared/jira-issue-url'
import { getWorkspaceAttachments } from '../../../shared/workspace-attachments'
import type { WorkspaceAttachment, Worktree } from '../../../shared/worktree/types'
import type { TaskSourceContext } from '../../../shared/task-source-context'

export type JiraIssueWorkspaceAttachmentIndex = ReadonlyMap<string, readonly Worktree[]>
export type LinkedJiraIssueRef = { key: string; siteId: string; sourceContext?: TaskSourceContext }
export type JiraIssueAttachmentRef = Pick<JiraIssue, 'key'> & Partial<Pick<JiraIssue, 'url'>>

export function normalizeJiraIssueKey(value: string | null | undefined): string | null {
  const trimmed = value?.trim()
  return trimmed ? trimmed.toUpperCase() : null
}

function jiraKey(item: WorkspaceAttachment): string | null {
  if (item.provider !== 'jira') {
    return null
  }
  const value = (item.identifier ?? item.jiraIdentifier ?? '').trim()
  return JIRA_ISSUE_KEY_PATTERN.test(value)
    ? value.toUpperCase()
    : (parseJiraIssueUrl(value)?.issueKey ?? null)
}

// Why host only: the login is matched by siteId below and the label is display-only; legacy links are local.
function sameSource(item: WorkspaceAttachment, source?: TaskSourceContext | null): boolean {
  return !source || (item.taskSourceContext?.hostId ?? 'local') === source.hostId
}

function itemSite(item: WorkspaceAttachment) {
  const identity = item.taskSourceContext?.providerIdentity
  const jiraIdentity = identity?.provider === 'jira' ? identity : null
  const parsed =
    parseJiraIssueUrl(item.url ?? '') ??
    (jiraIdentity?.siteUrl
      ? parseJiraIssueUrl(`${jiraIdentity.siteUrl.replace(/\/+$/, '')}/browse/${jiraKey(item)}`)
      : null)
  return { identity: jiraIdentity, parsed }
}

export function jiraAttachmentMatchesIssue(
  item: WorkspaceAttachment,
  issue: JiraIssue,
  source?: TaskSourceContext | null
): boolean {
  if (jiraKey(item) !== issue.key.toUpperCase() || !sameSource(item, source)) {
    return false
  }
  const { identity, parsed } = itemSite(item)
  const issueSite = parseJiraIssueUrl(issue.url)
  if (
    identity?.projectKey &&
    identity.projectKey.toUpperCase() !== issue.project.key.toUpperCase()
  ) {
    return false
  }
  if (identity?.siteId && issue.siteId && identity.siteId !== issue.siteId) {
    return false
  }
  if (parsed && issueSite) {
    return parsed.origin === issueSite.origin && parsed.sitePath === issueSite.sitePath
  }
  return Boolean(identity?.siteId && identity.siteId === issue.siteId)
}

/** Why: a workspace being deleted is about to stop existing, so neither the chip
 *  nor the flipped action should point at it. */
function isCandidate(worktree: Worktree): boolean {
  return !worktree.isArchived && !worktree.removing
}

export function buildJiraIssueWorkspaceAttachmentIndex(
  workspaces: readonly Worktree[]
): JiraIssueWorkspaceAttachmentIndex {
  const index = new Map<string, Worktree[]>()
  for (const workspace of workspaces) {
    if (!isCandidate(workspace)) {
      continue
    }
    const keys = new Set(getWorkspaceAttachments(workspace).map(jiraKey))
    for (const key of keys) {
      if (!key) {
        continue
      }
      const bucket = index.get(key)
      if (bucket) {
        bucket.push(workspace)
      } else {
        index.set(key, [workspace])
      }
    }
  }
  return index
}

/** The strict identity match over a live list: host, account, project and site
 *  scoped, most-recent ordering. Shared by the index lookup and the
 *  strict-then-fallback resolver so the two cannot drift. */
function findStrictJiraIssueWorkspaceAttachments(
  workspaces: readonly Worktree[],
  issue: JiraIssue,
  source?: TaskSourceContext | null
): Worktree[] {
  return workspaces
    .filter((workspace) =>
      getWorkspaceAttachments(workspace).some((item) =>
        jiraAttachmentMatchesIssue(item, issue, source)
      )
    )
    .toSorted((a, b) => b.lastActivityAt - a.lastActivityAt)
}

export function findJiraIssueWorkspaceAttachmentsInIndex(
  index: JiraIssueWorkspaceAttachmentIndex,
  issue: JiraIssue,
  source?: TaskSourceContext | null
): readonly Worktree[] {
  return findStrictJiraIssueWorkspaceAttachments(
    index.get(issue.key.toUpperCase()) ?? [],
    issue,
    source
  )
}

export function collectLinkedJiraIssueRefs(
  workspaces: readonly Worktree[],
  sites: readonly JiraSite[],
  selectedSiteId: string | null | undefined,
  source?: TaskSourceContext | null
): LinkedJiraIssueRef[] {
  const refs = new Map<string, LinkedJiraIssueRef>()
  for (const workspace of workspaces) {
    if (!isCandidate(workspace)) {
      continue
    }
    for (const item of getWorkspaceAttachments(workspace)) {
      const key = jiraKey(item)
      if (!key || !sameSource(item, source)) {
        continue
      }
      const { identity, parsed } = itemSite(item)
      const matches = parsed
        ? getMatchingJiraSites(parsed, sites)
        : sites.filter((site) => site.id === identity?.siteId)
      const candidates = matches.filter(
        (candidate) =>
          (!identity?.siteId || identity.siteId === candidate.id) &&
          (!selectedSiteId || selectedSiteId === 'all' || selectedSiteId === candidate.id)
      )
      const site = candidates.length === 1 ? candidates[0] : null
      if (
        !site ||
        (identity?.projectKey && !key.startsWith(`${identity.projectKey.toUpperCase()}-`))
      ) {
        continue
      }
      refs.set(`${site.id}:${key}`, {
        key,
        siteId: site.id,
        ...(item.taskSourceContext ? { sourceContext: item.taskSourceContext } : {})
      })
    }
  }
  return [...refs.values()].toSorted((a, b) =>
    `${a.siteId}:${a.key}`.localeCompare(`${b.siteId}:${b.key}`)
  )
}

/** How strongly an attachment's stored site agrees with the issue's: 1 when both name
 *  a site and it matches, -1 when both name one and they differ, 0 when either side is
 *  silent. The signal is the link's site identity rather than the site id: that id is
 *  `sha256(siteUrl + account email)` (src/main/jira/site-identity.ts), and a stored
 *  identity only survives normalization while the link's own URL names that site
 *  (src/shared/workspace-attachment-normalization.ts), so the id can never disagree
 *  with the link about which site this is. */
function jiraSiteScore(issueSiteKey: string | null, item: WorkspaceAttachment): number {
  const itemSiteKey = getJiraSiteIdentityKey(item.url)
  if (!issueSiteKey || !itemSiteKey) {
    return 0
  }
  return issueSiteKey === itemSiteKey ? 1 : -1
}

function findBestAttachment(
  candidates: readonly Worktree[],
  issue: JiraIssueAttachmentRef
): Worktree | null {
  const key = normalizeJiraIssueKey(issue.key)
  if (!key) {
    return null
  }
  const issueSiteKey = getJiraSiteIdentityKey(issue.url)
  let best: Worktree | null = null
  let bestScore = -1
  for (const worktree of candidates) {
    let score = -1
    for (const item of getWorkspaceAttachments(worktree)) {
      if (jiraKey(item) === key) {
        score = Math.max(score, jiraSiteScore(issueSiteKey, item))
      }
    }
    // Why: several workspaces can carry one key; the most specific site wins, then
    // the most recently active, then list order — never "the first one found".
    if (
      score > bestScore ||
      (score === bestScore && best && worktree.lastActivityAt > best.lastActivityAt)
    ) {
      best = worktree
      bestScore = score
    }
  }
  return best
}

export function findJiraIssueWorkspaceAttachment(
  worktrees: readonly Worktree[],
  issue: JiraIssueAttachmentRef
): Worktree | null {
  return findBestAttachment(worktrees.filter(isCandidate), issue)
}

/** One resolution rule for "which workspace is this issue linked to": the strict
 *  identity match first (host, account, project and site scoped), then the fork's
 *  permissive URL-identity finder as a fallback so a legacy link that records no
 *  site still resolves. The sheet's label, list rows, board chip, and the
 *  open/start action all route through here, so they cannot disagree about which
 *  workspace a link names. */
export function findJiraIssueWorkspaceAttachmentsForIssue(
  workspaces: readonly Worktree[],
  issue: JiraIssue,
  source?: TaskSourceContext | null
): readonly Worktree[] {
  const live = workspaces.filter(isCandidate)
  const strict = findStrictJiraIssueWorkspaceAttachments(live, issue, source)
  if (strict.length > 0) {
    return strict
  }
  const fallback = findJiraIssueWorkspaceAttachment(live, issue)
  return fallback ? [fallback] : []
}

export function findJiraIssueWorkspaceAttachmentForIssue(
  workspaces: readonly Worktree[],
  issue: JiraIssue,
  source?: TaskSourceContext | null
): Worktree | null {
  return findJiraIssueWorkspaceAttachmentsForIssue(workspaces, issue, source)[0] ?? null
}

/** Why: board and list rows would otherwise rescan every workspace per row; one
 *  pass per workspace list turns each row lookup into a map hit. */
export function findJiraIssueWorkspaceAttachmentInIndex(
  index: JiraIssueWorkspaceAttachmentIndex,
  issue: JiraIssue,
  source?: TaskSourceContext | null
): Worktree | null {
  return findJiraIssueWorkspaceAttachmentForIssue(
    index.get(issue.key.toUpperCase()) ?? [],
    issue,
    source
  )
}
