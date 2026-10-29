import React, { useMemo, useState } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import type { Worktree } from '../../../shared/worktree/types'
import type { JiraIssue, JiraProjectStatusOrder } from '../../../shared/jira/jira-types'
import { groupJiraIssuesByStatus, type TaskPageJiraIssueSection } from './task-page-jira-grouping'
import type { TaskPageJiraSprintOptions } from './task-page-jira-sprint-cell'
import type { TaskSourceContext } from '../../../shared/task-source-context'
import {
  findJiraIssueWorkspaceAttachmentInIndex,
  type JiraIssueWorkspaceAttachmentIndex
} from '@/lib/jira-issue-workspace-attachment'
import { JiraIssueRow } from './task-page-jira-issue-row'
import type { JiraListColumn } from './jira-list-columns'

// Re-exported so the board sections can group through the same production function.
export { groupJiraIssuesByStatus, type TaskPageJiraIssueSection }

type TaskPageJiraIssueListProps = {
  getIssueWorkspaces?: (issue: JiraIssue) => readonly Worktree[]
  onOpenWorkspace?: (workspace: Worktree) => void
  columns?: readonly JiraListColumn[]
  formatUpdatedAt: (updatedAt: string) => string
  getStatusTone: (categoryKey: string) => string
  issues: JiraIssue[]
  onOpenIssue: (issue: JiraIssue) => void
  onStartWorkspace?: (issue: JiraIssue) => void
  selectedIssue: JiraIssue | null
  showSiteContext: boolean
  statusDirection?: 'asc' | 'desc'
  statusOrder: JiraProjectStatusOrder | null
  /** Fork board backlog wiring: the configured agile board's backlog list renders
   *  the attached-workspace chip and Show/Start action from the index, and a sprint
   *  cell instead of the column-driven main list. */
  issueWorkspaceAttachmentIndex?: JiraIssueWorkspaceAttachmentIndex
  onOpenOrStartWorkspace?: (issue: JiraIssue) => void
  /** The Jira source the attached-workspace lookup is scoped to, so the chip and
   *  the list projection agree on host, account, project and site identity. */
  sourceContext?: TaskSourceContext | null
  sprintOptions?: TaskPageJiraSprintOptions
  groupByStatus?: boolean
}

function isSelectedIssue(issue: JiraIssue, selectedIssue: JiraIssue | null): boolean {
  if (!selectedIssue || issue.key !== selectedIssue.key) {
    return false
  }
  return !selectedIssue.siteId || !issue.siteId || selectedIssue.siteId === issue.siteId
}

export function TaskPageJiraIssueList({
  getIssueWorkspaces,
  onOpenWorkspace,
  columns,
  formatUpdatedAt,
  getStatusTone,
  issueWorkspaceAttachmentIndex,
  issues,
  onOpenIssue,
  onStartWorkspace,
  onOpenOrStartWorkspace,
  sourceContext,
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
    getIssueWorkspaces,
    onOpenWorkspace,
    columns,
    formatUpdatedAt,
    getStatusTone,
    issue,
    onOpenIssue,
    onStartWorkspace,
    onOpenOrStartWorkspace,
    attachedWorkspace: issueWorkspaceAttachmentIndex
      ? findJiraIssueWorkspaceAttachmentInIndex(issueWorkspaceAttachmentIndex, issue, sourceContext)
      : null,
    sprintOptions,
    selected: isSelectedIssue(issue, selectedIssue),
    showSiteContext
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
                <span className="shrink-0 text-2xs text-muted-foreground">
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
