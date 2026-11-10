import { useState } from 'react'
import type { JSX } from 'react'
import type {
  JiraEditableField,
  JiraIssue,
  JiraIssueUpdate
} from '../../../../shared/jira/jira-types'
import {
  JiraIssueEditFieldsDialog,
  type JiraIssueFieldOutcome
} from '@/components/jira-issue-edit-fields-dialog'
import { useTranslate } from '@/i18n/use-translate'
import type { RuntimeJiraSettings } from '../../runtime/jira/runtime-jira-client'
import { IssuePanePropertyRow } from './IssuePanePropertyRow'

/** Property row plus its dialog, so the pane keeps only the row. */
export function JiraEditFieldsRow({
  issue,
  fields,
  loading,
  error,
  onRetry,
  pending,
  providerSettings,
  onSubmit
}: {
  issue: JiraIssue
  fields: JiraEditableField[]
  loading: boolean
  /** A failed read must not read as "None editable" — that claims a site answer. */
  error: string | null
  onRetry: () => void
  pending: boolean
  providerSettings: RuntimeJiraSettings
  onSubmit: (updates: JiraIssueUpdate) => Promise<JiraIssueFieldOutcome>
}): JSX.Element {
  const t = useTranslate()
  const [open, setOpen] = useState(false)
  return (
    <>
      <IssuePanePropertyRow
        label={t('auto.components.right.sidebar.IssuePane.fields', 'Fields')}
        pending={pending}
        value={
          error && fields.length === 0 ? (
            <span className="text-destructive">{error}</span>
          ) : fields.length > 0 ? (
            t('auto.components.right.sidebar.IssuePane.editableFields', '{{value0}} editable', {
              value0: fields.length
            })
          ) : (
            t('auto.components.right.sidebar.IssuePane.noEditableFields', 'None editable')
          )
        }
        withChevron={false}
        disabled={loading || fields.length === 0 || pending}
        onClick={() => setOpen(true)}
      />
      {error && fields.length === 0 ? (
        <button
          type="button"
          onClick={onRetry}
          className="w-full px-2 py-1 text-left text-2xs text-muted-foreground hover:text-foreground"
        >
          {t('auto.components.JiraIssueWorkspace.retryEditFields', 'Retry')}
        </button>
      ) : null}
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
