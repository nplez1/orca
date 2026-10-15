import { useState } from 'react'
import type { JSX } from 'react'
import type { JiraCreateField, JiraFieldErrors, JiraUser } from '../../../../../shared/jira-types'
import { resolveJiraFieldControlKind } from '../../../../../shared/jira-field-rendering'
import {
  buildJiraCreateSubmission,
  type JiraCreateFieldSubmission
} from '../../task-page-jira-create-fields'
import { JiraSchemaFieldControl } from '@/components/jira-schema-field'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { LoaderCircle } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import type { RuntimeJiraSettings } from '@/runtime/runtime-jira-client'

export type JiraTransitionFieldsRequest = {
  issueKey: string
  transitionName: string
  siteId?: string | null
  fields: JiraCreateField[]
}

type TransitionFieldsOutcome =
  | { ok: true }
  | { ok: false; error: string; fieldErrors?: JiraFieldErrors }

function fieldKey(request: JiraTransitionFieldsRequest): string {
  return `${request.issueKey}:${request.transitionName}:${request.fields
    .map((field) => field.key)
    .join(',')}`
}

function TransitionFieldsForm({
  request,
  providerSettings,
  submitting,
  onSubmit,
  onClose
}: {
  request: JiraTransitionFieldsRequest
  providerSettings: RuntimeJiraSettings
  submitting: boolean
  onSubmit: (values: JiraCreateFieldSubmission) => Promise<TransitionFieldsOutcome>
  onClose: () => void
}): JSX.Element {
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [selectedUsers, setSelectedUsers] = useState<Record<string, JiraUser | null>>({})
  const [error, setError] = useState<string | null>(null)
  const [fieldErrors, setFieldErrors] = useState<JiraFieldErrors>({})

  const renderable = request.fields.filter((field) => resolveJiraFieldControlKind(field) !== null)
  const unrenderable = request.fields.filter((field) => resolveJiraFieldControlKind(field) === null)
  const missing = renderable.filter((field) => !(drafts[field.key] ?? '').trim())
  const blocked = unrenderable.length > 0 || missing.length > 0

  const handleSubmit = async (): Promise<void> => {
    setError(null)
    setFieldErrors({})
    const submission = buildJiraCreateSubmission(renderable, drafts)
    const result = await onSubmit(submission)
    if (!result.ok) {
      setError(result.error)
      setFieldErrors(result.fieldErrors ?? {})
    }
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>
          {translate(
            'auto.components.TaskPage.jiraTransitionFieldsTitle',
            'Update fields to move {{value0}}',
            { value0: request.issueKey }
          )}
        </DialogTitle>
        <DialogDescription>
          {translate(
            'auto.components.TaskPage.jiraTransitionFieldsDescription',
            'Jira requires these fields before it will apply the {{value0}} transition.',
            { value0: request.transitionName }
          )}
        </DialogDescription>
      </DialogHeader>
      <div className="flex max-h-[60vh] flex-col gap-3 overflow-y-auto scrollbar-sleek">
        {unrenderable.length > 0 ? (
          <p
            role="alert"
            className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive"
          >
            {translate(
              'auto.components.TaskPage.jiraTransitionFieldsUnsupported',
              'Orca cannot set {{value0}}, so Jira will refuse this move. Complete the transition in Jira.',
              { value0: unrenderable.map((field) => field.name).join(', ') }
            )}
          </p>
        ) : null}
        {renderable.map((field) => (
          <div key={field.key} className="flex min-w-0 flex-col gap-1">
            <label className="text-[11px] font-medium text-muted-foreground">
              {field.name}
              {field.required ? <span className="ml-0.5 text-destructive">*</span> : null}
            </label>
            <JiraSchemaFieldControl
              field={field}
              value={drafts[field.key] ?? ''}
              disabled={submitting}
              userField={{
                selectedUser: selectedUsers[field.key] ?? null,
                onSelectUser: (user) =>
                  setSelectedUsers((previous) => ({ ...previous, [field.key]: user })),
                providerSettings,
                siteId: request.siteId
              }}
              onValueChange={(value) =>
                setDrafts((previous) => ({ ...previous, [field.key]: value }))
              }
            />
            {fieldErrors[field.key] ? (
              <p className="text-[11px] text-destructive">{fieldErrors[field.key]}</p>
            ) : null}
          </div>
        ))}
        {error ? (
          <p
            role="alert"
            className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive"
          >
            {error}
          </p>
        ) : null}
      </div>
      <DialogFooter>
        <Button variant="outline" onClick={onClose} disabled={submitting}>
          {translate('auto.components.TaskPage.ff69a30681', 'Cancel')}
        </Button>
        <Button onClick={() => void handleSubmit()} disabled={submitting || blocked}>
          {submitting ? (
            <>
              <LoaderCircle className="size-4 animate-spin" />
              {translate('auto.components.TaskPage.jiraTransitionFieldsApplying', 'Moving…')}
            </>
          ) : (
            translate('auto.components.TaskPage.jiraTransitionFieldsApply', 'Apply and move')
          )}
        </Button>
      </DialogFooter>
    </>
  )
}

/**
 * Collects the fields a transition's own screen requires, so a workflow that
 * demands input can be completed rather than attempted and refused. Jira's
 * field-level rejection is shown against the field it names.
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
  onSubmit: (values: JiraCreateFieldSubmission) => Promise<TransitionFieldsOutcome>
  onClose: () => void
}): JSX.Element {
  return (
    <Dialog open={request !== null} onOpenChange={(open) => !open && !submitting && onClose()}>
      <DialogContent className="max-w-lg">
        {request ? (
          <TransitionFieldsForm
            key={fieldKey(request)}
            request={request}
            providerSettings={providerSettings}
            submitting={submitting}
            onSubmit={onSubmit}
            onClose={onClose}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  )
}
