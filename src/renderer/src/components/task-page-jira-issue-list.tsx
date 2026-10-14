import React, { useMemo, useState } from 'react'
import { ArrowRight, ChevronDown, ChevronRight, ExternalLink, FolderOpen } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import type { JiraIssue, JiraProjectStatusOrder } from '../../../shared/jira-types'
import { groupJiraIssuesByStatus } from '@/components/task-page-jira-grouping'
import {
  JiraSprintCell,
  type TaskPageJiraSprintOptions
} from '@/components/task-page-jira-sprint-cell'
import type { Worktree } from '../../../shared/worktree/types'
import {
  findJiraIssueWorkspaceAttachmentInIndex,
  type JiraIssueWorkspaceAttachmentIndex
} from '@/lib/jira-issue-workspace-attachment'
import { getWorktreeAttachmentLabel } from '@/lib/worktree-attachment-label'
import { JiraAttachedWorkspaceChip } from '@/components/task-page/jira/JiraAttachedWorkspaceChip'
import { TaskPageJiraPriorityBadge } from '@/components/task-page-jira-priority-badge'
import { getJiraPrioritySurfaceTone } from '@/components/task-page-jira-priority-tone'

type TaskPageJiraIssueListProps = {
  formatUpdatedAt: (updatedAt: string) => string
  getStatusTone: (categoryKey: string) => string
  issues: JiraIssue[]
  issueWorkspaceAttachmentIndex: JiraIssueWorkspaceAttachmentIndex
  onOpenIssue: (issue: JiraIssue) => void
  onOpenOrStartWorkspace: (issue: JiraIssue) => void
  selectedIssue: JiraIssue | null
  showSiteContext: boolean
  statusDirection?: 'asc' | 'desc'
  statusOrder: JiraProjectStatusOrder | null
  groupByStatus?: boolean
  /** Renders a sprint cell. Only the board's backlog passes it: a backlog issue is
   *  in no sprint by definition, so the cell offers the board's open sprints. */
  sprintOptions?: TaskPageJiraSprintOptions
}

// A sprint cell needs one more track than the flat list, and the action cluster keeps
// its own track at every breakpoint (grid-auto-flow is a row, so a missing track wraps
// the row rather than widening it). Both strings are spelled out so the class strings
// stay static.
const ISSUE_ROW_GRID =
  'group/row grid min-h-12 cursor-pointer grid-cols-[minmax(0,1fr)_auto] items-center gap-3 px-3 py-2 text-left transition focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring md:grid-cols-[90px_minmax(0,1fr)_128px_92px_80px_64px] lg:grid-cols-[96px_minmax(0,1.25fr)_132px_120px_136px_96px_64px] xl:grid-cols-[104px_minmax(0,1.45fr)_144px_132px_160px_128px_72px]'
const SPRINT_ISSUE_ROW_GRID =
  'group/row grid min-h-12 cursor-pointer grid-cols-[minmax(0,1fr)_auto] items-center gap-3 px-3 py-2 text-left transition focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring md:grid-cols-[90px_minmax(0,1fr)_128px_92px_96px_80px_64px] lg:grid-cols-[96px_minmax(0,1.25fr)_132px_120px_136px_112px_96px_64px] xl:grid-cols-[104px_minmax(0,1.45fr)_144px_132px_160px_120px_128px_72px]'

function isSelectedIssue(issue: JiraIssue, selectedIssue: JiraIssue | null): boolean {
  if (!selectedIssue || issue.key !== selectedIssue.key) {
    return false
  }
  return !selectedIssue.siteId || !issue.siteId || selectedIssue.siteId === issue.siteId
}

function JiraIssueRow({
  attachedWorkspace,
  formatUpdatedAt,
  getStatusTone,
  issue,
  onOpenIssue,
  onOpenOrStartWorkspace,
  selected,
  showSiteContext,
  sprintOptions
}: {
  attachedWorkspace: Worktree | null
  formatUpdatedAt: (updatedAt: string) => string
  getStatusTone: (categoryKey: string) => string
  issue: JiraIssue
  onOpenIssue: (issue: JiraIssue) => void
  onOpenOrStartWorkspace: (issue: JiraIssue) => void
  selected: boolean
  showSiteContext: boolean
  sprintOptions?: TaskPageJiraSprintOptions
}): React.JSX.Element {
  const labels = issue.labels.slice(0, 3)
  const attachedWorkspaceLabel = attachedWorkspace
    ? getWorktreeAttachmentLabel(attachedWorkspace)
    : null
  const contextLabel =
    showSiteContext && issue.siteName
      ? `${issue.siteName} / ${issue.project.key}`
      : issue.project.key
  const prioritySurface = getJiraPrioritySurfaceTone(issue.priority)

  return (
    // Why: the row contains action buttons, so a native button wrapper would
    // create invalid nested buttons; role + keyboard handling preserves access.
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
        sprintOptions ? SPRINT_ISSUE_ROW_GRID : ISSUE_ROW_GRID,
        prioritySurface.base,
        prioritySurface.hover,
        selected && prioritySurface.selected
      )}
    >
      <span className="block truncate font-mono text-[12px] text-muted-foreground max-md:!hidden">
        {issue.key}
      </span>

      <div className="min-w-0">
        {/* Why the title line and not a metadata row: those rows are breakpoint
            exclusive, so between md and lg neither renders and an attached row would
            show nothing until hover. */}
        <div className="flex min-w-0 items-center gap-2">
          <span className="shrink-0 font-mono text-[11px] text-muted-foreground md:hidden">
            {issue.key}
          </span>
          <h3 className="min-w-0 truncate text-[13px] font-medium text-foreground">
            {issue.title}
          </h3>
          {attachedWorkspaceLabel ? (
            <JiraAttachedWorkspaceChip label={attachedWorkspaceLabel} />
          ) : null}
        </div>
        <div className="mt-1 flex min-w-0 items-center gap-1.5 md:!hidden">
          <span
            className={cn(
              'inline-flex min-w-0 items-center rounded-full border px-1.5 py-0.5 text-[11px] font-medium',
              getStatusTone(issue.status.categoryKey)
            )}
          >
            <span className="truncate">{issue.status.name}</span>
          </span>
          <TaskPageJiraPriorityBadge priority={issue.priority} className="shrink-0" />
          <span className="min-w-0 truncate text-[11px] text-muted-foreground">
            {issue.assignee?.displayName ??
              translate('auto.components.TaskPage.42a9160321', 'Unassigned')}
          </span>
        </div>
        <div className="mt-1 flex min-w-0 items-center gap-1 max-lg:!hidden">
          <span className="max-w-[160px] truncate text-[10px] text-muted-foreground xl:!hidden">
            {contextLabel}
          </span>
          {labels.map((label) => (
            <span
              key={label}
              className="max-w-[140px] truncate rounded-full border border-border/50 bg-muted/35 px-1.5 py-0.5 text-[10px] text-muted-foreground"
            >
              {label}
            </span>
          ))}
          {issue.labels.length > labels.length ? (
            <span className="text-[10px] text-muted-foreground">
              +{issue.labels.length - labels.length}
            </span>
          ) : null}
        </div>
      </div>

      <div className="flex min-w-0 max-md:!hidden">
        <span
          className={cn(
            'inline-flex max-w-full items-center rounded-full border px-2 py-0.5 text-[11px] font-medium',
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

      <div className="flex min-w-0 items-center gap-2 text-[12px] text-muted-foreground max-lg:!hidden">
        {issue.assignee?.avatarUrl ? (
          <img
            src={issue.assignee.avatarUrl}
            alt={issue.assignee.displayName}
            className="size-5 shrink-0 rounded-full"
          />
        ) : (
          <span className="flex size-5 shrink-0 items-center justify-center rounded-full border border-border/50 bg-muted/40 text-[10px]">
            {issue.assignee?.displayName?.slice(0, 1) ?? '-'}
          </span>
        )}
        <span className="truncate">
          {issue.assignee?.displayName ??
            translate('auto.components.TaskPage.42a9160321', 'Unassigned')}
        </span>
      </div>

      {sprintOptions ? <JiraSprintCell issue={issue} options={sprintOptions} /> : null}

      <Tooltip>
        <TooltipTrigger asChild>
          <div className="block min-w-0 truncate text-[12px] text-muted-foreground max-md:!hidden">
            {formatUpdatedAt(issue.updatedAt)}
          </div>
        </TooltipTrigger>
        <TooltipContent side="bottom" sideOffset={6}>
          {new Date(issue.updatedAt).toLocaleString()}
        </TooltipContent>
      </Tooltip>

      <div className="flex shrink-0 items-center justify-end gap-1 md:opacity-0 md:transition-opacity md:group-hover/row:opacity-100 md:group-focus-within/row:opacity-100">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              // Why: solid primary when a workspace is already linked so Show reads stronger than Start.
              variant={attachedWorkspace ? 'default' : 'ghost'}
              size="icon-xs"
              data-contextual-tour-target="tasks-start-workspace"
              onClick={(event) => {
                event.stopPropagation()
                onOpenOrStartWorkspace(issue)
              }}
              aria-label={
                attachedWorkspace
                  ? translate(
                      'auto.components.TaskPage.jiraOpenAttachedWorkspace',
                      'Open workspace attached to {{value0}}',
                      { value0: issue.key }
                    )
                  : translate(
                      'auto.components.TaskPage.ff90d0abc7',
                      'Start workspace from {{value0}}',
                      { value0: issue.key }
                    )
              }
            >
              {attachedWorkspace ? (
                <FolderOpen className="size-3.5" />
              ) : (
                <ArrowRight className="size-3.5" />
              )}
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom" sideOffset={6}>
            {attachedWorkspace
              ? translate('auto.components.TaskPage.jiraShowWorkspace', 'Show workspace')
              : translate('auto.components.TaskPage.9497f2787c', 'Start workspace')}
          </TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-xs"
              onClick={(event) => {
                event.stopPropagation()
                window.api.shell.openUrl(issue.url)
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
  )
}

export function TaskPageJiraIssueList({
  formatUpdatedAt,
  getStatusTone,
  issueWorkspaceAttachmentIndex,
  issues,
  onOpenIssue,
  onOpenOrStartWorkspace,
  selectedIssue,
  showSiteContext,
  sprintOptions,
  statusDirection = 'asc',
  statusOrder,
  groupByStatus = true
}: TaskPageJiraIssueListProps): React.JSX.Element {
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(() => new Set())
  const sections = useMemo(
    () => (groupByStatus ? groupJiraIssuesByStatus(issues, statusOrder, statusDirection) : []),
    [groupByStatus, issues, statusDirection, statusOrder]
  )
  const rowProps = (issue: JiraIssue): React.ComponentProps<typeof JiraIssueRow> => ({
    attachedWorkspace: findJiraIssueWorkspaceAttachmentInIndex(
      issueWorkspaceAttachmentIndex,
      issue
    ),
    formatUpdatedAt,
    getStatusTone,
    issue,
    onOpenIssue,
    onOpenOrStartWorkspace,
    selected: isSelectedIssue(issue, selectedIssue),
    showSiteContext,
    sprintOptions
  })
  if (!groupByStatus) {
    return (
      <div className="divide-y divide-border/50">
        {issues.map((issue) => (
          <JiraIssueRow
            key={`${issue.siteId ?? 'site'}:${issue.id || issue.key}`}
            {...rowProps(issue)}
          />
        ))}
      </div>
    )
  }

  return (
    <div className="divide-y divide-border/50">
      {sections.map((section) => {
        const open = !collapsedGroups.has(section.key)
        return (
          <Collapsible
            key={section.key}
            open={open}
            onOpenChange={(nextOpen) => {
              setCollapsedGroups((current) => {
                const next = new Set(current)
                if (nextOpen) {
                  next.delete(section.key)
                } else {
                  next.add(section.key)
                }
                return next
              })
            }}
          >
            <CollapsibleTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                className="h-9 w-full justify-start rounded-none bg-muted/35 px-3 text-left font-normal transition-colors hover:bg-accent focus-visible:bg-accent focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
              >
                {open ? (
                  <ChevronDown className="size-3 shrink-0 text-muted-foreground" />
                ) : (
                  <ChevronRight className="size-3 shrink-0 text-muted-foreground" />
                )}
                <span className="min-w-0 truncate text-[13px] font-medium text-foreground">
                  {section.label}
                </span>
                <span className="shrink-0 text-[11px] text-muted-foreground">
                  {section.issues.length}
                </span>
              </Button>
            </CollapsibleTrigger>
            <CollapsibleContent className="divide-y divide-border/50 border-t border-border/50">
              {section.issues.map((issue) => (
                <JiraIssueRow
                  key={`${issue.siteId ?? 'site'}:${issue.id || issue.key}`}
                  {...rowProps(issue)}
                />
              ))}
            </CollapsibleContent>
          </Collapsible>
        )
      })}
    </div>
  )
}
