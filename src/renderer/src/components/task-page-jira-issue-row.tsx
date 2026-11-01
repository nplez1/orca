import { openAppHttpLink } from '@/lib/app-http-link-open'
import { ExternalLink } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { getIntlLocale, translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import { JiraIssueRowContextMenu } from './JiraIssueRowContextMenu'
import { buildJiraIssueRowWorkspaceAction } from './jira-issue-row-actions'
import { JiraIssueWorkspaceSplitAction } from './JiraIssueWorkspaceSplitAction'
import type { Worktree } from '../../../shared/worktree/types'
import { jiraListColumnVisibility, type JiraListColumn } from './jira-list-columns'
import { JiraIssueCell, unassignedLabel } from './task-page-jira-issue-cells'
import type { JiraIssue } from '../../../shared/jira/jira-types'
import { JiraSprintCell, type TaskPageJiraSprintOptions } from './task-page-jira-sprint-cell'
import { getWorktreeAttachmentLabel } from '@/lib/worktree-attachment-label'
import { JiraAttachedWorkspaceChip } from '@/components/task-page/jira/JiraAttachedWorkspaceChip'
import { TaskPageJiraPriorityBadge } from '@/components/task-page-jira-priority-badge'
import { getJiraPrioritySurfaceTone } from '@/components/task-page-jira-priority-tone'

// A sprint cell needs one more track than the flat list, and the action cluster keeps
// its own track at every breakpoint (grid-auto-flow is a row, so a missing track wraps
// the row rather than widening it). Both strings are spelled out so the class strings
// stay static.
const ISSUE_ROW_GRID =
  'group/row grid min-h-12 cursor-pointer grid-cols-[minmax(0,1fr)_auto] items-center gap-3 px-3 py-2 text-left transition focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring md:grid-cols-[90px_minmax(0,1fr)_128px_92px_80px_64px] lg:grid-cols-[96px_minmax(0,1.25fr)_132px_120px_136px_96px_64px] xl:grid-cols-[104px_minmax(0,1.45fr)_144px_132px_160px_128px_72px]'
const SPRINT_ISSUE_ROW_GRID =
  'group/row grid min-h-12 cursor-pointer grid-cols-[minmax(0,1fr)_auto] items-center gap-3 px-3 py-2 text-left transition focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring md:grid-cols-[90px_minmax(0,1fr)_128px_92px_96px_80px_64px] lg:grid-cols-[96px_minmax(0,1.25fr)_132px_120px_136px_112px_96px_64px] xl:grid-cols-[104px_minmax(0,1.45fr)_144px_132px_160px_120px_128px_72px]'
const COLUMN_ROW_GRID =
  'group/row grid min-h-12 cursor-pointer grid-cols-[minmax(0,1fr)_auto] items-center gap-3 px-3 py-2 text-left transition focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring @3xl:grid-cols-(--jira-cols-md) @3xl:min-w-(--jira-min-md) @5xl:grid-cols-(--jira-cols-lg) @5xl:min-w-(--jira-min-lg) @7xl:grid-cols-(--jira-cols-xl) @7xl:min-w-(--jira-min-xl)'

export type TaskPageJiraIssueRowProps = {
  getIssueWorkspaces?: (issue: JiraIssue) => readonly Worktree[]
  onOpenWorkspace?: (workspace: Worktree) => void
  columns?: readonly JiraListColumn[]
  formatUpdatedAt: (updatedAt: string) => string
  getStatusTone: (categoryKey: string) => string
  issue: JiraIssue
  onOpenIssue: (issue: JiraIssue) => void
  onStartWorkspace?: (issue: JiraIssue) => void
  onOpenOrStartWorkspace?: (issue: JiraIssue) => void
  attachedWorkspace: Worktree | null
  sprintOptions?: TaskPageJiraSprintOptions
  selected: boolean
  showSiteContext: boolean
}

export function JiraIssueRow({
  getIssueWorkspaces,
  onOpenWorkspace,
  columns,
  formatUpdatedAt,
  getStatusTone,
  issue,
  onOpenIssue,
  onStartWorkspace,
  onOpenOrStartWorkspace,
  attachedWorkspace,
  sprintOptions,
  selected,
  showSiteContext
}: TaskPageJiraIssueRowProps): React.JSX.Element {
  const linkedWorkspaces = getIssueWorkspaces?.(issue) ?? []
  // The chip and the button must read one rule: fall back to the index-derived
  // attachment so an index-only caller still flips the action.
  const workspaces =
    linkedWorkspaces.length > 0 ? linkedWorkspaces : attachedWorkspace ? [attachedWorkspace] : []
  const labels = issue.labels.slice(0, 3)
  const attachedWorkspaceLabel = attachedWorkspace
    ? getWorktreeAttachmentLabel(attachedWorkspace)
    : null
  const contextLabel =
    showSiteContext && issue.siteName
      ? `${issue.siteName} / ${issue.project.key}`
      : issue.project.key
  const prioritySurface = getJiraPrioritySurfaceTone(issue.priority)
  const gridClass = columns
    ? COLUMN_ROW_GRID
    : sprintOptions
      ? SPRINT_ISSUE_ROW_GRID
      : ISSUE_ROW_GRID
  const workspaceMenuItem = buildJiraIssueRowWorkspaceAction({
    issue,
    linked: workspaces.length > 0,
    onOpenOrStartWorkspace,
    onStartWorkspace
  })

  return (
    // Why: the row contains action buttons, so a native button wrapper would
    // create invalid nested buttons; role + keyboard handling preserves access.
    <JiraIssueRowContextMenu issue={issue} workspaceAction={workspaceMenuItem}>
      <div
        role="button"
        tabIndex={0}
        aria-current={selected ? 'true' : undefined}
        data-current={selected ? 'true' : undefined}
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
          gridClass,
          prioritySurface.base,
          prioritySurface.hover,
          selected && prioritySurface.selected
        )}
      >
        <span
          className={cn(
            'block truncate font-mono text-xs text-muted-foreground',
            columns ? '@max-3xl:!hidden' : 'max-md:!hidden'
          )}
        >
          {issue.key}
        </span>

        <div className="min-w-0">
          {/* Why the title line and not a metadata row: those rows are breakpoint
              exclusive, so between md and lg neither renders and an attached row would
              show nothing until hover. */}
          <div className="flex min-w-0 items-center gap-2">
            <span
              className={cn(
                'shrink-0 font-mono text-2xs text-muted-foreground',
                columns ? '@3xl:hidden' : 'md:hidden'
              )}
            >
              {issue.key}
            </span>
            <h3 className="min-w-0 truncate text-[13px] font-medium text-foreground">
              {issue.title}
            </h3>
            {attachedWorkspaceLabel ? (
              <JiraAttachedWorkspaceChip label={attachedWorkspaceLabel} />
            ) : null}
          </div>
          <div
            className={cn(
              'mt-1 flex min-w-0 items-center gap-1.5',
              columns ? '@3xl:!hidden' : 'md:!hidden'
            )}
          >
            <span
              className={cn(
                'inline-flex min-w-0 items-center rounded-full border px-1.5 py-0.5 text-2xs font-medium',
                getStatusTone(issue.status.categoryKey)
              )}
            >
              <span className="truncate">{issue.status.name}</span>
            </span>
            <TaskPageJiraPriorityBadge priority={issue.priority} className="shrink-0" />
            <span className="min-w-0 truncate text-2xs text-muted-foreground">
              {issue.assignee?.displayName ?? unassignedLabel()}
            </span>
          </div>
          <div
            className={cn(
              'mt-1 flex min-w-0 items-center gap-1',
              columns ? '@max-5xl:!hidden' : 'max-lg:!hidden'
            )}
          >
            <span
              className={cn(
                'max-w-[160px] truncate text-3xs text-muted-foreground',
                columns ? '@7xl:!hidden' : 'xl:!hidden'
              )}
            >
              {contextLabel}
            </span>
            {labels.map((label) => (
              <span
                key={label}
                className="max-w-[140px] truncate rounded-full border border-border/50 bg-muted/35 px-1.5 py-0.5 text-3xs text-muted-foreground"
              >
                {label}
              </span>
            ))}
            {issue.labels.length > labels.length ? (
              <span className="text-3xs text-muted-foreground">
                +{issue.labels.length - labels.length}
              </span>
            ) : null}
          </div>
        </div>

        {columns ? (
          columns
            .filter((column) => !column.locked)
            .map((column) => (
              <div
                key={column.id}
                className={cn('min-w-0 @max-3xl:!hidden', jiraListColumnVisibility(column.id))}
              >
                <JiraIssueCell
                  column={column.id}
                  issue={issue}
                  formatUpdatedAt={formatUpdatedAt}
                  getStatusTone={getStatusTone}
                />
              </div>
            ))
        ) : (
          <>
            <div className="flex min-w-0 max-md:!hidden">
              <span
                className={cn(
                  'inline-flex max-w-full items-center rounded-full border px-2 py-0.5 text-2xs font-medium',
                  getStatusTone(issue.status.categoryKey)
                )}
              >
                <span className="truncate">{issue.status.name}</span>
              </span>
            </div>

            <TaskPageJiraPriorityBadge
              priority={issue.priority}
              className="max-md:!hidden justify-self-start"
            />

            {sprintOptions ? <JiraSprintCell issue={issue} options={sprintOptions} /> : null}

            <Tooltip>
              <TooltipTrigger asChild>
                <div className="block min-w-0 truncate text-xs text-muted-foreground max-md:!hidden">
                  {formatUpdatedAt(issue.updatedAt)}
                </div>
              </TooltipTrigger>
              <TooltipContent side="bottom" sideOffset={6}>
                {new Date(issue.updatedAt).toLocaleString(getIntlLocale())}
              </TooltipContent>
            </Tooltip>

            <div className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground max-lg:!hidden">
              {issue.assignee?.avatarUrl ? (
                <img
                  src={issue.assignee.avatarUrl}
                  alt={issue.assignee.displayName}
                  className="size-5 shrink-0 rounded-full"
                />
              ) : (
                <span className="flex size-5 shrink-0 items-center justify-center rounded-full border border-border/50 bg-muted/40 text-3xs">
                  {issue.assignee?.displayName?.slice(0, 1) ?? '-'}
                </span>
              )}
              <span className="truncate">{issue.assignee?.displayName ?? unassignedLabel()}</span>
            </div>
          </>
        )}

        <div className="flex shrink-0 items-center justify-end gap-1">
          <JiraIssueWorkspaceSplitAction
            issue={issue}
            workspaces={workspaces}
            onOpenOrStartWorkspace={onOpenOrStartWorkspace}
            onOpenWorkspace={onOpenWorkspace}
            onStartWorkspace={onStartWorkspace}
          />
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-xs"
                data-link-url={issue.url}
                onClick={(event) => {
                  event.stopPropagation()
                  openAppHttpLink(issue.url, { event })
                }}
                aria-label={translate(
                  'auto.components.TaskPage.4ac8ff2275',
                  'Open {{value0}} in Jira',
                  { value0: issue.key }
                )}
              >
                <ExternalLink className="size-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom" sideOffset={6}>
              {translate('auto.components.TaskPage.eee68073b2', 'Open in Jira')}
            </TooltipContent>
          </Tooltip>
        </div>
      </div>
    </JiraIssueRowContextMenu>
  )
}
