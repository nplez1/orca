import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { TaskPageJiraBoardModel } from './task-page-jira-board-types'
import type { JiraBoardOverview, JiraBoardSelection } from '../../../shared/jira-types'
import { jiraGetBoardOverview } from '@/runtime/runtime-jira-client'
import {
  filterTaskPageJiraBoardIssues,
  getTaskPageJiraBoardViewerAccountId,
  issueMatchesTaskPageJiraBoardQuery,
  type TaskPageJiraBoardFilter
} from './task-page-jira-board-model'
import { useTaskPageJiraBoardPages } from './use-task-page-jira-board-pages'
import {
  patchTaskPageJiraBoardCache,
  readTaskPageJiraBoardCache,
  taskPageJiraBoardCacheKey
} from './task-page-jira-board-cache'
import {
  loadJiraBoardViewPreferences,
  updateJiraBoardViewPreferences
} from './jira-board-view-storage'

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : 'Unable to load this Jira board.'
}

export function useTaskPageJiraBoard(model: TaskPageJiraBoardModel, selection: JiraBoardSelection) {
  const providerSettings = model.jiraTaskSourceContext ?? model.settings
  const viewerAccountId = getTaskPageJiraBoardViewerAccountId(model.jiraStatus, selection.siteId)
  const cacheKey = taskPageJiraBoardCacheKey(selection)
  const [cacheSnapshot] = useState(() => readTaskPageJiraBoardCache(cacheKey))
  const overviewLoadedRef = useRef(cacheSnapshot?.overview != null)
  const [refreshNonce, setRefreshNonce] = useState(0)
  const [overview, setOverview] = useState<JiraBoardOverview | null>(
    cacheSnapshot?.overview ?? null
  )
  const [overviewLoading, setOverviewLoading] = useState(!cacheSnapshot?.overview)
  const [overviewError, setOverviewError] = useState<string | null>(null)
  const [runtimeBoardUnavailable, setRuntimeBoardUnavailable] = useState(false)
  const [activeSprintId, setActiveSprintIdState] = useState(cacheSnapshot?.activeSprintId ?? '')
  const activeSprintIdRef = useRef(cacheSnapshot?.activeSprintId ?? '')
  const overviewGeneration = useRef(0)
  const lastOverviewRefreshRef = useRef(refreshNonce)
  const [filter, setFilterState] = useState<TaskPageJiraBoardFilter>(
    () => loadJiraBoardViewPreferences().filter
  )
  const [query, setQueryState] = useState(() => loadJiraBoardViewPreferences().query)

  const setFilter = useCallback((next: TaskPageJiraBoardFilter) => {
    setFilterState(next)
    updateJiraBoardViewPreferences({ filter: next })
  }, [])
  const setQuery = useCallback((next: string) => {
    setQueryState(next)
    updateJiraBoardViewPreferences({ query: next })
  }, [])
  const setActiveSprintId = useCallback(
    (next: string) => {
      activeSprintIdRef.current = next
      setActiveSprintIdState(next)
      // Why: the cached sprint page belongs to the previous sprint, so drop it rather
      // than seed a mismatched (selection, page) pair on the next mount.
      patchTaskPageJiraBoardCache(cacheKey, { activeSprintId: next, sprint: null })
    },
    [cacheKey]
  )
  const markRuntimeBoardUnavailable = useCallback(() => setRuntimeBoardUnavailable(true), [])

  useEffect(() => {
    const generation = ++overviewGeneration.current
    const refreshChanged = refreshNonce !== lastOverviewRefreshRef.current
    lastOverviewRefreshRef.current = refreshNonce
    // Why: a cached overview revalidates behind the rendered board; only an explicit
    // refresh may blank it and show a loader.
    const silent = !refreshChanged && overviewLoadedRef.current
    if (!silent) {
      setOverview(null)
      setOverviewLoading(true)
      setRuntimeBoardUnavailable(false)
    }
    setOverviewError(null)
    void jiraGetBoardOverview(providerSettings, selection.boardId, selection.siteId)
      .then((nextOverview) => {
        if (generation !== overviewGeneration.current) {
          return
        }
        setOverview(nextOverview)
        const currentId = activeSprintIdRef.current
        const resolvedId = nextOverview.activeSprints.some((sprint) => sprint.id === currentId)
          ? currentId
          : (nextOverview.activeSprints[0]?.id ?? '')
        const sprintChanged = resolvedId !== currentId
        activeSprintIdRef.current = resolvedId
        setActiveSprintIdState(resolvedId)
        overviewLoadedRef.current = true
        patchTaskPageJiraBoardCache(cacheKey, {
          overview: nextOverview,
          activeSprintId: resolvedId,
          // Why: a vanished sprint invalidates the page cached under the old selection.
          ...(sprintChanged ? { sprint: null } : {})
        })
      })
      .catch((error: unknown) => {
        if (generation !== overviewGeneration.current) {
          return
        }
        setOverviewError(describeError(error))
        if (error instanceof Error && 'code' in error && error.code === 'method_not_found') {
          setRuntimeBoardUnavailable(true)
        }
      })
      .finally(() => {
        if (generation === overviewGeneration.current) {
          setOverviewLoading(false)
        }
      })
    return () => {
      overviewGeneration.current += 1
    }
  }, [cacheKey, providerSettings, refreshNonce, selection.boardId, selection.siteId])

  const activeSprintAvailable = Boolean(
    overview?.activeSprints.some((sprint) => sprint.id === activeSprintId)
  )
  const pages = useTaskPageJiraBoardPages({
    providerSettings,
    boardId: selection.boardId,
    siteId: selection.siteId,
    activeSprintId,
    activeSprintAvailable,
    refreshNonce,
    initialCache: cacheSnapshot,
    onRuntimeBoardUnavailable: markRuntimeBoardUnavailable
  })
  // Why: a board on a site whose viewer account is unknown cannot answer "me"; fall
  // back to showing everything rather than an empty board behind a disabled button.
  const effectiveFilter: TaskPageJiraBoardFilter =
    filter === 'me' && !viewerAccountId ? 'all' : filter
  const displayedSprintIssues = useMemo(() => {
    const byAssignee = filterTaskPageJiraBoardIssues(
      pages.sprintIssues,
      effectiveFilter,
      viewerAccountId
    )
    return byAssignee.filter((issue) => issueMatchesTaskPageJiraBoardQuery(issue, query))
  }, [effectiveFilter, pages.sprintIssues, query, viewerAccountId])
  const displayedBacklogIssues = useMemo(() => {
    const byAssignee = filterTaskPageJiraBoardIssues(
      pages.backlogIssues,
      effectiveFilter,
      viewerAccountId
    )
    return byAssignee.filter((issue) => issueMatchesTaskPageJiraBoardQuery(issue, query))
  }, [effectiveFilter, pages.backlogIssues, query, viewerAccountId])

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
    filter: effectiveFilter,
    setFilter,
    query,
    setQuery,
    meFilterReady: Boolean(viewerAccountId),
    refresh: () => setRefreshNonce((nonce) => nonce + 1)
  }
}
