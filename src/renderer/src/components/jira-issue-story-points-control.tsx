import { useState } from 'react'
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

/** The story-points field Jira lets this user write on this issue, when it has one. */
export function findJiraStoryPointsField(
  fields: readonly JiraEditableField[]
): JiraEditableField | undefined {
  return fields.find((entry) => isJiraStoryPointsField(entry.field))
}

export function jiraStoryPointsLabel(points: number | undefined): string {
  return points === undefined
    ? translate('auto.components.JiraIssueStoryPointsControl.none', 'No points')
    : String(points)
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
  pending: boolean
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
  const pointsField = findJiraStoryPointsField(editFields)
  const points = displayed.storyPoints
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState('')
  const nextValue = draft.trim() === '' ? null : Number(draft)
  // Jira takes a number or an explicit clear; anything else would be rejected.
  const invalid = nextValue !== null && !Number.isFinite(nextValue)
  const changed = nextValue !== (points ?? null)

  const openEditor = (nextOpen: boolean): void => {
    setOpen(nextOpen)
    // Why on open rather than in an effect: the draft is a snapshot of the value
    // this form is editing, and an effect would also overwrite a reopen's draft.
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
  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(event) => {
        event.preventDefault()
        void editor.submit()
      }}
    >
      <Input
        type="number"
        inputMode="decimal"
        step="any"
        autoFocus
        aria-label={jiraStoryPointsFieldLabel()}
        value={editor.draft}
        disabled={editor.pending}
        aria-invalid={editor.invalid || undefined}
        onChange={(event) => editor.setDraft(event.target.value)}
      />
      {editor.invalid ? (
        <p className="text-[11px] text-destructive">
          {translate('auto.components.JiraIssueStoryPointsControl.invalid', 'Enter a number.')}
        </p>
      ) : editor.points === undefined ? null : (
        <p className="text-[11px] text-muted-foreground">
          {translate(
            'auto.components.JiraIssueStoryPointsControl.clearHint',
            'An empty value clears the field.'
          )}
        </p>
      )}
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
          disabled={editor.pending || editor.invalid || !editor.changed}
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
        {jiraStoryPointsLabel(editor.points)}
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
          aria-label={pointsTitle(editor.points)}
          className={TRIGGER_CLASS}
        >
          {jiraStoryPointsLabel(editor.points)}
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
