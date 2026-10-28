import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { JSX } from 'react'
import type {
  JiraBoardSelection,
  JiraIssue,
  JiraProjectStatusOrder
} from '../../../../../shared/jira/jira-types'
import type { TaskPageJiraBoardModel } from '../../task-page-jira-board-types'
export type { TaskPageJiraBoardModel } from '../../task-page-jira-board-types'
import { useTaskPageJiraBoard } from '../../use-task-page-jira-board'
import { groupTaskPageJiraBoardIssues } from '../../task-page-jira-board-model'
import { TaskPageJiraBacklogView } from './BacklogView'
import { TaskPageJiraBoardColumns } from './BoardColumns'
import { TaskPageJiraBoardHeader } from './BoardHeader'
import { TaskPageJiraTransitionPicker } from './TransitionPicker'
import { TaskPageJiraTransitionFieldsDialog } from './TransitionFieldsDialog'
import { useJiraBoardDrop } from './use-jira-board-drop'
import { jiraBoardErrorText } from './jira-board-error-text'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { translate } from '@/i18n/i18n'
import { jiraUpdateIssue } from '@/runtime/runtime-jira-client'
import { toast } from 'sonner'
import { LoaderCircle } from 'lucide-react'
import { openJiraIssueWorkspace } from '@/lib/jira-issue-workspace-open'
import {
  loadJiraBoardViewPreferences,
  updateJiraBoardViewPreferences
} from '../../jira-board-view-storage'

function loadMoreLabel(loading: boolean, label: string): string {
  return loading ? translate('auto.components.TaskPage.jiraBoardLoadingMore', 'Loading…') : label
}

export function TaskPageJiraBoard({
  model,
  selection,
  onUseIssueList,
  onBoardUnavailable,
  onIssueMoved,
  refreshSignal = 0
}: {
  model: TaskPageJiraBoardModel
  selection: JiraBoardSelection
  onUseIssueList: () => void
  /** The runtime cannot serve this board; the parent shows the list and says why. */
  onBoardUnavailable: () => void
  onIssueMoved: (issue: JiraIssue) => void
  /** A sprint move made outside the board (the open issue's picker), which takes the
   *  item in or out of these lists just as a row move does. */
  refreshSignal?: number
}): JSX.Element {
  const board = useTaskPageJiraBoard(model, selection, refreshSignal)
  const [activeView, setActiveViewState] = useState<'sprint' | 'backlog'>(
    () => loadJiraBoardViewPreferences().activeView
  )
  const providerSettings = board.providerSettings
  const setActiveView = useCallback((view: 'sprint' | 'backlog') => {
    setActiveViewState(view)
    updateJiraBoardViewPreferences({ activeView: view })
  }, [])
  const legacyRuntimeFallbackApplied = useRef(false)
  const [assigningSprintIssueKey, setAssigningSprintIssueKey] = useState<string | null>(null)
  const filteredColumns = useMemo(
    () => groupTaskPageJiraBoardIssues(board.overview?.columns ?? [], board.sprintIssues),
    [board.overview?.columns, board.sprintIssues]
  )
  const activeSprintCount = board.overview?.activeSprints.length
  const visibleView = activeSprintCount === 0 ? 'backlog' : activeView
  const statusOrder: JiraProjectStatusOrder | null = board.overview
    ? { statusIdsByColumn: board.overview.columns.map((column) => column.statusIds) }
    : null
  const drop = useJiraBoardDrop({
    providerSettings,
    sprintIssues: board.sprintIssues,
    columns: filteredColumns.columns,
    applyIssuePatch: board.applyIssuePatch,
    revalidateBoard: board.refreshSilently,
    onIssueMoved
  })

  const backlogSprints = board.overview?.sprints ?? []
  const sprintName = (sprintId: string): string =>
    backlogSprints.find((sprint) => sprint.id === sprintId)?.name ?? sprintId

  // Moving an issue into a sprint takes it out of the backlog, so the reload — not a
  // local removal — is what settles both views. It reconciles behind the rendered rows,
  // so the board a slow host is still drawing does not blank under the user.
  const assignSprint = async (issue: JiraIssue, sprintId: string): Promise<void> => {
    // One row move at a time: the key disables every row's control while it runs.
    if (assigningSprintIssueKey) {
      return
    }
    setAssigningSprintIssueKey(issue.key)
    try {
      const result = await jiraUpdateIssue(providerSettings, issue.key, { sprintId }, issue.siteId)
      if (!result.ok) {
        throw new Error(result.error)
      }
      toast.success(
        translate('auto.components.TaskPage.jiraSprintAssigned', '{{value0}} moved to {{value1}}', {
          value0: issue.key,
          value1: sprintName(sprintId)
        })
      )
      onIssueMoved(issue)
      board.refreshSilently()
    } catch (error) {
      toast.error(jiraBoardErrorText(error))
    } finally {
      setAssigningSprintIssueKey(null)
    }
  }

  useEffect(() => {
    if (!board.runtimeBoardUnavailable || legacyRuntimeFallbackApplied.current) {
      return
    }
    legacyRuntimeFallbackApplied.current = true
    // Why: the fallback must not be recorded as the user's view preference — a runtime
    // upgrade would never undo it, and the reason would survive only as a toast.
    onBoardUnavailable()
  }, [board.runtimeBoardUnavailable, onBoardUnavailable])

  return (
    <div className="flex min-h-0 max-h-full flex-1 flex-col overflow-hidden rounded-md border border-border/50 bg-background shadow-sm">
      <TaskPageJiraBoardHeader
        boardName={board.overview?.board.name}
        activeView={visibleView}
        sprintAvailable={activeSprintCount === undefined ? null : activeSprintCount > 0}
        onViewChange={setActiveView}
        filter={board.filter}
        onFilterChange={board.setFilter}
        viewerAvailable={board.meFilterReady}
        query={board.query}
        onQueryChange={board.setQuery}
        loading={board.overviewLoading || board.sprintLoading || board.backlogLoading}
        onRefresh={board.refresh}
        onUseIssueList={onUseIssueList}
      />

      {board.overviewError ? (
        <div className="flex items-center justify-between gap-3 border-b border-destructive/20 bg-destructive/5 px-4 py-3 text-sm text-destructive">
          <span className="min-w-0">{board.overviewError}</span>
          <Button type="button" variant="outline" size="sm" onClick={board.refresh}>
            {translate('auto.components.TaskPage.0bfbf62f75', 'Retry')}
          </Button>
        </div>
      ) : null}

      {board.overviewLoading ? (
        <div className="flex min-h-40 flex-1 items-center justify-center gap-2 text-sm text-muted-foreground">
          <LoaderCircle className="size-4 animate-spin" />
          {translate('auto.components.TaskPage.jiraBoardLoading', 'Loading…')}
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-auto scrollbar-sleek">
          {visibleView === 'backlog' ? (
            <TaskPageJiraBacklogView
              board={board}
              statusOrder={statusOrder}
              selectedIssue={model.selectedJiraIssue}
              issueWorkspaceAttachmentIndex={model.jiraIssueAttachmentIndex}
              onOpenIssue={model.openJiraDetailPage}
              onOpenOrStartWorkspace={model.handleOpenOrUseJiraItem}
              getIssueWorkspaces={model.getJiraIssueWorkspaces}
              onOpenWorkspace={openJiraIssueWorkspace}
              onStartWorkspace={model.handleUseJiraItem}
              sourceContext={model.jiraTaskSourceContext}
              sprintOptions={
                backlogSprints.length > 0
                  ? {
                      sprints: backlogSprints,
                      assigningIssueKey: assigningSprintIssueKey,
                      onAssignSprint: (issue, sprintId) => void assignSprint(issue, sprintId)
                    }
                  : null
              }
            />
          ) : (
            <section
              aria-label={translate('auto.components.TaskPage.jiraCurrentSprint', 'Current sprint')}
            >
              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border/50 px-3 py-2">
                <div className="min-w-0 text-sm font-medium text-foreground">
                  {board.activeSprint?.name ??
                    translate('auto.components.TaskPage.jiraCurrentSprint', 'Current sprint')}
                </div>
                {board.overview && board.overview.activeSprints.length > 1 ? (
                  <Select value={board.activeSprintId} onValueChange={board.setActiveSprintId}>
                    <SelectTrigger className="h-8 w-56">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {board.overview.activeSprints.map((sprint) => (
                        <SelectItem key={sprint.id} value={sprint.id}>
                          {sprint.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ) : null}
              </div>
              {board.sprintError ? (
                <div
                  role="alert"
                  className="border-b border-destructive/20 px-4 py-3 text-sm text-destructive"
                >
                  {board.sprintError}
                </div>
              ) : null}
              {board.sprintBlanked ? (
                <div className="flex min-h-40 items-center justify-center gap-2 text-sm text-muted-foreground">
                  <LoaderCircle className="size-4 animate-spin" />
                  {translate('auto.components.TaskPage.jiraBoardLoading', 'Loading…')}
                </div>
              ) : null}
              {board.overview?.activeSprints.length && !board.sprintBlanked ? (
                <TaskPageJiraBoardColumns
                  columns={filteredColumns.columns}
                  otherIssues={filteredColumns.otherIssues}
                  selectedIssue={model.selectedJiraIssue}
                  issueWorkspaceAttachmentIndex={model.jiraIssueAttachmentIndex}
                  sourceContext={model.jiraTaskSourceContext}
                  draggingIssueKey={drop.draggingIssueKey}
                  updatingIssueKeys={drop.movingIssueKeys}
                  dragOverColumnKey={drop.dragOverColumnKey}
                  onOpenIssue={model.openJiraDetailPage}
                  onOpenOrStartWorkspace={model.handleOpenOrUseJiraItem}
                  onStartWorkspace={model.handleUseJiraItem}
                  onDragStart={drop.startDrag}
                  onDragEnd={drop.endDrag}
                  onDragOver={drop.handleDragOver}
                  onDrop={(columnGroup, event) => void drop.handleDrop(columnGroup.column, event)}
                  onDragOverOther={drop.handleDragOverOther}
                  onDropOther={(event) => void drop.handleOtherDrop(event)}
                />
              ) : null}
              {board.sprintIssues.length === 0 &&
              board.sprintIsLast &&
              !board.sprintBlanked &&
              board.overview?.activeSprints.length ? (
                <div className="px-4 py-8 text-center text-sm text-muted-foreground">
                  {translate(
                    'auto.components.TaskPage.jiraSprintEmpty',
                    'No issues match this filter in the active sprint.'
                  )}
                </div>
              ) : null}
              {!board.sprintIsLast && board.overview?.activeSprints.length ? (
                <div className="flex justify-center border-t border-border/50 p-3">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={board.sprintLoadingMore || board.sprintLoading}
                    onClick={() => void board.loadMoreSprint()}
                  >
                    {loadMoreLabel(
                      board.sprintLoadingMore,
                      translate(
                        'auto.components.TaskPage.jiraLoadMoreSprint',
                        'Load more sprint issues'
                      )
                    )}
                  </Button>
                </div>
              ) : null}
            </section>
          )}
        </div>
      )}

      <TaskPageJiraTransitionPicker
        issue={drop.pendingIssue}
        transitions={drop.pendingTransitions}
        mode={drop.pendingTransitionMode}
        disabled={drop.transitionSaving}
        onClose={drop.closeTransitionPicker}
        onSelect={drop.selectTransition}
      />

      <TaskPageJiraTransitionFieldsDialog
        request={
          drop.pendingTransitionFields
            ? {
                issue: drop.pendingTransitionFields.issue,
                transition: drop.pendingTransitionFields.transition,
                rejectedFieldErrors: drop.pendingTransitionFields.rejectedFieldErrors,
                errorMessages: drop.pendingTransitionFields.errorMessages,
                error: drop.pendingTransitionFields.error
              }
            : null
        }
        providerSettings={providerSettings}
        submitting={drop.transitionSaving}
        onClose={drop.closeTransitionFields}
        onSubmit={drop.submitTransitionFields}
      />
    </div>
  )
}
