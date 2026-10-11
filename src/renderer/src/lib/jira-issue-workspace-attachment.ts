import type { JiraIssue } from '../../../shared/jira-types'
import { getJiraSiteIdentityKey } from '../../../shared/jira-issue-url'
import { getWorkspaceAttachments } from '../../../shared/workspace-attachments'
import type { WorkspaceAttachment, Worktree } from '../../../shared/worktree/types'

export type JiraIssueAttachmentRef = Pick<JiraIssue, 'key'> & Partial<Pick<JiraIssue, 'url'>>

/** Normalized Jira key -> linking workspaces, in workspace order. */
export type JiraIssueWorkspaceAttachmentIndex = ReadonlyMap<string, readonly Worktree[]>

export function normalizeJiraIssueKey(value: string | null | undefined): string | null {
  const trimmed = value?.trim()
  return trimmed ? trimmed.toUpperCase() : null
}

function attachmentJiraKey(item: WorkspaceAttachment): string | null {
  if (item.provider !== 'jira') {
    return null
  }
  return normalizeJiraIssueKey(item.jiraIdentifier ?? item.identifier)
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

/** Why: a workspace being deleted is about to stop existing, so neither the chip
 *  nor the flipped action should point at it. */
function isCandidate(worktree: Worktree): boolean {
  return !worktree.isArchived && !worktree.removing
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
      if (attachmentJiraKey(item) === key) {
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

/** Why: board and list rows would otherwise rescan every workspace per row; one
 *  pass per workspace list turns each row lookup into a map hit. */
export function buildJiraIssueWorkspaceAttachmentIndex(
  worktrees: readonly Worktree[]
): JiraIssueWorkspaceAttachmentIndex {
  const index = new Map<string, Worktree[]>()
  for (const worktree of worktrees) {
    if (!isCandidate(worktree)) {
      continue
    }
    const keys = new Set(getWorkspaceAttachments(worktree).map(attachmentJiraKey))
    for (const key of keys) {
      if (!key) {
        continue
      }
      const bucket = index.get(key)
      if (bucket) {
        bucket.push(worktree)
      } else {
        index.set(key, [worktree])
      }
    }
  }
  return index
}

export function findJiraIssueWorkspaceAttachmentInIndex(
  index: JiraIssueWorkspaceAttachmentIndex,
  issue: JiraIssueAttachmentRef
): Worktree | null {
  const key = normalizeJiraIssueKey(issue.key)
  if (!key) {
    return null
  }
  const candidates = index.get(key)
  return candidates ? findBestAttachment(candidates, issue) : null
}
