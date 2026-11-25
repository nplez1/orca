import type { AppState } from '@/store/types'
import { MODAL_DISMISSED_KEY } from '@/store/slices/ui/modal-slot-dismissal'

export type AutomationScriptStepReview = {
  repoId: string
  repoName: string
  script: string
  args: readonly string[]
  content: string
}

/**
 * Always asks, and offers no repo-wide trust: unlike orca.yaml hooks, neither trusting the repo
 * nor an earlier approval of the same content answers for a step, because its path and arguments
 * can be written by any automation client (an agent, a paired host) and repo trust vouches only
 * for file content.
 */
export function confirmAutomationScriptStep(
  state: Pick<AppState, 'openModal'>,
  review: AutomationScriptStepReview
): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false
    const settle = (decision: 'run' | 'trust' | 'skip'): void => {
      if (!settled) {
        settled = true
        resolve(decision === 'run')
      }
    }
    state.openModal('confirm-orca-yaml-hooks', {
      repoId: review.repoId,
      repoName: review.repoName,
      scriptKind: 'automationScript',
      scriptContent: review.content,
      scriptStep: { script: review.script, args: [...review.args] },
      versionOnly: false,
      previouslyApproved: false,
      repoWideTrust: false,
      automation: true,
      onResolve: settle,
      // Why: eviction must fail closed.
      [MODAL_DISMISSED_KEY]: () => settle('skip')
    })
  })
}
