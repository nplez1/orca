import React from 'react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import type { JiraEditableField, JiraIssue } from '../../../../shared/jira/jira-types'
import {
  JiraStoryPointsEditorForm,
  jiraStoryPointsFieldLabel,
  jiraStoryPointsLabel,
  useJiraStoryPointsEditor,
  type JiraStoryPointsMutation
} from '@/components/jira-issue-story-points-control'
import { translate } from '@/i18n/i18n'
import { IssuePanePropertyRow } from './IssuePanePropertyRow'

/**
 * Story points for the narrow Issue pane, as a property row: the value in the
 * row, the editor in its popover. Mirrors the detail chrome's control and shares
 * its editor, so both surfaces write through one path.
 */
export function JiraStoryPointsRow({
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
      <IssuePanePropertyRow
        label={jiraStoryPointsFieldLabel()}
        withChevron={false}
        // Why disabled: the row is a button, and a value Jira will not let this user
        // write has no action to offer.
        disabled
        value={jiraStoryPointsLabel(editor.points)}
      />
    )
  }
  return (
    <Popover open={editor.open} onOpenChange={editor.setOpen}>
      <PopoverTrigger asChild>
        <IssuePanePropertyRow
          label={jiraStoryPointsFieldLabel()}
          pending={editor.pending}
          // Why not disabled for this field's own write: the popover's Esc restores
          // focus to this row, which a disabled button cannot take.
          disabled={editor.blocked && !editor.pending}
          value={
            editor.points === undefined ? (
              <span className="text-muted-foreground">
                {translate('auto.components.JiraIssueStoryPointsControl.none', 'No points')}
              </span>
            ) : (
              jiraStoryPointsLabel(editor.points)
            )
          }
        />
      </PopoverTrigger>
      <PopoverContent className="w-56" align="start">
        <div className="p-3">
          <JiraStoryPointsEditorForm editor={editor} />
        </div>
      </PopoverContent>
    </Popover>
  )
}
