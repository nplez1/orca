import { translate } from '@/i18n/i18n'

/**
 * The confirmation a merge needs when the only thing that made it reachable was the viewer's admin
 * privileges.
 *
 * Why one definition: the sidebar, the PR page, the tasks cell, and the land-pull-request dialog each
 * own their own merge confirmation. A bypass is a policy act — GitHub itself gates it behind a
 * checkbox — so all four must say the same thing before any of them performs one, and none of them
 * may merge on `adminBypassRequired` without asking first.
 */
export function buildGitHubPRAdminBypassConfirmation(): {
  title: string
  description: string
  confirmLabel: string
} {
  return {
    title: translate(
      'auto.components.github.pr.admin.bypass.confirmation.1859e45dbc',
      'Bypass branch protection?'
    ),
    description: translate(
      'auto.components.github.pr.admin.bypass.confirmation.3db0f1be2f',
      'This pull request does not meet its branch protection rules. Merging will skip those rules using your admin privileges.'
    ),
    confirmLabel: translate(
      'auto.components.github.pr.admin.bypass.confirmation.28c23a473f',
      'Merge anyway'
    )
  }
}
