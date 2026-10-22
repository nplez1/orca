import type { JSX } from 'react'
import type { JiraIssue, JiraIssueUpdate, JiraTransition } from '../../../../../shared/jira-types'
import {
  JiraTransitionFieldsForm,
  type JiraTransitionSubmitOutcome
} from '@/components/jira-transition-fields-form'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { translate } from '@/i18n/i18n'
import type { RuntimeJiraSettings } from '@/runtime/runtime-jira-client'

export type JiraTransitionFieldsRequest = {
  issue: JiraIssue
  transition: JiraTransition
}

/**
 * The dropped-transition shell over the one fields form every surface renders,
 * so a board drop, a board move and the detail pane's status control all collect
 * the same fields, seed them from the issue the same way, and report Jira's
 * field-level rejections against the same controls.
 */
export function TaskPageJiraTransitionFieldsDialog({
  request,
  providerSettings,
  submitting,
  onSubmit,
  onClose
}: {
  request: JiraTransitionFieldsRequest | null
  providerSettings: RuntimeJiraSettings
  submitting: boolean
  onSubmit: (updates: JiraIssueUpdate) => Promise<JiraTransitionSubmitOutcome>
  onClose: () => void
}): JSX.Element {
  return (
    <Dialog open={request !== null} onOpenChange={(open) => !open && !submitting && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogTitle className="sr-only">
          {translate(
            'auto.components.TaskPage.jiraTransitionFieldsTitle',
            'Update fields to move {{value0}}',
            { value0: request?.issue.key ?? '' }
          )}
        </DialogTitle>
        {request ? (
          <JiraTransitionFieldsForm
            key={`${request.issue.key}:${request.transition.id}`}
            transition={request.transition}
            pending={submitting}
            providerSettings={providerSettings}
            siteId={request.issue.siteId}
            onBack={onClose}
            onSubmit={onSubmit}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  )
}
