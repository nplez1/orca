import { useState } from 'react'
import { ExternalLink } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { JiraSchemaFieldControl } from '@/components/jira-schema-field'
import { buildJiraCreateSubmission } from '@/components/task-page-jira-create-fields'
import { translate } from '@/i18n/i18n'
import { getCommentBodySubmitState } from '@/lib/comment-body-submit-state'
import type { RuntimeJiraSettings } from '@/runtime/runtime-jira-client'
import { isJiraUserField, resolveJiraFieldControlKind } from '../../../shared/jira-field-rendering'
import {
  buildResolutionFieldValue,
  classifyTransitionRequirements,
  transitionAllowedValueKey,
  transitionAllowedValueLabel
} from '../../../shared/jira-transition-fields'
import type {
  JiraCreateField,
  JiraFieldErrors,
  JiraIssueUpdate,
  JiraTransition,
  JiraUser
} from '../../../shared/jira-types'

export type JiraTransitionSubmitOutcome =
  | { ok: true }
  | {
      ok: false
      error: string
      fieldErrors?: JiraFieldErrors
      /** Jira's own workflow messages, which the joined `error` also carries but a
       *  field-level display would otherwise hide. */
      errorMessages?: string[]
    }

type Props = {
  transition: JiraTransition
  pending: boolean
  onBack: () => void
  onSubmit: (updates: JiraIssueUpdate) => Promise<JiraTransitionSubmitOutcome>
  /** Needed by the user picker; without it a user field falls back to a text box. */
  providerSettings?: RuntimeJiraSettings
  siteId?: string | null
  /** Fields an earlier attempt had rejected by name, asked for even though the
   *  issue looks like it fills them, so a refusal can be acted on here. */
  forcedFieldKeys?: ReadonlySet<string>
  /** The field-level refusal that reopened this form, shown beside its control. */
  rejectedFieldErrors?: JiraFieldErrors
  /** Jira's workflow messages from the refusal that reopened this form. Its joined
   *  `error` carries them too, but a field-level display would hide them. */
  rejectedErrorMessages?: string[]
  /** A rejection this surface already received, shown until the form has its own. */
  errorReason?: string | null
  /** The escape hatch when a text box cannot satisfy Jira. */
  issueUrl?: string
}

/**
 * Collects everything a transition's screen requires, so a workflow that demands
 * input can be completed rather than refused. A field the issue already fills is
 * seeded with that value and left out of the submission unless it changes, and a
 * field Jira refuses is named back to the user so they can fix it and retry —
 * including a field this form had skipped, which a rejection brings back.
 */
export function JiraTransitionFieldsForm({
  transition,
  pending,
  onBack,
  onSubmit,
  providerSettings,
  siteId,
  forcedFieldKeys,
  rejectedFieldErrors,
  rejectedErrorMessages,
  errorReason,
  issueUrl
}: Props): React.JSX.Element | null {
  const [drafts, setDrafts] = useState<Record<string, string>>(() => ({}))
  const [selectedUsers, setSelectedUsers] = useState<Record<string, JiraUser | null>>({})
  const [resolution, setResolution] = useState('')
  const [comment, setComment] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [fieldErrors, setFieldErrors] = useState<JiraFieldErrors>(rejectedFieldErrors ?? {})
  const [errorMessages, setErrorMessages] = useState<string[]>([])
  // Why sticky: a field a rejection brought back must stay in the form while the next
  // attempt is in flight, or the value the user just typed is hidden and dropped.
  const [carriedKeys, setCarriedKeys] = useState<ReadonlySet<string>>(
    () => new Set(Object.keys(rejectedFieldErrors ?? {}))
  )
  const forced = new Set([...(forcedFieldKeys ?? []), ...carriedKeys, ...Object.keys(fieldErrors)])
  const requirement = classifyTransitionRequirements(transition, forced)
  if (requirement.kind !== 'form') {
    return null
  }
  const draftOf = (field: JiraCreateField): string =>
    drafts[field.key] ?? (requirement.fields.includes(field) ? (field.currentValue ?? '') : '')
  const resolutionDraft = requirement.resolution
    ? resolution || (requirement.resolution.currentValue ?? '')
    : ''
  const resolutionValue = requirement.resolution
    ? buildResolutionFieldValue(requirement.resolution, resolutionDraft)
    : null
  const commentState = getCommentBodySubmitState(comment)
  // Why only control-backed fields gate submission: a schema Orca has no control
  // for gets a text box that may not carry the shape Jira wants, so it stays the
  // user's best guess and Jira's own rejection is what gets reported back.
  const unfilled = requirement.fields.filter(
    (field) => resolveJiraFieldControlKind(field) !== null && !draftOf(field).trim()
  )
  // Why only a rendered field suppresses the banner: Jira's message joins its field
  // errors, so repeating it there would say the same thing twice — but a rejection
  // naming a field this form does not render has nothing else to be read in.
  const renderedKeys = [
    ...requirement.fields.map((field) => field.key),
    ...(requirement.resolution ? [requirement.resolution.key] : [])
  ]
  const carriesError = renderedKeys.some((key) => fieldErrors[key])
  const carriedMessages = rejectedErrorMessages ?? []
  const shownError = errorMessages.length
    ? errorMessages.join('; ')
    : carriedMessages.length
      ? carriedMessages.join('; ')
      : carriesError
        ? null
        : (error ?? errorReason ?? null)
  const canSubmit =
    unfilled.length === 0 &&
    (!requirement.resolution || resolutionValue !== null) &&
    (!requirement.commentRequired || commentState.status === 'ready')

  async function submit(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    if (pending || !canSubmit || requirement.kind !== 'form') {
      return
    }
    setError(null)
    setFieldErrors({})
    setErrorMessages([])
    // Why a forced field with a control is always sent: it was brought back because
    // Jira refused it, and resubmitting the value the issue already holds would repeat
    // the same request. A field with no control keeps the never-rewrite rule.
    const mustSend = (field: JiraCreateField): boolean =>
      forced.has(field.key) &&
      resolveJiraFieldControlKind(field) !== null &&
      draftOf(field).trim() !== ''
    const changed = requirement.fields.filter(
      (field) => mustSend(field) || draftOf(field).trim() !== (field.currentValue ?? '').trim()
    )
    const values = Object.fromEntries(
      requirement.fields.map((field) => [field.key, draftOf(field)])
    )
    const submission = buildJiraCreateSubmission(changed, values)
    const transitionFields = { ...submission.customFields }
    if (requirement.resolution && resolutionValue) {
      transitionFields[requirement.resolution.key] = resolutionValue
    }
    const updates: JiraIssueUpdate = {
      transitionId: transition.id,
      ...(Object.keys(transitionFields).length > 0 ? { transitionFields } : {}),
      ...(submission.userFieldKeys ? { transitionUserFieldKeys: submission.userFieldKeys } : {}),
      ...(submission.textFieldKeys ? { transitionTextFieldKeys: submission.textFieldKeys } : {})
    }
    if (requirement.commentRequired && commentState.status === 'ready') {
      updates.transitionComment = commentState.body
    }
    const outcome = await onSubmit(updates)
    if (!outcome.ok) {
      setError(outcome.error)
      setFieldErrors(outcome.fieldErrors ?? {})
      setErrorMessages(outcome.errorMessages ?? [])
      const rejected = Object.keys(outcome.fieldErrors ?? {})
      if (rejected.length > 0) {
        setCarriedKeys((previous) => new Set([...previous, ...rejected]))
      }
    }
  }

  function renderField(field: JiraCreateField): React.JSX.Element {
    return (
      <div key={field.key} className="space-y-1">
        <Label>
          {field.name}
          {field.required ? <span className="ml-0.5 text-destructive">*</span> : null}
        </Label>
        <JiraSchemaFieldControl
          field={field}
          value={draftOf(field)}
          disabled={pending}
          fallbackToText
          displayValue={field.currentDisplayValue}
          userField={
            providerSettings && isJiraUserField(field)
              ? {
                  selectedUser: selectedUsers[field.key] ?? null,
                  onSelectUser: (user) =>
                    setSelectedUsers((previous) => ({ ...previous, [field.key]: user })),
                  providerSettings,
                  siteId
                }
              : undefined
          }
          onValueChange={(value) => setDrafts((previous) => ({ ...previous, [field.key]: value }))}
        />
        {fieldErrors[field.key] ? (
          <p role="alert" className="text-[11px] text-destructive">
            {fieldErrors[field.key]}
          </p>
        ) : null}
      </div>
    )
  }

  return (
    <form className="space-y-3" onSubmit={(event) => void submit(event)}>
      <p className="text-sm font-medium">{transition.name}</p>
      {requirement.fields.map(renderField)}
      {requirement.resolution ? (
        <div className="space-y-2">
          <Label htmlFor="jira-transition-resolution">{requirement.resolution.name}</Label>
          <Select value={resolutionDraft} onValueChange={setResolution} disabled={pending}>
            <SelectTrigger id="jira-transition-resolution" className="w-full" autoFocus>
              <SelectValue
                placeholder={translate('jira.transitions.chooseResolution', 'Choose a resolution')}
              />
            </SelectTrigger>
            <SelectContent>
              {(requirement.resolution.allowedValues ?? [])
                .filter((value) => transitionAllowedValueKey(value))
                .map((value) => (
                  <SelectItem
                    key={transitionAllowedValueKey(value)}
                    value={transitionAllowedValueKey(value)}
                  >
                    {transitionAllowedValueLabel(value)}
                  </SelectItem>
                ))}
            </SelectContent>
          </Select>
          {fieldErrors[requirement.resolution.key] ? (
            <p role="alert" className="text-[11px] text-destructive">
              {fieldErrors[requirement.resolution.key]}
            </p>
          ) : null}
        </div>
      ) : null}
      {requirement.commentRequired ? (
        <div className="space-y-2">
          <Label htmlFor="jira-transition-comment">
            {translate('jira.transitions.comment', 'Comment')}
          </Label>
          <Textarea
            id="jira-transition-comment"
            autoFocus={!requirement.resolution && requirement.fields.length === 0}
            value={comment}
            onChange={(event) => setComment(event.target.value)}
            required
            disabled={pending}
            rows={3}
          />
        </div>
      ) : null}
      {shownError ? (
        <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {/* Why the sentence keeps role=alert and the button does not: an alert's text
              is the message, and a control inside it would join that text. */}
          <p role="alert" className="min-w-0 flex-1">
            {shownError}
          </p>
          {issueUrl ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="-my-1 shrink-0"
              disabled={pending}
              onClick={() => void window.api.shell.openUrl(issueUrl)}
            >
              <ExternalLink className="size-3" />
              {translate('auto.components.JiraIssueWorkspace.69da9a208c', 'Open in Jira')}
            </Button>
          ) : null}
        </div>
      ) : null}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onBack} disabled={pending}>
          {translate('jira.transitions.back', 'Back')}
        </Button>
        <Button type="submit" size="sm" disabled={pending || !canSubmit}>
          {translate('jira.transitions.apply', 'Change status')}
        </Button>
      </div>
    </form>
  )
}
