import type { DragEvent, JSX } from 'react'
import type { JiraIssue } from '../../../../../shared/jira-types'
import type { TaskPageJiraBoardColumn } from '../../task-page-jira-board-model'
import { getJiraStatusTone } from '../../task-page-jira-status-tone'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'

type TaskPageJiraBoardColumnsProps = {
  columns: TaskPageJiraBoardColumn[]
  otherIssues: JiraIssue[]
  selectedIssue: JiraIssue | null
  draggingIssueKey: string | null
  updatingIssueKey: string | null
  onOpenIssue: (issue: JiraIssue) => void
  onDragStart: (issue: JiraIssue, event: DragEvent<HTMLDivElement>) => void
  onDragEnd: () => void
  onDragOver: (column: TaskPageJiraBoardColumn, event: DragEvent<HTMLElement>) => void
  onDrop: (column: TaskPageJiraBoardColumn, event: DragEvent<HTMLElement>) => void
  dragOverColumnKey: string | null
}

function isSelected(issue: JiraIssue, selectedIssue: JiraIssue | null): boolean {
  return Boolean(
    selectedIssue &&
    selectedIssue.key === issue.key &&
    (!selectedIssue.siteId || !issue.siteId || selectedIssue.siteId === issue.siteId)
  )
}

function JiraBoardCard({
  issue,
  selected,
  dragging,
  updating,
  onOpenIssue,
  onDragStart,
  onDragEnd
}: {
  issue: JiraIssue
  selected: boolean
  dragging: boolean
  updating: boolean
  onOpenIssue: (issue: JiraIssue) => void
  onDragStart: (issue: JiraIssue, event: DragEvent<HTMLDivElement>) => void
  onDragEnd: () => void
}): JSX.Element {
  return (
    <div
      role="button"
      tabIndex={0}
      draggable={!updating}
      aria-current={selected ? 'true' : undefined}
      data-current={selected ? 'true' : undefined}
      aria-disabled={updating ? 'true' : undefined}
      aria-grabbed={dragging}
      onDragStart={(event) => onDragStart(issue, event)}
      onDragEnd={onDragEnd}
      onClick={() => onOpenIssue(issue)}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) {
          return
        }
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          onOpenIssue(issue)
        }
      }}
      className={cn(
        'cursor-pointer rounded-md border border-border/50 bg-background px-3 py-2 text-left transition hover:bg-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
        !updating && 'cursor-grab active:cursor-grabbing',
        selected && 'bg-accent',
        dragging && 'opacity-50',
        updating && 'cursor-wait opacity-70'
      )}
    >
      <div className="flex min-w-0 items-start justify-between gap-2">
        <div className="min-w-0">
          <span className="block truncate font-mono text-[11px] text-muted-foreground">
            {issue.key}
          </span>
          <h3 className="mt-1 line-clamp-2 text-[13px] font-medium leading-snug text-foreground">
            {issue.title}
          </h3>
        </div>
        {issue.status.name ? (
          <span
            className={cn(
              'max-w-24 shrink-0 truncate rounded-full border px-1.5 py-0.5 text-[10px] font-medium',
              getJiraStatusTone(issue.status.categoryKey)
            )}
          >
            {issue.status.name}
          </span>
        ) : null}
      </div>
      <div className="mt-2 flex min-w-0 items-center justify-between gap-2 text-[11px] text-muted-foreground">
        <span className="truncate">
          {issue.assignee?.displayName ??
            translate('auto.components.TaskPage.42a9160321', 'Unassigned')}
        </span>
        {issue.priority?.name ? <span className="shrink-0">{issue.priority.name}</span> : null}
      </div>
    </div>
  )
}

export function TaskPageJiraBoardColumns({
  columns,
  otherIssues,
  selectedIssue,
  draggingIssueKey,
  updatingIssueKey,
  onOpenIssue,
  onDragStart,
  onDragEnd,
  onDragOver,
  onDrop,
  dragOverColumnKey
}: TaskPageJiraBoardColumnsProps): JSX.Element {
  const renderColumn = (
    key: string,
    label: string,
    issues: JiraIssue[],
    column?: TaskPageJiraBoardColumn
  ): JSX.Element => (
    <section
      key={key}
      onDragOver={column ? (event) => onDragOver(column, event) : undefined}
      onDrop={column ? (event) => onDrop(column, event) : undefined}
      className={cn(
        'min-h-0 rounded-md border border-border/50 bg-muted/20 transition-[border-color,box-shadow]',
        column?.column.statusIds.length && dragOverColumnKey === key
          ? 'border-ring/70 ring-1 ring-ring/70'
          : undefined
      )}
    >
      <div className="flex h-9 items-center justify-between border-b border-border/50 px-3">
        <span className="truncate text-xs font-medium text-foreground">{label}</span>
        <span className="text-[11px] text-muted-foreground">{issues.length}</span>
      </div>
      <div className="space-y-2 p-2">
        {issues.length === 0 ? (
          <p className="px-1 py-2 text-xs text-muted-foreground">
            {translate('auto.components.TaskPage.jiraBoardEmptyColumn', 'No issues')}
          </p>
        ) : null}
        {issues.map((issue) => (
          <JiraBoardCard
            key={`${issue.siteId ?? 'site'}:${issue.key}`}
            issue={issue}
            selected={isSelected(issue, selectedIssue)}
            dragging={draggingIssueKey === issue.key}
            updating={updatingIssueKey === issue.key}
            onOpenIssue={onOpenIssue}
            onDragStart={onDragStart}
            onDragEnd={onDragEnd}
          />
        ))}
      </div>
    </section>
  )

  return (
    <div className="grid min-w-0 grid-flow-col auto-cols-[minmax(16rem,1fr)] gap-3 overflow-x-auto p-3 scrollbar-sleek">
      {columns.map(({ column, issues }, index) =>
        renderColumn(`${column.name}:${index}:${column.statusIds.join(',')}`, column.name, issues, {
          column,
          issues
        })
      )}
      {otherIssues.length > 0 ? renderColumn('other', 'Other statuses', otherIssues) : null}
    </div>
  )
}
