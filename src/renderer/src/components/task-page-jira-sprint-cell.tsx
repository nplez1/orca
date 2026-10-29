import React from 'react'
import { LoaderCircle } from 'lucide-react'

import { JiraSprintPicker, sprintTriggerLabel } from '@/components/jira-sprint-picker'
import { cn } from '@/lib/utils'
import type { JiraIssue, JiraSprint } from '../../../shared/jira/jira-types'

/** Board sprints a backlog row can be moved into. */
export type TaskPageJiraSprintOptions = {
  sprints: JiraSprint[]
  assigningIssueKey: string | null
  onAssignSprint: (issue: JiraIssue, sprintId: string) => void
}

/** The backlog row's sprint cell.
 *
 *  The row is already in the board's backlog, so the picker lists only open
 *  sprints: there is no "move to backlog" entry to offer back. */
export function JiraSprintCell({
  issue,
  options
}: {
  issue: JiraIssue
  options: TaskPageJiraSprintOptions
}): React.JSX.Element {
  const assigning = options.assigningIssueKey === issue.key
  return (
    <div className="flex min-w-0 max-md:!hidden">
      <JiraSprintPicker
        sprint={null}
        sprints={options.sprints}
        includeBacklog={false}
        onSelect={(sprintId) => {
          if (sprintId) {
            options.onAssignSprint(issue, sprintId)
          }
        }}
      >
        <button
          type="button"
          disabled={assigning}
          // Why: the cell sits inside the clickable issue row, so a pick must not also
          // open the issue.
          onClick={(event) => event.stopPropagation()}
          className={cn(
            'inline-flex max-w-full items-center gap-1 rounded-full border border-dashed border-border/60 px-2 py-0.5 text-2xs text-muted-foreground transition hover:border-border hover:text-foreground disabled:opacity-50',
            'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring'
          )}
        >
          {assigning ? <LoaderCircle className="size-3 shrink-0 animate-spin" /> : null}
          <span className="truncate">{sprintTriggerLabel(null)}</span>
        </button>
      </JiraSprintPicker>
    </div>
  )
}
