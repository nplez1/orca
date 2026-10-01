import {
  isGitHubPRAdminBypassAvailable,
  type GitHubPRAdminBypassInput
} from '../../../shared/github/pull-request-admin-bypass'
import { translate } from '@/i18n/i18n'

export type { GitHubPRAdminBypassInput }

/**
 * Whether an otherwise-refused merge should be offered as an admin bypass.
 *
 * The rules about the pull request itself live in the shared module; this adds the one thing that is
 * a property of the presentation — a verdict that already allows a direct merge needs no bypass.
 */
export function shouldOfferGitHubPRAdminBypass(
  item: GitHubPRAdminBypassInput,
  directMergeAvailable: boolean
): boolean {
  return !directMergeAvailable && isGitHubPRAdminBypassAvailable(item)
}

/**
 * The tooltip for a merge offered on a bypass. The label stays the honest "Approval required", so
 * this is where an enabled merge button explains itself. It names only the review the merge is being
 * offered over, never the failing checks it is not (see `isGitHubPRAdminBypassAvailable`).
 */
export function gitHubPRAdminBypassTooltip(item: GitHubPRAdminBypassInput): string {
  return item.reviewDecision === 'CHANGES_REQUESTED'
    ? translate(
        'auto.components.github.pr.admin.bypass.cef3455aa7',
        'GitHub has requested changes on this pull request. Merging will ask you to bypass the rule with your admin privileges.'
      )
    : translate(
        'auto.components.github.pr.admin.bypass.d3d99c95fa',
        'GitHub requires an approving review before this pull request can merge. Merging will ask you to bypass the rule with your admin privileges.'
      )
}
