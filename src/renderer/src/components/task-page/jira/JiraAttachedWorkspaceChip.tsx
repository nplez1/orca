import type { JSX } from 'react'
import { FolderOpen } from 'lucide-react'

/** The "workspace attached to this work item" chip, shared by the Jira issue list
 *  and board so the two surfaces can't drift. */
export function JiraAttachedWorkspaceChip({ label }: { label: string }): JSX.Element {
  return (
    <span className="inline-flex min-w-0 max-w-40 items-center gap-1 text-2xs text-muted-foreground">
      <FolderOpen className="size-3 shrink-0" />
      <span className="truncate">{label}</span>
    </span>
  )
}
