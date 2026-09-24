import { useEffect, useMemo, useRef, useState } from 'react'
import type { DragEvent, JSX } from 'react'
import type {
  JiraBoardColumn,
  JiraBoardSelection,
  JiraIssue,
  JiraProjectStatusOrder,
  JiraTransition
} from '../../../../../shared/jira-types'
import type { TaskPageJiraBoardModel } from '../../task-page-jira-board-types'
export type { TaskPageJiraBoardModel } from '../../task-page-jira-board-types'
import { useTaskPageJiraBoard } from '../../use-task-page-jira-board'
import {
  getTaskPageJiraBoardTransitionTargets,
  groupTaskPageJiraBoardIssues
} from '../../task-page-jira-board-model'
import { jiraListTransitions, jiraUpdateIssue } from '@/runtime/runtime-jira-client'
import { TaskPageJiraBacklogView } from './BacklogView'
import { TaskPageJiraBoardColumns } from './BoardColumns'
import { TaskPageJiraBoardHeader } from './BoardHeader'
import { TaskPageJiraTransitionPicker } from './TransitionPicker'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import { toast } from 'sonner'
import { LoaderCircle } from 'lucide-react'

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : 'Jira board update failed.'
}

function columnKey(column: JiraBoardColumn, index: number): string {
  return `${column.name}:${index}:${column.statusIds.join(',')}`
}

function loadMoreLabel(loading: boolean, label: string): string {
  return loading ? translate('auto.components.TaskPage.jiraBoardLoadingMore', 'Loading…') : label
}

export function TaskPageJiraBoard({
  model,
  selection,
  onUseIssueList,
  onIssueMoved
}: {
  model: TaskPageJiraBoardModel
  selection: JiraBoardSelection
  onUseIssueList: () => void
  onIssueMoved: (issue: JiraIssue) => void
}): JSX.Element {
  const board = useTaskPageJiraBoard(model, selection)
  const openSettingsPage = useAppStore((state) => state.openSettingsPage)
  const openSettingsTarget = useAppStore((state) => state.openSettingsTarget)
  const [draggingIssueKey, setDraggingIssueKey] = useState<string | null>(null)
  const [dragOverColumnKey, setDragOverColumnKey] = useState<string | null>(null)
  const [movingIssueKey, setMovingIssueKey] = useState<string | null>(null)
  const [pendingIssue, setPendingIssue] = useState<JiraIssue | null>(null)
  const [pendingTransitions, setPendingTransitions] = useState<JiraTransition[]>([])
  const [transitionSaving, setTransitionSaving] = useState(false)
  const [activeView, setActiveView] = useState<'sprint' | 'backlog'>('sprint')
  const legacyRuntimeFallbackApplied = useRef(false)
  const providerSettings = model.jiraTaskSourceContext ?? model.settings
  const filteredColumns = useMemo(
    () => groupTaskPageJiraBoardIssues(board.overview?.columns ?? [], board.sprintIssues),
    [board.overview?.columns, board.sprintIssues]
  )
  const activeSprintCount = board.overview?.activeSprints.length
  const visibleView = activeSprintCount === 0 ? 'backlog' : activeView
  const statusOrder: JiraProjectStatusOrder | null = board.overview
    ? { statusIdsByColumn: board.overview.columns.map((column) => column.statusIds) }
    : null

  useEffect(() => {
    if (!board.runtimeBoardUnavailable || legacyRuntimeFallbackApplied.current) {
      return
    }
    legacyRuntimeFallbackApplied.current = true
    toast.message(
      translate(
        'auto.components.TaskPage.jiraBoardRequiresNewRuntime',
        'This Jira runtime does not support board views. Showing the issue list instead.'
      )
    )
    onUseIssueList()
  }, [board.runtimeBoardUnavailable, onUseIssueList])

  const openJiraBoardSettings = (): void => {
    openSettingsPage()
    openSettingsTarget({
      pane: 'tasks',
      repoId: null,
      sectionId: 'tasks-jira-board'
    })
  }

  const applyTransition = async (issue: JiraIssue, transition: JiraTransition): Promise<void> => {
    setTransitionSaving(true)
    try {
      const result = await jiraUpdateIssue(
        providerSettings,
        issue.key,
        { transitionId: transition.id },
        issue.siteId
      )
      if (!result.ok) {
        throw new Error(result.error)
      }
      toast.success(
        translate('auto.components.TaskPage.jiraIssueMoved', '{{value0}} moved to {{value1}}', {
          value0: issue.key,
          value1: transition.to.name
        })
      )
      setPendingIssue(null)
      setPendingTransitions([])
      onIssueMoved(issue)
      board.refresh()
    } catch (error) {
      toast.error(errorText(error))
    } finally {
      setTransitionSaving(false)
    }
  }

  const handleDrop = async (
    column: JiraBoardColumn,
    event: DragEvent<HTMLElement>
  ): Promise<void> => {
    event.preventDefault()
    event.stopPropagation()
    setDragOverColumnKey(null)
    const issueKey = event.dataTransfer.getData('text/plain') || draggingIssueKey
    setDraggingIssueKey(null)
    if (!issueKey || movingIssueKey) {
      return
    }
    const issue = board.sprintIssues.find((candidate) => candidate.key === issueKey)
    if (!issue || column.statusIds.includes(issue.status.id)) {
      return
    }
    setMovingIssueKey(issue.key)
    try {
      const transitions = await jiraListTransitions(providerSettings, issue.key, issue.siteId)
      const matchingTransitions = getTaskPageJiraBoardTransitionTargets(
        transitions,
        column.statusIds
      )
      if (matchingTransitions.length === 0) {
        toast.error(
          translate(
            'auto.components.TaskPage.jiraNoStatusTransition',
            'Jira has no available transition to {{value0}} for {{value1}}.',
            { value0: column.name, value1: issue.key }
          )
        )
      } else if (matchingTransitions.length === 1) {
        await applyTransition(issue, matchingTransitions[0])
      } else {
        setPendingIssue(issue)
        setPendingTransitions(matchingTransitions)
      }
    } catch (error) {
      toast.error(errorText(error))
    } finally {
      setMovingIssueKey(null)
    }
  }

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
        teamFilterReady={board.teamFilterReady}
        loading={board.overviewLoading || board.sprintLoading || board.backlogLoading}
        onRefresh={board.refresh}
        onUseIssueList={onUseIssueList}
        onConfigureTeam={openJiraBoardSettings}
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
              onOpenIssue={model.openJiraDetailPage}
              onStartWorkspace={model.handleUseJiraItem}
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
              {board.sprintLoading && board.sprintIssues.length === 0 ? (
                <div className="flex min-h-40 items-center justify-center gap-2 text-sm text-muted-foreground">
                  <LoaderCircle className="size-4 animate-spin" />
                  {translate('auto.components.TaskPage.jiraBoardLoading', 'Loading…')}
                </div>
              ) : null}
              {board.overview?.activeSprints.length && !board.sprintLoading ? (
                <TaskPageJiraBoardColumns
                  columns={filteredColumns.columns}
                  otherIssues={filteredColumns.otherIssues}
                  selectedIssue={model.selectedJiraIssue}
                  draggingIssueKey={draggingIssueKey}
                  updatingIssueKey={movingIssueKey}
                  dragOverColumnKey={dragOverColumnKey}
                  onOpenIssue={model.openJiraDetailPage}
                  onDragStart={(issue, event) => {
                    if (movingIssueKey) {
                      event.preventDefault()
                      return
                    }
                    try {
                      event.dataTransfer.setData('text/plain', issue.key)
                      event.dataTransfer.effectAllowed = 'move'
                      setDraggingIssueKey(issue.key)
                    } catch {
                      event.preventDefault()
                    }
                  }}
                  onDragEnd={() => {
                    setDraggingIssueKey(null)
                    setDragOverColumnKey(null)
                  }}
                  onDragOver={(columnGroup, event) => {
                    const index = filteredColumns.columns.findIndex(
                      (entry) => entry.column === columnGroup.column
                    )
                    if (
                      index === -1 ||
                      columnGroup.column.statusIds.length === 0 ||
                      movingIssueKey
                    ) {
                      return
                    }
                    event.preventDefault()
                    event.dataTransfer.dropEffect = 'move'
                    setDragOverColumnKey(columnKey(columnGroup.column, index))
                  }}
                  onDrop={(columnGroup, event) => void handleDrop(columnGroup.column, event)}
                />
              ) : null}
              {board.sprintIssues.length === 0 &&
              board.sprintIsLast &&
              !board.sprintLoading &&
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
                    disabled={board.sprintLoadingMore}
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
        issue={pendingIssue}
        transitions={pendingTransitions}
        disabled={transitionSaving}
        onClose={() => {
          if (!transitionSaving) {
            setPendingIssue(null)
            setPendingTransitions([])
          }
        }}
        onSelect={(transition) => {
          if (pendingIssue) {
            void applyTransition(pendingIssue, transition)
          }
        }}
      />
    </div>
  )
}
