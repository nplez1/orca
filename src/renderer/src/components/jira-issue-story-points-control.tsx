import { useId, useState } from 'react'
import { LoaderCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { translate } from '@/i18n/i18n'
import { isJiraStoryPointsField } from '../../../shared/jira-field-rendering'
import type {
  JiraEditableField,
  JiraIssue,
  JiraIssueUpdate,
  JiraMutationResult
} from '../../../shared/jira-types'

const TRIGGER_CLASS =
  'flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] text-muted-foreground transition hover:bg-muted/40 disabled:opacity-50'

export type JiraStoryPointsMutation = (
  field: string,
  updates: JiraIssueUpdate,
  optimistic?: Partial<JiraIssue>,
  options?: { reportsInline?: boolean }
) => Promise<JiraMutationResult>

/** Whether an editable field is the one holding the value the view shows. */
function holdsPoints(entry: JiraEditableField, points: number | undefined): boolean {
  return points !== undefined && entry.value.trim() !== '' && Number(entry.value) === points
}

/**
 * The story-points field Jira lets this user write on this issue, when there is
 * one to offer. The issue names the field its value came from, so that is the
 * field to write; a host that predates the name leaves the value to match, and
 * an issue with no points yet may be written through whichever field Jira
 * offers.
 */
export function findJiraStoryPointsField(
  fields: readonly JiraEditableField[],
  issue: Pick<JiraIssue, 'storyPoints' | 'storyPointsFieldId'>
): JiraEditableField | undefined {
  const candidates = fields.filter((entry) => isJiraStoryPointsField(entry.field))
  if (issue.storyPointsFieldId !== undefined) {
    // Why no fallback: writing another points field would leave the value on screen
    // unchanged, so an unwritable source field means there is nothing to offer.
    return candidates.find((entry) => entry.field.key === issue.storyPointsFieldId)
  }
  return candidates.find((entry) => holdsPoints(entry, issue.storyPoints)) ?? candidates[0]
}

export function jiraStoryPointsLabel(points: number | undefined): string {
  return points === undefined
    ? translate('auto.components.JiraIssueStoryPointsControl.none', 'No points')
    : String(points)
}

/** The detail bar has no column heading above it and no label beside it, so the
 *  chip names the field; the Issue pane's row is labelled already. A label rather
 *  than a unit suffix keeps one point from reading as "1 pts" in any language. */
export function jiraStoryPointsChipLabel(points: number | undefined): string {
  return points === undefined
    ? jiraStoryPointsLabel(points)
    : translate('auto.components.JiraIssueStoryPointsControl.value', 'Points: {{value0}}', {
        value0: points
      })
}

export function jiraStoryPointsFieldLabel(): string {
  return translate('auto.components.JiraIssueStoryPointsControl.label', 'Story points')
}

function pointsTitle(points: number | undefined): string {
  return points === undefined
    ? jiraStoryPointsFieldLabel()
    : translate('auto.components.JiraIssueStoryPointsControl.current', 'Story points: {{value0}}', {
        value0: points
      })
}

export type JiraStoryPointsEditor = {
  /** Absent when Jira reports no story-points field this user may write. */
  pointsField: JiraEditableField | undefined
  points: number | undefined
  open: boolean
  setOpen: (open: boolean) => void
  draft: string
  setDraft: (value: string) => void
  invalid: boolean
  changed: boolean
  /** This field's own write is in flight. */
  pending: boolean
  /** Any write on the issue is in flight, so a save here would be refused. */
  blocked: boolean
  submit: () => Promise<void>
}

/**
 * Sets or clears one issue's story points through the custom-field update path
 * the "Edit fields" form uses, with the field's own id taken from Jira's
 * editmeta. Shared by the detail chrome and the right-sidebar pane's property
 * row, which differ only in how they present the trigger.
 */
export function useJiraStoryPointsEditor({
  displayed,
  editFields,
  pendingField,
  mutateIssue
}: {
  displayed: JiraIssue
  editFields: JiraEditableField[]
  pendingField: string | null
  mutateIssue: JiraStoryPointsMutation
}): JiraStoryPointsEditor {
  const pointsField = findJiraStoryPointsField(editFields, displayed)
  const points = displayed.storyPoints
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState('')
  const trimmedDraft = draft.trim()
  // Why the input is a text box parsed here: a number input reports '' for text it
  // cannot parse, so "5e" or "1." would read as an empty draft and clear the field.
  const nextValue = trimmedDraft === '' ? null : Number(trimmedDraft)
  const invalid = nextValue !== null && !Number.isFinite(nextValue)
  const changed = nextValue !== (points ?? null)

  const openEditor = (nextOpen: boolean): void => {
    setOpen(nextOpen)
    // Why on open rather than in an effect: a publish while the form is open — a
    // refresh, or another field's optimistic patch — must not replace the draft
    // the user is still typing into.
    if (nextOpen) {
      setDraft(points === undefined ? '' : String(points))
    }
  }

  return {
    pointsField,
    points,
    open,
    setOpen: openEditor,
    draft,
    setDraft,
    invalid,
    changed,
    pending: pendingField === 'storyPoints',
    blocked: pendingField !== null,
    submit: async (): Promise<void> => {
      if (!pointsField || invalid || !changed) {
        return
      }
      // Why null rather than an omitted key: the update path only writes the fields
      // it is given, so an omitted key would leave the old points in place.
      const result = await mutateIssue(
        'storyPoints',
        { customFields: { [pointsField.field.key]: nextValue } },
        { storyPoints: nextValue ?? undefined }
      )
      if (result.ok) {
        setOpen(false)
      }
    }
  }
}

/** The editor's own body: the value, its clear affordance, and save/cancel. */
export function JiraStoryPointsEditorForm({
  editor
}: {
  editor: JiraStoryPointsEditor
}): React.JSX.Element {
  const messageId = useId()
  // Why conditional: nothing to describe means no described-by, so the input is not
  // pointed at an empty message.
  const message = editor.invalid
    ? translate('auto.components.JiraIssueStoryPointsControl.invalid', 'Enter a number.')
    : editor.points === undefined
      ? null
      : translate(
          'auto.components.JiraIssueStoryPointsControl.clearHint',
          'An empty value clears the field.'
        )
  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(event) => {
        event.preventDefault()
        void editor.submit()
      }}
    >
      <Input
        type="text"
        inputMode="decimal"
        autoFocus
        aria-label={jiraStoryPointsFieldLabel()}
        aria-describedby={message ? messageId : undefined}
        value={editor.draft}
        // Why read-only rather than disabled: a disabled field loses focus part-way
        // through a save, so the user would have to click back in to fix a refusal.
        readOnly={editor.blocked}
        aria-invalid={editor.invalid || undefined}
        onChange={(event) => editor.setDraft(event.target.value)}
      />
      {message ? (
        <p
          id={messageId}
          className={
            editor.invalid ? 'text-[11px] text-destructive' : 'text-[11px] text-muted-foreground'
          }
        >
          {message}
        </p>
      ) : null}
      <div className="flex justify-end gap-1.5">
        <Button
          type="button"
          variant="ghost"
          size="xs"
          disabled={editor.pending}
          onClick={() => editor.setOpen(false)}
        >
          {translate('auto.components.JiraIssueStoryPointsControl.cancel', 'Cancel')}
        </Button>
        <Button
          type="submit"
          size="xs"
          disabled={editor.blocked || editor.invalid || !editor.changed}
        >
          {translate('auto.components.JiraIssueStoryPointsControl.save', 'Save')}
        </Button>
      </div>
    </form>
  )
}

/**
 * Story points in the issue detail's metadata bar: the value the issue holds,
 * and — where Jira will let this user write it — a popover that sets or clears
 * it. An issue whose points are not writable still shows them.
 */
export function JiraIssueStoryPointsControl({
  displayed,
  editFields,
  pendingField,
  mutateIssue
}: {
  displayed: JiraIssue
  editFields: JiraEditableField[]
  pendingField: string | null
  mutateIssue: JiraStoryPointsMutation
}): React.JSX.Element | null {
  const editor = useJiraStoryPointsEditor({ displayed, editFields, pendingField, mutateIssue })
  if (!editor.pointsField) {
    return editor.points === undefined ? null : (
      <span
        className="px-1.5 py-0.5 text-[11px] text-muted-foreground"
        title={pointsTitle(editor.points)}
      >
        {jiraStoryPointsChipLabel(editor.points)}
      </span>
    )
  }
  return (
    <Popover open={editor.open} onOpenChange={editor.setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          disabled={pendingField !== null}
          title={pointsTitle(editor.points)}
          className={TRIGGER_CLASS}
        >
          {jiraStoryPointsChipLabel(editor.points)}
          {editor.pending ? <LoaderCircle className="size-3 shrink-0 animate-spin" /> : null}
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-56">
        <div className="p-3">
          <JiraStoryPointsEditorForm editor={editor} />
        </div>
      </PopoverContent>
    </Popover>
  )
}
