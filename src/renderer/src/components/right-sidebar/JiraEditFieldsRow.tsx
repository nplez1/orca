import { useState } from 'react'
import type { JSX } from 'react'
import type { JiraEditableField, JiraIssue, JiraIssueUpdate } from '../../../../shared/jira-types'
import {
  JiraIssueEditFieldsDialog,
  type JiraIssueFieldOutcome
} from '@/components/jira-issue-edit-fields-dialog'
import { translate } from '@/i18n/i18n'
import type { RuntimeJiraSettings } from '@/runtime/runtime-jira-client'
import { IssuePanePropertyRow } from './IssuePanePropertyRow'

/** Property row plus its dialog, so the pane keeps only the row. */
export function JiraEditFieldsRow({
  issue,
  fields,
  loading,
  pending,
  providerSettings,
  onSubmit
}: {
  issue: JiraIssue
  fields: JiraEditableField[]
  loading: boolean
  pending: boolean
  providerSettings: RuntimeJiraSettings
  onSubmit: (updates: JiraIssueUpdate) => Promise<JiraIssueFieldOutcome>
}): JSX.Element {
  const [open, setOpen] = useState(false)
  return (
    <>
      <IssuePanePropertyRow
        label={translate('auto.components.right.sidebar.IssuePane.fields', 'Fields')}
        pending={pending}
        value={
          fields.length > 0
            ? translate(
                'auto.components.right.sidebar.IssuePane.editableFields',
                '{{value0}} editable',
                { value0: fields.length }
              )
            : translate('auto.components.right.sidebar.IssuePane.noEditableFields', 'None editable')
        }
        withChevron={false}
        disabled={loading || fields.length === 0 || pending}
        onClick={() => setOpen(true)}
      />
      <JiraIssueEditFieldsDialog
        open={open}
        onOpenChange={setOpen}
        issue={issue}
        fields={fields}
        providerSettings={providerSettings}
        submitting={pending}
        onSubmit={onSubmit}
      />
    </>
  )
}
