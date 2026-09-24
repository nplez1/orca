import { useCallback, useEffect, useMemo, useState } from 'react'
import type { TaskPageJiraBoardModel } from './task-page-jira-board-types'
import type { JiraBoardOverview, JiraBoardSelection } from '../../../shared/jira-types'
import { jiraGetBoardOverview } from '@/runtime/runtime-jira-client'
import {
  filterTaskPageJiraBoardIssues,
  getTaskPageJiraBoardViewerAccountId,
  type TaskPageJiraBoardFilter
} from './task-page-jira-board-model'
import { useTaskPageJiraBoardPages } from './use-task-page-jira-board-pages'

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : 'Unable to load this Jira board.'
}

export function useTaskPageJiraBoard(model: TaskPageJiraBoardModel, selection: JiraBoardSelection) {
  const providerSettings = model.jiraTaskSourceContext ?? model.settings
  const teamFieldId = model.settings?.jiraTeamFieldId ?? ''
  const teamValue = model.settings?.jiraTeamValue.trim() ?? ''
  const viewerAccountId = getTaskPageJiraBoardViewerAccountId(model.jiraStatus, selection.siteId)
  const [overview, setOverview] = useState<JiraBoardOverview | null>(null)
  const [overviewLoading, setOverviewLoading] = useState(true)
  const [overviewError, setOverviewError] = useState<string | null>(null)
  const [runtimeBoardUnavailable, setRuntimeBoardUnavailable] = useState(false)
  const [activeSprintId, setActiveSprintId] = useState('')
  const [filter, setFilter] = useState<TaskPageJiraBoardFilter>('all')
  const [refreshNonce, setRefreshNonce] = useState(0)
  const markRuntimeBoardUnavailable = useCallback(() => {
    setRuntimeBoardUnavailable(true)
  }, [])

  useEffect(() => {
    let cancelled = false
    setOverview(null)
    setOverviewLoading(true)
    setOverviewError(null)
    setRuntimeBoardUnavailable(false)
    void jiraGetBoardOverview(providerSettings, selection.boardId, selection.siteId)
      .then((nextOverview) => {
        if (cancelled) {
          return
        }
        setOverview(nextOverview)
        setActiveSprintId((currentId) =>
          nextOverview.activeSprints.some((sprint) => sprint.id === currentId)
            ? currentId
            : (nextOverview.activeSprints[0]?.id ?? '')
        )
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setOverviewError(describeError(error))
          if (error instanceof Error && 'code' in error && error.code === 'method_not_found') {
            markRuntimeBoardUnavailable()
          }
        }
      })
      .finally(() => {
        if (!cancelled) {
          setOverviewLoading(false)
        }
      })
    return () => {
      cancelled = true
    }
  }, [
    markRuntimeBoardUnavailable,
    providerSettings,
    refreshNonce,
    selection.boardId,
    selection.siteId
  ])

  const activeSprintAvailable = Boolean(
    overview?.activeSprints.some((sprint) => sprint.id === activeSprintId)
  )
  const pages = useTaskPageJiraBoardPages({
    providerSettings,
    selection,
    activeSprintId,
    activeSprintAvailable,
    teamFieldId,
    refreshNonce,
    onRuntimeBoardUnavailable: markRuntimeBoardUnavailable
  })
  const displayedSprintIssues = useMemo(
    () => filterTaskPageJiraBoardIssues(pages.sprintIssues, filter, viewerAccountId, teamValue),
    [filter, pages.sprintIssues, teamValue, viewerAccountId]
  )
  const displayedBacklogIssues = useMemo(
    () => filterTaskPageJiraBoardIssues(pages.backlogIssues, filter, viewerAccountId, teamValue),
    [filter, pages.backlogIssues, teamValue, viewerAccountId]
  )

  return {
    overview,
    overviewLoading,
    overviewError,
    runtimeBoardUnavailable,
    activeSprintId,
    setActiveSprintId,
    activeSprint: overview?.activeSprints.find((sprint) => sprint.id === activeSprintId) ?? null,
    sprintIssues: displayedSprintIssues,
    sprintTotal: pages.sprintIssues.length,
    sprintLoading: pages.sprintLoading,
    sprintLoadingMore: pages.sprintLoadingMore,
    sprintIsLast: pages.sprintIsLast,
    sprintError: pages.sprintError,
    loadMoreSprint: pages.loadMoreSprint,
    backlogIssues: displayedBacklogIssues,
    backlogLoadedCount: pages.backlogIssues.length,
    backlogTotal: pages.backlogTotal,
    backlogLoading: pages.backlogLoading,
    backlogLoadingMore: pages.backlogLoadingMore,
    backlogIsLast: pages.backlogIsLast,
    backlogError: pages.backlogError,
    loadMoreBacklog: pages.loadMoreBacklog,
    filter,
    setFilter,
    meFilterReady: Boolean(viewerAccountId),
    teamFilterReady: Boolean(teamFieldId && teamValue),
    refresh: () => setRefreshNonce((nonce) => nonce + 1)
  }
}
