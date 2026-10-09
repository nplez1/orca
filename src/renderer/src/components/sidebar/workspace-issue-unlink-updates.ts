import type { Worktree } from '../../../../shared/worktree/types'
import type { WorktreeMeta } from '../../../../shared/worktree/meta-types'
import { LINEAR_ISSUE_LINK_CLEARED } from '../../../../shared/linear/links'

/** The writes that clear the issue this workspace is linked to.
 *
 *  A workspace holds one issue at a time and stores it in whichever slot its
 *  provider owns, so a clear has to empty all of them rather than the one the
 *  caller happens to be looking at: the GitHub number, the Linear key, and the
 *  created-from work item with its read-routing context. A PR/MR work item is
 *  left alone — it belongs to the review surfaces, not to this link. */
export function buildIssueUnlinkUpdates(worktree: Worktree | undefined): Partial<WorktreeMeta> {
  const workItem = worktree?.linkedWorkItem
  const clearsCreatedFromIssue =
    workItem?.type === 'issue' &&
    (workItem.provider === 'github' ||
      workItem.provider === 'linear' ||
      workItem.provider === 'jira')
  return {
    linkedIssue: null,
    ...(worktree?.linkedLinearIssue ? LINEAR_ISSUE_LINK_CLEARED : {}),
    ...(clearsCreatedFromIssue ? { linkedWorkItem: null, linkedTaskSourceContext: null } : {})
  }
}
