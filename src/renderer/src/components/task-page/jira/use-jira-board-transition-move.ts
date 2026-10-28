import { jiraBoardErrorText } from './jira-board-error-text'
import { useState } from 'react'
import type {
  JiraFieldErrors,
  JiraIssue,
  JiraIssueUpdate,
  JiraTransition
} from '../../../../../shared/jira/jira-types'
import type { JiraTransitionSubmitOutcome } from '../../jira-transition-fields-form'
import { jiraUpdateIssue } from '@/runtime/runtime-jira-client'
import type { RuntimeJiraSettings } from '@/runtime/runtime-jira-client'
import { translate } from '@/i18n/i18n'
import { toast } from 'sonner'

/** The fields a transition's own screen requires, held while the form collects them. */
export type JiraPendingTransitionFields = {
  issue: JiraIssue
  transition: JiraTransition
  /** Jira's field-level refusal that reopened the form, so the field it names is
   *  asked for again instead of reported as a sentence with no control behind it. */
  rejectedFieldErrors?: JiraFieldErrors
  /** Jira's workflow messages from that refusal, which a field-level display hides. */
  errorMessages?: string[]
  /** The rejection that reopened the form, shown until the form has its own. */
  error?: string | null
}

/**
 * Applies a status transition and owns the fields form for one that needs input.
 * The card is patched into the target lane before Jira answers and rolled back on
 * rejection, so the visible failure is the old lane plus Jira's reason. The reload
 * afterwards reconciles behind the rendered board rather than blanking it.
 */
export function useJiraBoardTransitionMove({
  providerSettings,
  applyIssuePatch,
  revalidateBoard,
  onIssueMoved
}: {
  providerSettings: RuntimeJiraSettings
  applyIssuePatch: (key: string, patch: Partial<JiraIssue>, siteId?: string | null) => void
  revalidateBoard: () => void
  onIssueMoved: (issue: JiraIssue) => void
}) {
  const [movingIssueKeys, setMovingIssueKeys] = useState<string[]>([])
  // Why a count, not a flag: two moves can overlap, and the first to finish must
  // not re-enable the other move's dialog mid-request.
  const [inFlightCount, setInFlightCount] = useState(0)
  const [pendingTransitionFields, setPendingTransitionFields] =
    useState<JiraPendingTransitionFields | null>(null)

  const markMoving = (issueKey: string, moving: boolean): void => {
    setMovingIssueKeys((previous) => {
      if (moving) {
        return previous.includes(issueKey) ? previous : [...previous, issueKey]
      }
      return previous.filter((entry) => entry !== issueKey)
    })
  }

  const applyTransition = async (
    issue: JiraIssue,
    transition: JiraTransition,
    updates?: JiraIssueUpdate
  ): Promise<JiraTransitionSubmitOutcome> => {
    const previousStatus = issue.status
    applyIssuePatch(issue.key, { status: transition.to }, issue.siteId)
    markMoving(issue.key, true)
    setInFlightCount((current) => current + 1)
    let succeeded = false
    try {
      const result = await jiraUpdateIssue(
        providerSettings,
        issue.key,
        { ...updates, transitionId: transition.id },
        issue.siteId
      )
      if (!result.ok) {
        return {
          ok: false,
          error: result.error,
          ...(result.fieldErrors ? { fieldErrors: result.fieldErrors } : {}),
          ...(result.errorMessages ? { errorMessages: result.errorMessages } : {})
        }
      }
      succeeded = true
      toast.success(
        translate('auto.components.TaskPage.jiraIssueMoved', '{{value0}} moved to {{value1}}', {
          value0: issue.key,
          value1: transition.to.name
        })
      )
      onIssueMoved(issue)
      revalidateBoard()
      return { ok: true }
    } catch (error) {
      return { ok: false, error: jiraBoardErrorText(error) }
    } finally {
      if (!succeeded) {
        applyIssuePatch(issue.key, { status: previousStatus }, issue.siteId)
      }
      markMoving(issue.key, false)
      setInFlightCount((current) => Math.max(0, current - 1))
    }
  }

  return {
    movingIssueKeys,
    transitionSaving: inFlightCount > 0,
    pendingTransitionFields,
    applyTransition,
    openTransitionFields: (
      issue: JiraIssue,
      transition: JiraTransition,
      rejection?: Pick<
        JiraPendingTransitionFields,
        'rejectedFieldErrors' | 'errorMessages' | 'error'
      >
    ) => setPendingTransitionFields({ issue, transition, ...rejection }),
    closeTransitionFields: () => {
      if (inFlightCount === 0) {
        setPendingTransitionFields(null)
      }
    },
    submitTransitionFields: async (
      updates: JiraIssueUpdate
    ): Promise<JiraTransitionSubmitOutcome> => {
      const pending = pendingTransitionFields
      if (!pending) {
        return {
          ok: false,
          error: translate(
            'auto.components.TaskPage.jiraNoPendingTransition',
            'No transition is pending.'
          )
        }
      }
      const outcome = await applyTransition(pending.issue, pending.transition, updates)
      if (outcome.ok) {
        setPendingTransitionFields(null)
      }
      return outcome
    }
  }
}
