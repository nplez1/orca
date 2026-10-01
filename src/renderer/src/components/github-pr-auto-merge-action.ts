import {
  canEnableGitHubPRAutoMerge,
  type GitHubPRAutoMergeAvailabilityInput
} from '../../../shared/github/pull-request-auto-merge-availability'
import { translate } from '@/i18n/i18n'

export type GitHubPRAutoMergeAction = {
  kind: 'enable' | 'disable'
  label: string
  tooltip: string
}

/**
 * The auto-merge action a surface may offer, or null when none of them applies.
 *
 * Split out of the merge-state presenter so that deciding *whether* a direct merge is available and
 * deciding *what auto-merge control* accompanies it stay separately readable.
 */
export function resolveGitHubPRAutoMergeAction(
  item: GitHubPRAutoMergeAvailabilityInput
): GitHubPRAutoMergeAction | null {
  if (item.state !== 'open') {
    return null
  }
  if (item.autoMergeEnabled === true) {
    return {
      kind: 'disable',
      label: translate('auto.components.github.pr.merge.state.48d75ae118', 'Disable auto-merge'),
      tooltip: translate(
        'auto.components.github.pr.merge.state.62703b1dc4',
        'GitHub auto-merge is enabled for this pull request'
      )
    }
  }
  if (item.mergeQueueRequired === true) {
    return {
      kind: 'enable',
      label: translate('auto.components.github.pr.merge.state.b169f943e1', 'Merge when ready'),
      tooltip: translate(
        'auto.components.github.pr.merge.state.331ebe1170',
        'Add this pull request to the GitHub merge queue'
      )
    }
  }
  // Why: GitHub rejects enabling auto-merge on a conflicting PR, so offering it there only yields an
  // error toast; repos that disable auto-merge are suppressed by the shared availability rule.
  if (!canEnableGitHubPRAutoMerge(item)) {
    return null
  }
  return {
    kind: 'enable',
    label: translate('auto.components.github.pr.merge.state.4ab19a62ef', 'Enable auto-merge'),
    tooltip: translate(
      'auto.components.github.pr.merge.state.8f6cb3772f',
      'Merge this pull request automatically once requirements are met'
    )
  }
}

/**
 * Why: when GitHub already allows a direct merge, offering "Enable auto-merge" only yields a "clean
 * status" rejection. Keep the Disable action so users can still turn off an existing auto-merge
 * request; merge-queue "Merge when ready" paths set directMergeAvailable=false and never reach here.
 */
export function autoMergeActionWhenDirectMergeAvailable(
  autoMergeAction: GitHubPRAutoMergeAction | null
): GitHubPRAutoMergeAction | null {
  return autoMergeAction?.kind === 'disable' ? autoMergeAction : null
}
