import { ArrowRight, FolderOpen, LoaderCircle, X } from 'lucide-react'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { JiraIssueAssigneeControl } from '@/components/jira-issue-assignee-control'
import { JiraSprintPicker, backlogLabel, sprintTriggerLabel } from '@/components/jira-sprint-picker'
import { JiraIssueStoryPointsControl } from '@/components/jira-issue-story-points-control'
import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'
import type { TaskSourceContext } from '../../../shared/task-source-context'
import { JiraIssueTransitionControl } from './jira-issue-transition-control'
import { translate } from '@/i18n/i18n'
import { formatUiRelativeTimeFromDate } from '@/i18n/relative-time-format'
import type { RuntimeJiraSettings } from '@/runtime/runtime-jira-client'
import type {
  JiraEditableField,
  JiraIssue,
  JiraIssueUpdate,
  JiraMutationResult,
  JiraPriority,
  JiraSprintAssignment,
  JiraTransition,
  JiraUser
} from '../../../shared/jira/jira-types'
import {
  JiraIssueEditFieldsDialog,
  type JiraIssueFieldOutcome
} from './jira-issue-edit-fields-dialog'

export function JiraIssueWorkspaceHeader({
  attachedWorkspaceLabel,
  displayed,
  issueLoading,
  onOpenOrStartWorkspace,
  onClose
}: {
  attachedWorkspaceLabel: string | null
  displayed: JiraIssue
  issueLoading: boolean
  onOpenOrStartWorkspace: (issue: JiraIssue) => void
  onClose: () => void
}): React.JSX.Element {
  return (
    <div className="flex-none border-b border-border/50 bg-muted/30 px-4 py-3">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-2xs text-muted-foreground">
            <span className="font-mono">{displayed.key}</span>
            {displayed.siteName ? <span>{displayed.siteName}</span> : null}
            <span>{displayed.project.key}</span>
            <span>{formatUiRelativeTimeFromDate(displayed.updatedAt)}</span>
            {issueLoading ? <LoaderCircle className="size-3 animate-spin" /> : null}
          </div>
          <h2 className="mt-1 text-xl font-semibold leading-tight text-foreground">
            {displayed.title}
          </h2>
        </div>
        <Button
          onClick={() => onOpenOrStartWorkspace(displayed)}
          className="hidden shrink-0 gap-2 sm:inline-flex"
          size="sm"
        >
          {attachedWorkspaceLabel
            ? translate('auto.components.JiraIssueWorkspace.showWorkspace', 'Show workspace')
            : translate('auto.components.JiraIssueWorkspace.2441be6f9f', 'Start workspace')}
          {attachedWorkspaceLabel ? (
            <FolderOpen className="size-4" />
          ) : (
            <ArrowRight className="size-4" />
          )}
        </Button>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              className="shrink-0"
              onClick={onClose}
              aria-label={translate(
                'auto.components.JiraIssueWorkspace.76513c7898',
                'Close Jira issue preview'
              )}
            >
              <X className="size-4" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom" sideOffset={6}>
            {translate('auto.components.JiraIssueWorkspace.7a96985ca0', 'Close')}
          </TooltipContent>
        </Tooltip>
      </div>
    </div>
  )
}

export function JiraIssueMetadataBar({
  displayed,
  pendingField,
  transitions,
  transitionsLoading,
  transitionsError,
  reloadTransitions,
  priorities,
  prioritiesError,
  editFields,
  editFieldsLoading,
  editFieldsError,
  reloadEditFields,
  providerSettings,
  sourceContext,
  owner,
  runtimeContextKey,
  sprintAssignment,
  sprintAssignmentError,
  mutateIssue,
  submitIssueFields
}: {
  displayed: JiraIssue
  pendingField: string | null
  transitions: JiraTransition[]
  transitionsLoading: boolean
  transitionsError: string | null
  reloadTransitions: () => void
  priorities: JiraPriority[]
  prioritiesError: string | null
  editFields: JiraEditableField[]
  editFieldsLoading: boolean
  editFieldsError: string | null
  reloadEditFields: () => void
  /** Kept in the contract for the sheet's self-user pass-through; the assignee
   *  control now resolves the signed-in user itself from the source context. */
  selfUser: JiraUser | null
  users: JiraUser[]
  providerSettings: RuntimeJiraSettings
  sourceContext?: TaskSourceContext | null
  owner: RuntimeClientTarget
  runtimeContextKey: string
  /** Null on a host that cannot answer, or when no board is in scope to move into. */
  sprintAssignment: JiraSprintAssignment | null
  sprintAssignmentError: string | null
  mutateIssue: (
    field: string,
    updates: JiraIssueUpdate,
    optimistic?: Partial<JiraIssue>,
    options?: { reportsInline?: boolean }
  ) => Promise<JiraMutationResult>
  submitIssueFields: (updates: JiraIssueUpdate) => Promise<JiraIssueFieldOutcome>
}): React.JSX.Element {
  const [editFieldsOpen, setEditFieldsOpen] = useState(false)
  return (
    <>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-border/60 px-4 py-2.5">
        <JiraIssueTransitionControl
          key={`${displayed.siteId ?? ''}:${displayed.key}`}
          issue={displayed}
          transitions={transitions}
          loading={transitionsLoading}
          error={transitionsError}
          pending={pendingField !== null}
          providerSettings={providerSettings}
          onRetry={reloadTransitions}
          onTransition={(updates, transition) =>
            mutateIssue('transition', updates, { status: transition.to }, { reportsInline: true })
          }
        />

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              disabled={pendingField === 'priority'}
              className="rounded-md px-1.5 py-0.5 text-2xs text-muted-foreground transition hover:bg-muted/40 disabled:opacity-50"
            >
              {displayed.priority?.name ??
                translate('auto.components.JiraIssueWorkspace.51bed73f88', 'No priority')}
              {pendingField === 'priority' ? (
                <LoaderCircle className="ml-1 inline size-3 animate-spin" />
              ) : null}
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent className="w-48" align="start">
            <DropdownMenuItem
              onSelect={() =>
                void mutateIssue('priority', { priorityId: null }, { priority: undefined })
              }
            >
              {translate('auto.components.JiraIssueWorkspace.51bed73f88', 'No priority')}
            </DropdownMenuItem>
            {prioritiesError ? (
              <p className="px-2 py-1.5 text-2xs text-destructive">{prioritiesError}</p>
            ) : (
              priorities.map((priority) => (
                <DropdownMenuItem
                  key={priority.id}
                  onSelect={() =>
                    void mutateIssue('priority', { priorityId: priority.id }, { priority })
                  }
                >
                  {priority.name}
                </DropdownMenuItem>
              ))
            )}
          </DropdownMenuContent>
        </DropdownMenu>

        <JiraIssueAssigneeControl
          issue={displayed}
          disabled={pendingField !== null}
          sourceContext={sourceContext}
          owner={owner}
          runtimeContextKey={runtimeContextKey}
          mutateIssue={mutateIssue}
        />

        {sprintAssignment ? (
          <JiraSprintPicker
            sprint={sprintAssignment.sprint}
            sprints={sprintAssignment.sprints}
            onSelect={(sprintId) => void mutateIssue('sprint', { sprintId })}
          >
            <button
              type="button"
              disabled={pendingField === 'sprint'}
              title={sprintAssignment.sprint?.name ?? backlogLabel()}
              className="flex max-w-[220px] items-center gap-1 rounded-md px-1.5 py-0.5 text-2xs text-muted-foreground transition hover:bg-muted/40 disabled:opacity-50"
            >
              <span className="truncate">{sprintTriggerLabel(sprintAssignment.sprint)}</span>
              {pendingField === 'sprint' ? (
                <LoaderCircle className="size-3 shrink-0 animate-spin" />
              ) : null}
            </button>
          </JiraSprintPicker>
        ) : sprintAssignmentError ? (
          <span className="max-w-[220px] truncate text-2xs text-destructive">
            {sprintAssignmentError}
          </span>
        ) : null}

        <JiraIssueStoryPointsControl
          displayed={displayed}
          editFields={editFields}
          pendingField={pendingField}
          mutateIssue={mutateIssue}
        />

        {editFieldsError && editFields.length === 0 ? (
          <div className="ml-auto flex min-w-0 items-center gap-1 text-2xs text-destructive">
            <span className="max-w-[220px] truncate">{editFieldsError}</span>
            <Button type="button" variant="ghost" size="xs" onClick={reloadEditFields}>
              {translate('auto.components.JiraIssueWorkspace.retryEditFields', 'Retry')}
            </Button>
          </div>
        ) : (
          <Button
            type="button"
            variant="ghost"
            size="xs"
            className="ml-auto"
            disabled={pendingField === 'fields' || editFieldsLoading || editFields.length === 0}
            onClick={() => setEditFieldsOpen(true)}
          >
            {editFieldsLoading ? <LoaderCircle className="size-3 animate-spin" /> : null}
            {translate('auto.components.JiraIssueWorkspace.editFields', 'Edit fields')}
          </Button>
        )}
      </div>
      <JiraIssueEditFieldsDialog
        open={editFieldsOpen}
        onOpenChange={setEditFieldsOpen}
        issue={displayed}
        fields={editFields}
        providerSettings={providerSettings}
        submitting={pendingField === 'fields'}
        onSubmit={submitIssueFields}
      />
    </>
  )
}
