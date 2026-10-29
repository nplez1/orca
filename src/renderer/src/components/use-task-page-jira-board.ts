import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { TaskPageJiraBoardModel } from './task-page-jira-board-types'
import type { JiraBoardOverview, JiraBoardSelection } from '../../../shared/jira/jira-types'
import { jiraGetBoardOverview } from '@/runtime/runtime-jira-client'
import { translate } from '@/i18n/i18n'
import { extractIpcErrorMessage } from '@/lib/ipc-error'
import {
  filterTaskPageJiraBoardIssues,
  getTaskPageJiraBoardViewerAccountId,
  issueMatchesTaskPageJiraBoardQuery,
  type TaskPageJiraBoardFilter
} from './task-page-jira-board-model'
import { taskSourceRuntimeTarget } from '@/lib/task-source-runtime-target'
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
  return extractIpcErrorMessage(
    error,
    translate('jira.board.loadFailed', 'Unable to load this Jira board.')
  )
}

/**
 * A board reload and whether it may blank what is on screen first. A user's refresh
 * blanks; the reload after a mutation that already landed a patch does not.
 */
type JiraBoardRefreshRequest = { nonce: number; silent: boolean }

export function useTaskPageJiraBoard(
  model: TaskPageJiraBoardModel,
  selection: JiraBoardSelection,
  /** A board-relevant change made outside the board, such as the open issue's sprint. */
  refreshSignal = 0
) {
  // Why the page's own account host and not a live settings read: this board's Jira account is the
  // page's own — the host its already-migrated list surfaces route by — so re-reading the Active
  // Server per call could name a different host than the list that supplied these issues. That
  // capture is the focused host on this page by design; a source that genuinely differs (a Cmd-J
  // open, a linked workspace) arrives with the row. A host that names no server stays a server
  // target, so the read fails instead of running here.
  const ownerHostId = model.jiraTaskSourceContext?.hostId ?? model.accountBackedTaskSourceHostId
  // Why the host id and not the source object: a re-created source would allocate a new target and
  // re-trigger every load effect, refetching the board on each render.
  const providerSettings = useMemo(
    () => taskSourceRuntimeTarget({ hostId: ownerHostId }),
    [ownerHostId]
  )
  const viewerAccountId = getTaskPageJiraBoardViewerAccountId(model.jiraStatus, selection.siteId)
  const cacheKey = taskPageJiraBoardCacheKey(selection)
  const [cacheSnapshot] = useState(() => readTaskPageJiraBoardCache(cacheKey))
  const overviewLoadedRef = useRef(cacheSnapshot?.overview != null)
  const [refreshRequest, setRefreshRequest] = useState<JiraBoardRefreshRequest>({
    nonce: 0,
    silent: false
  })
  const { nonce: refreshNonce, silent: refreshSilent } = refreshRequest
  // Why a nonce rather than a dependency: the parent's signal must reload every scope.
  // Why silent: the sprint it announces is already applied in the sheet that sent it,
  // so blanking the board under the user would be the same defect as a blanking drop.
  const lastRefreshSignalRef = useRef(refreshSignal)
  useEffect(() => {
    if (lastRefreshSignalRef.current === refreshSignal) {
      return
    }
    lastRefreshSignalRef.current = refreshSignal
    setRefreshRequest((current) => ({ nonce: current.nonce + 1, silent: true }))
  }, [refreshSignal])
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
    // Why: a cached overview revalidates behind the rendered board; only a user's own
    // refresh may blank it and show a loader.
    const silent = !(refreshChanged && !refreshSilent) && overviewLoadedRef.current
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
  }, [cacheKey, providerSettings, refreshNonce, refreshSilent, selection.boardId, selection.siteId])

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
    refreshSilent,
    initialCache: cacheSnapshot,
    onRuntimeBoardUnavailable: markRuntimeBoardUnavailable
  })
  // Why: a board on a site whose viewer account is unknown cannot answer "me"; fall
  // back to showing everything rather than an empty board behind a disabled button.
  const effectiveFilter: TaskPageJiraBoardFilter =
    filter === 'me' && !viewerAccountId ? 'all' : filter
  const displayedSprintIssues = useMemo(() => {
    const byViewer = filterTaskPageJiraBoardIssues(
      pages.sprintIssues,
      effectiveFilter,
      viewerAccountId
    )
    return byViewer.filter((issue) => issueMatchesTaskPageJiraBoardQuery(issue, query))
  }, [effectiveFilter, pages.sprintIssues, query, viewerAccountId])
  const displayedBacklogIssues = useMemo(() => {
    const byViewer = filterTaskPageJiraBoardIssues(
      pages.backlogIssues,
      effectiveFilter,
      viewerAccountId
    )
    return byViewer.filter((issue) => issueMatchesTaskPageJiraBoardQuery(issue, query))
  }, [effectiveFilter, pages.backlogIssues, query, viewerAccountId])

  return {
    providerSettings,
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
    sprintBlanked: pages.sprintBlanked,
    sprintLoadingMore: pages.sprintLoadingMore,
    sprintIsLast: pages.sprintIsLast,
    sprintError: pages.sprintError,
    loadMoreSprint: pages.loadMoreSprint,
    backlogIssues: displayedBacklogIssues,
    backlogLoadedCount: pages.backlogIssues.length,
    backlogTotal: pages.backlogTotal,
    backlogLoading: pages.backlogLoading,
    backlogBlanked: pages.backlogBlanked,
    backlogLoadingMore: pages.backlogLoadingMore,
    backlogIsLast: pages.backlogIsLast,
    backlogError: pages.backlogError,
    loadMoreBacklog: pages.loadMoreBacklog,
    filter: effectiveFilter,
    setFilter,
    query,
    setQuery,
    meFilterReady: Boolean(viewerAccountId),
    /** Local-only patch so an optimistic move renders before Jira confirms it. */
    applyIssuePatch: pages.patchBoardIssue,
    /** A user's own refresh: the board blanks and reloads behind a loader. */
    refresh: () => setRefreshRequest((current) => ({ nonce: current.nonce + 1, silent: false })),
    /** A mutation's reload: what is on screen stays until the answer lands. */
    refreshSilently: () =>
      setRefreshRequest((current) => ({ nonce: current.nonce + 1, silent: true }))
  }
}
