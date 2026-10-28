import { useMemo, useState } from 'react'
import type { JSX } from 'react'
import type {
  JiraEditableField,
  JiraFieldErrors,
  JiraIssue,
  JiraUser
} from '../../../shared/jira/jira-types'
import {
  isJiraTextAreaField,
  isJiraUserField,
  resolveJiraObjectListFieldKind
} from '../../../shared/jira-field-rendering'
import { splitJiraFieldDraft } from '../../../shared/jira-field-draft'
import { buildJiraCreateFieldValue } from '@/components/task-page/jira/task-page-jira-create-fields'
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

export type JiraIssueFieldOutcome =
  | { ok: true }
  | { ok: false; error: string; fieldErrors?: JiraFieldErrors }

/** The user picker needs a display name to show before any search; editmeta
 *  reports one, and the accountId alone is what gets submitted. */
function selectedUserFor(entry: JiraEditableField): JiraUser | null {
  if (!entry.value.trim() || !isJiraUserField(entry.field)) {
    return null
  }
  return { accountId: entry.value, displayName: entry.displayName ?? entry.value }
}

/** The people a multi-user field already holds. A host that predates `users` reports only
 *  the joined names beside the ids, so pair them back up rather than showing bare
 *  accountIds; when the counts do not line up, the caller keeps the name hint instead. */
function selectedUsersFor(entry: JiraEditableField): JiraUser[] {
  if (entry.users) {
    return entry.users
  }
  const ids = splitJiraFieldDraft(entry.value)
  const names = (entry.displayName ?? '')
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean)
  if (ids.length === 0 || names.length !== ids.length) {
    return []
  }
  return ids.map((id, index) => ({ accountId: id, displayName: names[index] }))
}

function EditFieldsForm({
  issue,
  fields,
  providerSettings,
  submitting,
  onSubmit,
  onClose
}: {
  issue: JiraIssue
  fields: JiraEditableField[]
  providerSettings: RuntimeJiraSettings
  submitting: boolean
  onSubmit: (updates: {
    customFields: Record<string, unknown>
    userFieldKeys: string[]
    textFieldKeys: string[]
  }) => Promise<JiraIssueFieldOutcome>
  onClose: () => void
}): JSX.Element {
  const [drafts, setDrafts] = useState<Record<string, string>>(() =>
    Object.fromEntries(fields.map((entry) => [entry.field.key, entry.value]))
  )
  const [selectedUsers, setSelectedUsers] = useState<Record<string, JiraUser | null>>(() =>
    Object.fromEntries(fields.map((entry) => [entry.field.key, selectedUserFor(entry)]))
  )
  const [selectedUserLists, setSelectedUserLists] = useState<Record<string, JiraUser[]>>(() =>
    Object.fromEntries(fields.map((entry) => [entry.field.key, selectedUsersFor(entry)]))
  )
  const [error, setError] = useState<string | null>(null)
  const [fieldErrors, setFieldErrors] = useState<JiraFieldErrors>({})

  const hasChanges = useMemo(
    () => fields.some((entry) => (drafts[entry.field.key] ?? '') !== entry.value),
    [drafts, fields]
  )

  const handleSubmit = async (): Promise<void> => {
    setError(null)
    setFieldErrors({})
    const customFields: Record<string, unknown> = {}
    const userFieldKeys: string[] = []
    const textFieldKeys: string[] = []
    for (const entry of fields) {
      const key = entry.field.key
      const draft = drafts[key] ?? ''
      if (draft === entry.value) {
        continue
      }
      if (!draft.trim()) {
        // Why [] for a components/versions field: it is an array of references, and Jira
        // clears an array field with an empty array.
        customFields[key] = resolveJiraObjectListFieldKind(entry.field) !== null ? [] : null
        continue
      }
      const value = buildJiraCreateFieldValue(entry.field, draft)
      if (value === undefined) {
        continue
      }
      customFields[key] = value
      if (isJiraUserField(entry.field)) {
        userFieldKeys.push(key)
      } else if (isJiraTextAreaField(entry.field)) {
        textFieldKeys.push(key)
      }
    }
    if (Object.keys(customFields).length === 0) {
      onClose()
      return
    }
    const outcome = await onSubmit({ customFields, userFieldKeys, textFieldKeys })
    if (!outcome.ok) {
      setError(outcome.error)
      setFieldErrors(outcome.fieldErrors ?? {})
      return
    }
    onClose()
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>
          {translate('auto.components.JiraIssueWorkspace.editFieldsTitle', 'Edit Jira fields')}
        </DialogTitle>
        <DialogDescription>
          {translate(
            'auto.components.JiraIssueWorkspace.editFieldsDescription',
            'Custom fields Jira allows you to change on {{value0}}.',
            { value0: issue.key }
          )}
        </DialogDescription>
      </DialogHeader>
      <div className="flex max-h-[60vh] flex-col gap-3 overflow-y-auto scrollbar-sleek">
        {fields.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            {translate(
              'auto.components.JiraIssueWorkspace.editFieldsEmpty',
              'Jira reports no editable custom fields on this issue.'
            )}
          </p>
        ) : null}
        {fields.map((entry) => (
          <div key={entry.field.key} className="flex min-w-0 flex-col gap-1">
            <label className="text-[11px] font-medium text-muted-foreground">
              {entry.field.name}
              {entry.field.required ? <span className="ml-0.5 text-destructive">*</span> : null}
            </label>
            <JiraSchemaFieldControl
              field={entry.field}
              value={drafts[entry.field.key] ?? ''}
              // Only while untouched: once edited, the hint would describe a value
              // the draft no longer holds.
              displayValue={drafts[entry.field.key] === entry.value ? entry.displayName : undefined}
              disabled={submitting}
              userField={{
                selectedUser: selectedUsers[entry.field.key] ?? null,
                onSelectUser: (user) =>
                  setSelectedUsers((previous) => ({ ...previous, [entry.field.key]: user })),
                selectedUsers: selectedUserLists[entry.field.key] ?? [],
                onSelectUsers: (users) =>
                  setSelectedUserLists((previous) => ({ ...previous, [entry.field.key]: users })),
                providerSettings,
                siteId: issue.siteId,
                allowClear: true
              }}
              onValueChange={(value) =>
                setDrafts((previous) => ({ ...previous, [entry.field.key]: value }))
              }
            />
            {fieldErrors[entry.field.key] ? (
              <p className="text-[11px] text-destructive">{fieldErrors[entry.field.key]}</p>
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
        <Button onClick={() => void handleSubmit()} disabled={submitting || !hasChanges}>
          {submitting ? (
            <>
              <LoaderCircle className="size-4 animate-spin" />
              {translate('auto.components.JiraIssueWorkspace.editFieldsSaving', 'Saving…')}
            </>
          ) : (
            translate('auto.components.right.sidebar.IssuePane.save', 'Save')
          )}
        </Button>
      </DialogFooter>
    </>
  )
}

/**
 * The edit-side form: every custom field Jira reports as editable on this issue,
 * not just the ones the task row happens to show. Dev and QE are user-picker
 * custom fields, so they are found by schema rather than by a hardcoded id, and
 * clearing one submits null rather than leaving a stale value behind.
 */
export function JiraIssueEditFieldsDialog({
  open,
  onOpenChange,
  issue,
  fields,
  providerSettings,
  submitting,
  onSubmit
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  issue: JiraIssue
  fields: JiraEditableField[]
  providerSettings: RuntimeJiraSettings
  submitting: boolean
  onSubmit: (updates: {
    customFields: Record<string, unknown>
    userFieldKeys: string[]
    textFieldKeys: string[]
  }) => Promise<JiraIssueFieldOutcome>
}): JSX.Element {
  return (
    <Dialog open={open} onOpenChange={(next) => !submitting && onOpenChange(next)}>
      <DialogContent className="max-w-lg">
        {open ? (
          <EditFieldsForm
            // Reopening for another issue, or a refreshed value, starts from what
            // Jira holds now rather than the draft the previous open left behind.
            key={`${issue.key}:${fields.map((entry) => `${entry.field.key}=${entry.value}`).join('|')}`}
            issue={issue}
            fields={fields}
            providerSettings={providerSettings}
            submitting={submitting}
            onSubmit={onSubmit}
            onClose={() => onOpenChange(false)}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  )
}
