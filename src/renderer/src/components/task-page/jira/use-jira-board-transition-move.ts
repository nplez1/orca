import { jiraBoardErrorText } from './jira-board-error-text'
import { useState } from 'react'
import type {
  JiraCreateField,
  JiraFieldErrors,
  JiraIssue,
  JiraTransition
} from '../../../../../shared/jira-types'
import type { JiraCreateFieldSubmission } from '../../task-page-jira-create-fields'
import { jiraUpdateIssue } from '@/runtime/runtime-jira-client'
import type { RuntimeJiraSettings } from '@/runtime/runtime-jira-client'
import { translate } from '@/i18n/i18n'
import { toast } from 'sonner'

export type JiraTransitionOutcome =
  | { ok: true }
  | { ok: false; error: string; fieldErrors?: JiraFieldErrors }

/** The fields a transition's own screen requires, held while the form collects them. */
export type JiraPendingTransitionFields = {
  issue: JiraIssue
  transition: JiraTransition
  fields: JiraCreateField[]
}

/**
 * Applies a status transition and owns the fields form for one that needs input.
 * The card is patched into the target lane before Jira answers and rolled back on
 * rejection, so the visible failure is the old lane plus Jira's reason.
 */
export function useJiraBoardTransitionMove({
  providerSettings,
  applyIssuePatch,
  refreshBoard,
  onIssueMoved
}: {
  providerSettings: RuntimeJiraSettings
  applyIssuePatch: (key: string, patch: Partial<JiraIssue>, siteId?: string | null) => void
  refreshBoard: () => void
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
    submission?: JiraCreateFieldSubmission
  ): Promise<JiraTransitionOutcome> => {
    const previousStatus = issue.status
    applyIssuePatch(issue.key, { status: transition.to }, issue.siteId)
    markMoving(issue.key, true)
    setInFlightCount((current) => current + 1)
    let succeeded = false
    try {
      const hasFields = Boolean(
        submission?.customFields && Object.keys(submission.customFields).length > 0
      )
      const result = await jiraUpdateIssue(
        providerSettings,
        issue.key,
        {
          transitionId: transition.id,
          ...(hasFields
            ? {
                transitionFields: submission?.customFields,
                transitionUserFieldKeys: submission?.userFieldKeys,
                transitionTextFieldKeys: submission?.textFieldKeys
              }
            : {})
        },
        issue.siteId
      )
      if (!result.ok) {
        return {
          ok: false,
          error: result.error,
          ...(result.fieldErrors ? { fieldErrors: result.fieldErrors } : {})
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
      refreshBoard()
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
      fields: JiraCreateField[]
    ) => setPendingTransitionFields({ issue, transition, fields }),
    closeTransitionFields: () => {
      if (inFlightCount === 0) {
        setPendingTransitionFields(null)
      }
    },
    submitTransitionFields: async (
      submission: JiraCreateFieldSubmission
    ): Promise<JiraTransitionOutcome> => {
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
      const outcome = await applyTransition(pending.issue, pending.transition, submission)
      if (outcome.ok) {
        setPendingTransitionFields(null)
      }
      return outcome
    }
  }
}
