import type { DragEvent, JSX } from 'react'
import type { JiraIssue } from '../../../../../shared/jira/jira-types'
import type { TaskSourceContext } from '../../../../../shared/task-source-context'
import type { TaskPageJiraBoardColumn } from '../../task-page-jira-board-model'
import {
  findJiraIssueWorkspaceAttachmentInIndex,
  type JiraIssueWorkspaceAttachmentIndex
} from '@/lib/jira-issue-workspace-attachment'
import { getWorktreeAttachmentLabel } from '@/lib/worktree-attachment-label'
import { JiraAttachedWorkspaceChip } from './JiraAttachedWorkspaceChip'
import { getJiraStatusTone } from '../../task-page-jira-status-tone'
import { TaskPageJiraPriorityBadge } from '../../task-page-jira-priority-badge'
import { getJiraPrioritySurfaceTone } from '../../task-page-jira-priority-tone'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import { JiraIssueRowContextMenu } from '../../JiraIssueRowContextMenu'
import { buildJiraIssueRowWorkspaceAction } from '../../jira-issue-row-actions'

/** Story points, as the board's own `3sp` shorthand: Jira's own board shows the
 *  number alone, but a card carries no column heading to say what it is. */
function cardStoryPoints(issue: JiraIssue): string | null {
  return issue.storyPoints === undefined
    ? null
    : translate('auto.components.TaskPage.jiraCardStoryPoints', '{{value0}}sp', {
        value0: issue.storyPoints
      })
}

type TaskPageJiraBoardColumnsProps = {
  columns: TaskPageJiraBoardColumn[]
  otherIssues: JiraIssue[]
  selectedIssue: JiraIssue | null
  issueWorkspaceAttachmentIndex: JiraIssueWorkspaceAttachmentIndex
  /** Jira source the attached-workspace chip is scoped to; see TaskPageJiraIssueList. */
  sourceContext: TaskSourceContext | null
  draggingIssueKey: string | null
  updatingIssueKeys: readonly string[]
  onOpenIssue: (issue: JiraIssue) => void
  onDragStart: (issue: JiraIssue, event: DragEvent<HTMLDivElement>) => void
  onDragEnd: () => void
  onDragOver: (column: TaskPageJiraBoardColumn, event: DragEvent<HTMLElement>) => void
  onDrop: (column: TaskPageJiraBoardColumn, event: DragEvent<HTMLElement>) => void
  /** The "Other statuses" bucket spans several statuses, so it is its own drop
   *  rule rather than a lane: dropping there asks which status to move to. */
  onDragOverOther: (event: DragEvent<HTMLElement>) => void
  onDropOther: (event: DragEvent<HTMLElement>) => void
  dragOverColumnKey: string | null
  /** The card carries the same right-click menu as a task row, so it needs the same
   *  Start/Show workspace handler the row's hover cluster uses. */
  onOpenOrStartWorkspace?: (issue: JiraIssue) => void
  onStartWorkspace?: (issue: JiraIssue) => void
}

function isSelected(issue: JiraIssue, selectedIssue: JiraIssue | null): boolean {
  return Boolean(
    selectedIssue &&
    selectedIssue.key === issue.key &&
    (!selectedIssue.siteId || !issue.siteId || selectedIssue.siteId === issue.siteId)
  )
}

function JiraBoardCard({
  attachedWorkspaceLabel,
  issue,
  selected,
  dragging,
  updating,
  onOpenIssue,
  onOpenOrStartWorkspace,
  onStartWorkspace,
  onDragStart,
  onDragEnd
}: {
  attachedWorkspaceLabel: string | null
  issue: JiraIssue
  selected: boolean
  dragging: boolean
  updating: boolean
  onOpenIssue: (issue: JiraIssue) => void
  onOpenOrStartWorkspace?: (issue: JiraIssue) => void
  onStartWorkspace?: (issue: JiraIssue) => void
  onDragStart: (issue: JiraIssue, event: DragEvent<HTMLDivElement>) => void
  onDragEnd: () => void
}): JSX.Element {
  const prioritySurface = getJiraPrioritySurfaceTone(issue.priority)
  const storyPoints = cardStoryPoints(issue)
  const workspaceMenuItem = buildJiraIssueRowWorkspaceAction({
    issue,
    linked: attachedWorkspaceLabel !== null,
    onOpenOrStartWorkspace,
    onStartWorkspace
  })
  return (
    <JiraIssueRowContextMenu issue={issue} workspaceAction={workspaceMenuItem}>
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
          'cursor-pointer rounded-md border border-border/50 bg-background px-3 py-2 text-left transition focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
          prioritySurface.border,
          prioritySurface.base,
          prioritySurface.hover,
          !updating && 'cursor-grab active:cursor-grabbing',
          selected && prioritySurface.selected,
          dragging && 'opacity-50',
          updating && 'cursor-wait opacity-70'
        )}
      >
        <div className="flex min-w-0 items-start justify-between gap-2">
          <div className="min-w-0">
            <span className="block truncate font-mono text-2xs text-muted-foreground">
              {issue.key}
            </span>
            <h3 className="mt-1 line-clamp-2 text-[13px] font-medium leading-snug text-foreground">
              {issue.title}
            </h3>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            {issue.status.name ? (
              <span
                className={cn(
                  'max-w-24 shrink-0 truncate rounded-full border px-1.5 py-0.5 text-3xs font-medium',
                  getJiraStatusTone(issue.status.categoryKey)
                )}
              >
                {issue.status.name}
              </span>
            ) : null}
            {storyPoints ? (
              <span
                // Why the label as well as the shorthand: a screen reader reads "3sp"
                // as "3 s p", and the card's own name is built from its text.
                aria-label={translate(
                  'auto.components.TaskPage.jiraCardStoryPointsLabel',
                  '{{value0}} story points',
                  { value0: issue.storyPoints }
                )}
                title={translate(
                  'auto.components.TaskPage.jiraCardStoryPointsTitle',
                  'Story points'
                )}
                className="shrink-0 text-3xs tabular-nums text-muted-foreground"
              >
                {storyPoints}
              </span>
            ) : null}
          </div>
        </div>
        <div className="mt-2 flex min-w-0 items-center justify-between gap-2 text-2xs text-muted-foreground">
          <span className="truncate">
            {issue.assignee?.displayName ??
              translate('auto.components.TaskPage.42a9160321', 'Unassigned')}
          </span>
          <div className="flex min-w-0 items-center gap-2">
            {attachedWorkspaceLabel ? (
              <JiraAttachedWorkspaceChip label={attachedWorkspaceLabel} />
            ) : null}
            {issue.priority?.name ? (
              <TaskPageJiraPriorityBadge priority={issue.priority} className="shrink-0 text-3xs" />
            ) : null}
          </div>
        </div>
      </div>
    </JiraIssueRowContextMenu>
  )
}

export function TaskPageJiraBoardColumns({
  columns,
  otherIssues,
  selectedIssue,
  issueWorkspaceAttachmentIndex,
  sourceContext,
  draggingIssueKey,
  updatingIssueKeys,
  onOpenIssue,
  onDragStart,
  onDragEnd,
  onDragOver,
  onDrop,
  onDragOverOther,
  onDropOther,
  dragOverColumnKey,
  onOpenOrStartWorkspace,
  onStartWorkspace
}: TaskPageJiraBoardColumnsProps): JSX.Element {
  const renderColumn = (
    key: string,
    label: string,
    issues: JiraIssue[],
    column?: TaskPageJiraBoardColumn,
    isOtherBucket = false
  ): JSX.Element => (
    <section
      key={key}
      onDragOver={
        column ? (event) => onDragOver(column, event) : isOtherBucket ? onDragOverOther : undefined
      }
      onDrop={column ? (event) => onDrop(column, event) : isOtherBucket ? onDropOther : undefined}
      className={cn(
        'min-h-0 rounded-md border border-border/50 bg-muted/20 transition-[border-color,box-shadow]',
        (Boolean(column?.column.statusIds.length) || isOtherBucket) && dragOverColumnKey === key
          ? 'border-ring/70 ring-1 ring-ring/70'
          : undefined
      )}
    >
      <div className="flex h-9 items-center justify-between border-b border-border/50 px-3">
        <span className="truncate text-xs font-medium text-foreground">{label}</span>
        <span className="text-2xs text-muted-foreground">{issues.length}</span>
      </div>
      <div className="space-y-2 p-2">
        {issues.length === 0 ? (
          <p className="px-1 py-2 text-xs text-muted-foreground">
            {translate('auto.components.TaskPage.jiraBoardEmptyColumn', 'No issues')}
          </p>
        ) : null}
        {issues.map((issue) => {
          const attached = findJiraIssueWorkspaceAttachmentInIndex(
            issueWorkspaceAttachmentIndex,
            issue,
            sourceContext
          )
          return (
            <JiraBoardCard
              key={`${issue.siteId ?? 'site'}:${issue.key}`}
              attachedWorkspaceLabel={attached ? getWorktreeAttachmentLabel(attached) : null}
              issue={issue}
              selected={isSelected(issue, selectedIssue)}
              dragging={draggingIssueKey === issue.key}
              updating={updatingIssueKeys.includes(issue.key)}
              onOpenIssue={onOpenIssue}
              onOpenOrStartWorkspace={onOpenOrStartWorkspace}
              onStartWorkspace={onStartWorkspace}
              onDragStart={onDragStart}
              onDragEnd={onDragEnd}
            />
          )
        })}
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
      {otherIssues.length > 0
        ? renderColumn('other', 'Other statuses', otherIssues, undefined, true)
        : null}
    </div>
  )
}
