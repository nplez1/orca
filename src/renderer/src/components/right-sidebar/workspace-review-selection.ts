import type { HostedReviewInfo, HostedReviewProvider } from '../../../../shared/hosted-review'
import { getWorkspaceAttachments } from '../../../../shared/workspace-attachments'
import { getWorkspaceAttachmentUrlScope } from '../../../../shared/workspace-attachment-normalization'
import type { WorkspaceAttachment, Worktree } from '../../../../shared/worktree/types'

/** Review providers a workspace can hold an attachment for. Issues are excluded: this is the
 *  review half of `linkedItems`, which the Checks and Source Control panes both switch between. */
export const WORKSPACE_REVIEW_PROVIDERS = [
  'github',
  'gitlab',
  'bitbucket',
  'azure-devops',
  'gitea'
] as const

export type WorkspaceReviewProvider = (typeof WORKSPACE_REVIEW_PROVIDERS)[number]

export function isWorkspaceReviewProvider(
  provider: string | null | undefined
): provider is WorkspaceReviewProvider {
  return WORKSPACE_REVIEW_PROVIDERS.some((known) => known === provider)
}

export function isWorkspaceReviewAttachment(
  item: WorkspaceAttachment
): item is WorkspaceReviewAttachment {
  return item.type !== 'issue' && isWorkspaceReviewProvider(item.provider)
}

/** An attachment that names a review, with the provider narrowed to one a workspace can hold. */
export type WorkspaceReviewAttachment = WorkspaceAttachment & {
  provider: WorkspaceReviewProvider
}

/** The review the Checks pane can render: GitHub and GitLab have a checks/comment body here. */
export function isChecksPaneReviewProvider(
  provider: string | null | undefined
): provider is 'github' | 'gitlab' {
  return provider === 'github' || provider === 'gitlab'
}

/** A review as one pane's switcher lists and selects it.
 *
 *  The key is the review's identity, not the attachment's: an attachment key folds in the title,
 *  URL and source scope, so it moves when a background refresh fills one of those in and a
 *  selection held on it would drop on the next store write. */
export type WorkspaceReviewSelectionEntry = {
  key: string
  provider: WorkspaceReviewProvider
  number: number
  title: string
  url: string
  /** The attachment this entry came from. Null for a review only the branch lookup knows about,
   *  which is the workspace's own review before its attachment is written. */
  attachment: WorkspaceAttachment | null
}

/** A review number is unique per provider, and both panes read it from this workspace's repo, so
 *  provider and number are the whole identity. Two same-numbered reviews in different repos cannot
 *  be told apart by these panes anyway, and pretending otherwise would split one row in two. */
export function workspaceReviewSelectionKey(
  provider: WorkspaceReviewProvider,
  number: number
): string {
  return `${provider}:${number}`
}

/** The workspace's own review, as much of it as selection needs. */
export type WorkspaceActiveReview = {
  provider: HostedReviewProvider
  number: number
  title: string
  url: string
}

type ReviewAttachmentSource = Pick<Worktree, 'linkedItems'>

function attachmentMatchesReview(
  item: WorkspaceAttachment,
  review: Pick<WorkspaceActiveReview, 'provider' | 'number' | 'url'>
): boolean {
  if (item.provider !== review.provider || item.number !== review.number) {
    return false
  }
  // Why the URL scope: the same provider and number can be a different repository's review, and an
  // attachment that names a URL is the only evidence of which one this workspace holds.
  return (
    !item.url ||
    !review.url ||
    getWorkspaceAttachmentUrlScope(item) ===
      getWorkspaceAttachmentUrlScope({ ...item, url: review.url })
  )
}

/** Every review this workspace holds, the workspace's own review first.
 *
 *  `linkedItems` keeps every attachment while the compatibility slots name only one active review,
 *  so the list is the attachments plus the active review — the same union the sidebar card lists.
 *  The active review leads because it is what the panes show by default, and because the sidebar's
 *  PR glyph reads the same one. */
export function resolveWorkspaceReviewSelection(
  worktree: ReviewAttachmentSource | null | undefined,
  active: WorkspaceActiveReview | null | undefined
): WorkspaceReviewSelectionEntry[] {
  if (!worktree) {
    return []
  }
  const attached: WorkspaceReviewSelectionEntry[] = []
  const attachmentEntries: { entry: WorkspaceReviewSelectionEntry; item: WorkspaceAttachment }[] =
    []
  for (const item of getWorkspaceAttachments(worktree)) {
    if (!isWorkspaceReviewAttachment(item)) {
      continue
    }
    const entry: WorkspaceReviewSelectionEntry = {
      key: workspaceReviewSelectionKey(item.provider, item.number),
      provider: item.provider,
      number: item.number,
      title: item.title ?? '',
      url: item.url ?? '',
      attachment: item
    }
    attached.push(entry)
    attachmentEntries.push({ entry, item })
  }
  const entries: WorkspaceReviewSelectionEntry[] = []
  const seen = new Set<string>()
  const push = (entry: WorkspaceReviewSelectionEntry): void => {
    if (!seen.has(entry.key)) {
      seen.add(entry.key)
      entries.push(entry)
    }
  }
  const activeProvider = active?.provider
  if (active && isWorkspaceReviewProvider(activeProvider)) {
    // Why the attachment when one matches: it carries the source context and repo the review must
    // be read from, which the active slot alone cannot say.
    push(
      attachmentEntries.find(({ item }) => attachmentMatchesReview(item, active))?.entry ?? {
        key: workspaceReviewSelectionKey(activeProvider, active.number),
        provider: activeProvider,
        number: active.number,
        title: active.title,
        url: active.url,
        attachment: null
      }
    )
  }
  for (const entry of attached) {
    push(entry)
  }
  return entries
}

/** The entry a stored selection names, or the workspace's own review when the selection is gone
 *  (the review was unlinked, or the key belongs to another workspace's list). */
export function findWorkspaceReviewSelection(
  entries: readonly WorkspaceReviewSelectionEntry[],
  selectedKey: string | null | undefined
): WorkspaceReviewSelectionEntry | null {
  if (entries.length === 0) {
    return null
  }
  return entries.find((entry) => entry.key === selectedKey) ?? entries[0]
}

export function hasMultipleWorkspaceReviews(
  entries: readonly WorkspaceReviewSelectionEntry[]
): boolean {
  return entries.length > 1
}

/** The attachment that carries a shown review, when the workspace holds one.
 *
 *  `getWorkspaceAttachments` unions `linkedItems` with the legacy slots, so this answers for a
 *  review only a slot names as well as for one the user attached. A caller that unlinks uses it to
 *  remove the row that produced the review, instead of clearing a slot that would leave the row —
 *  or, for a review the branch lookup discovered, leave the review itself — in place. */
export function findWorkspaceReviewAttachment(
  worktree: ReviewAttachmentSource | null | undefined,
  review: Pick<WorkspaceActiveReview, 'provider' | 'number' | 'url'> | null | undefined
): WorkspaceAttachment | null {
  if (!worktree || !review) {
    return null
  }
  return (
    getWorkspaceAttachments(worktree).find((item) => attachmentMatchesReview(item, review)) ?? null
  )
}

/** The review a pane should show instead of the workspace's own, or null to keep the workspace's.
 *
 *  A pick only wins when the pane can actually render it: the Checks pane has no body for a
 *  Bitbucket or Gitea review, so picking one there would blank a pane that has something to show.
 *  Returning null is the whole fallback — callers keep the review they already resolved. */
export function pickShownReview(
  selection: {
    isWorkspaceReview: boolean
    selectedReview: HostedReviewInfo | null
  },
  canRender: (provider: HostedReviewProvider) => boolean
): HostedReviewInfo | null {
  if (selection.isWorkspaceReview || !selection.selectedReview) {
    return null
  }
  return canRender(selection.selectedReview.provider) ? selection.selectedReview : null
}
