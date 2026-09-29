import { useCallback, useEffect, useRef, useState } from 'react'
import type { RuntimeJiraSettings } from '@/runtime/runtime-jira-client'
import { hasRuntimeRpcErrorCode } from '@/runtime/runtime-rpc-client'
import { jiraListBoardIssues } from '@/runtime/runtime-jira-client'
import {
  patchTaskPageJiraBoardCache,
  taskPageJiraBoardCacheKey,
  type TaskPageJiraBoardCacheEntry,
  type TaskPageJiraBoardCachedPage
} from './task-page-jira-board-cache'
import {
  appendJiraBoardIssuePage,
  describeJiraBoardPageError,
  emptyJiraBoardPage,
  JIRA_BOARD_ISSUE_PAGE_SIZE,
  readJiraBoardScopePages
} from './task-page-jira-board-page-fetch'

export function useTaskPageJiraBoardPages(args: {
  providerSettings: RuntimeJiraSettings
  boardId: string
  siteId: string
  activeSprintId: string
  activeSprintAvailable: boolean
  refreshNonce: number
  initialCache: TaskPageJiraBoardCacheEntry | null
  onRuntimeBoardUnavailable: () => void
}) {
  const {
    providerSettings,
    boardId,
    siteId,
    activeSprintId,
    activeSprintAvailable,
    refreshNonce,
    initialCache,
    onRuntimeBoardUnavailable
  } = args
  const cacheKey = taskPageJiraBoardCacheKey({ siteId, boardId })
  // Why: silence on a rerun must mean "this scope already has data", not "the mount
  // saw a cache entry" — a settings reload after a cache miss must not re-show a loader.
  const sprintLoadedRef = useRef(initialCache?.sprint != null)
  const backlogLoadedRef = useRef(initialCache?.backlog != null)
  const [sprintPage, setSprintPage] = useState<TaskPageJiraBoardCachedPage>(
    () => initialCache?.sprint ?? emptyJiraBoardPage()
  )
  const [sprintLoading, setSprintLoading] = useState(false)
  const [sprintLoadingMore, setSprintLoadingMore] = useState(false)
  const [sprintError, setSprintError] = useState<string | null>(null)
  const [backlogPage, setBacklogPage] = useState<TaskPageJiraBoardCachedPage>(
    () => initialCache?.backlog ?? emptyJiraBoardPage()
  )
  const [backlogLoading, setBacklogLoading] = useState(false)
  const [backlogLoadingMore, setBacklogLoadingMore] = useState(false)
  const [backlogError, setBacklogError] = useState<string | null>(null)
  const sprintPageRef = useRef(sprintPage)
  const backlogPageRef = useRef(backlogPage)
  const sprintGeneration = useRef(0)
  const backlogGeneration = useRef(0)
  const sprintRunRef = useRef({ refreshNonce, activeSprintId })
  const backlogRunRef = useRef({ refreshNonce })

  const setSprintPageLocal = useCallback((next: TaskPageJiraBoardCachedPage) => {
    sprintPageRef.current = next
    setSprintPage(next)
  }, [])
  const setBacklogPageLocal = useCallback((next: TaskPageJiraBoardCachedPage) => {
    backlogPageRef.current = next
    setBacklogPage(next)
  }, [])
  const commitSprintPage = useCallback(
    (next: TaskPageJiraBoardCachedPage) => {
      setSprintPageLocal(next)
      patchTaskPageJiraBoardCache(cacheKey, { sprint: next })
    },
    [cacheKey, setSprintPageLocal]
  )
  const commitBacklogPage = useCallback(
    (next: TaskPageJiraBoardCachedPage) => {
      setBacklogPageLocal(next)
      patchTaskPageJiraBoardCache(cacheKey, { backlog: next })
    },
    [cacheKey, setBacklogPageLocal]
  )

  useEffect(() => {
    const generation = ++sprintGeneration.current
    if (!activeSprintAvailable || !activeSprintId) {
      // Why: local only — a placeholder must not be cached as a confidently-empty sprint.
      setSprintPageLocal(emptyJiraBoardPage())
      sprintLoadedRef.current = false
      setSprintLoading(false)
      setSprintError(null)
      return
    }
    const previous = sprintRunRef.current
    const refreshChanged = refreshNonce !== previous.refreshNonce
    const sprintChanged = activeSprintId !== previous.activeSprintId
    sprintRunRef.current = { refreshNonce, activeSprintId }
    if (sprintChanged) {
      // A different sprint is a different dataset; nothing is loaded for it yet.
      sprintLoadedRef.current = false
    }
    // Why: a sprint that already has data revalidates behind the rendered board; only
    // an explicit refresh or a different sprint may blank it and show a loader.
    const silent = !refreshChanged && !sprintChanged && sprintLoadedRef.current
    if (!silent) {
      setSprintPageLocal(emptyJiraBoardPage())
      setSprintLoading(true)
    }
    setSprintError(null)
    void (async () => {
      try {
        const next = await readJiraBoardScopePages({
          providerSettings,
          boardId,
          siteId,
          issueScope: { scope: 'sprint', sprintId: activeSprintId },
          targetStartAt: silent ? sprintPageRef.current.startAt : 0
        })
        if (generation === sprintGeneration.current) {
          sprintLoadedRef.current = true
          commitSprintPage(next)
        }
      } catch (error) {
        if (generation === sprintGeneration.current) {
          setSprintError(describeJiraBoardPageError(error))
          if (hasRuntimeRpcErrorCode(error, 'method_not_found')) {
            onRuntimeBoardUnavailable()
          }
        }
      } finally {
        if (generation === sprintGeneration.current) {
          setSprintLoading(false)
        }
      }
    })()
    return () => {
      sprintGeneration.current += 1
    }
  }, [
    activeSprintAvailable,
    activeSprintId,
    boardId,
    commitSprintPage,
    onRuntimeBoardUnavailable,
    providerSettings,
    refreshNonce,
    setSprintPageLocal,
    siteId
  ])

  useEffect(() => {
    const generation = ++backlogGeneration.current
    const previous = backlogRunRef.current
    const refreshChanged = refreshNonce !== previous.refreshNonce
    backlogRunRef.current = { refreshNonce }
    const silent = !refreshChanged && backlogLoadedRef.current
    if (!silent) {
      setBacklogPageLocal(emptyJiraBoardPage())
      setBacklogLoading(true)
    }
    setBacklogError(null)
    void (async () => {
      try {
        const next = await readJiraBoardScopePages({
          providerSettings,
          boardId,
          siteId,
          issueScope: { scope: 'backlog' },
          targetStartAt: silent ? backlogPageRef.current.startAt : 0
        })
        if (generation === backlogGeneration.current) {
          backlogLoadedRef.current = true
          commitBacklogPage(next)
        }
      } catch (error) {
        if (generation === backlogGeneration.current) {
          setBacklogError(describeJiraBoardPageError(error))
          if (hasRuntimeRpcErrorCode(error, 'method_not_found')) {
            onRuntimeBoardUnavailable()
          }
        }
      } finally {
        if (generation === backlogGeneration.current) {
          setBacklogLoading(false)
        }
      }
    })()
    return () => {
      backlogGeneration.current += 1
    }
  }, [
    boardId,
    commitBacklogPage,
    onRuntimeBoardUnavailable,
    providerSettings,
    refreshNonce,
    setBacklogPageLocal,
    siteId
  ])

  const loadMoreSprint = useCallback(async (): Promise<void> => {
    const current = sprintPageRef.current
    if (sprintLoadingMore || current.isLast || !activeSprintId) {
      return
    }
    const generation = sprintGeneration.current
    setSprintLoadingMore(true)
    setSprintError(null)
    try {
      const page = await jiraListBoardIssues(providerSettings, {
        boardId,
        siteId,
        scope: 'sprint',
        sprintId: activeSprintId,
        ...(current.pageToken ? { pageToken: current.pageToken } : {}),
        startAt: current.startAt,
        maxResults: JIRA_BOARD_ISSUE_PAGE_SIZE
      })
      if (generation === sprintGeneration.current) {
        commitSprintPage(appendJiraBoardIssuePage(current, page))
      }
    } catch (error) {
      if (generation === sprintGeneration.current) {
        setSprintError(describeJiraBoardPageError(error))
        if (hasRuntimeRpcErrorCode(error, 'method_not_found')) {
          onRuntimeBoardUnavailable()
        }
      }
    } finally {
      if (generation === sprintGeneration.current) {
        setSprintLoadingMore(false)
      }
    }
  }, [
    activeSprintId,
    boardId,
    commitSprintPage,
    onRuntimeBoardUnavailable,
    providerSettings,
    siteId,
    sprintLoadingMore
  ])

  const loadMoreBacklog = useCallback(async (): Promise<void> => {
    const current = backlogPageRef.current
    if (backlogLoadingMore || current.isLast) {
      return
    }
    const generation = backlogGeneration.current
    setBacklogLoadingMore(true)
    setBacklogError(null)
    try {
      const page = await jiraListBoardIssues(providerSettings, {
        boardId,
        siteId,
        scope: 'backlog',
        ...(current.pageToken ? { pageToken: current.pageToken } : {}),
        startAt: current.startAt,
        maxResults: JIRA_BOARD_ISSUE_PAGE_SIZE
      })
      if (generation === backlogGeneration.current) {
        commitBacklogPage(appendJiraBoardIssuePage(current, page))
      }
    } catch (error) {
      if (generation === backlogGeneration.current) {
        setBacklogError(describeJiraBoardPageError(error))
        if (hasRuntimeRpcErrorCode(error, 'method_not_found')) {
          onRuntimeBoardUnavailable()
        }
      }
    } finally {
      if (generation === backlogGeneration.current) {
        setBacklogLoadingMore(false)
      }
    }
  }, [
    backlogLoadingMore,
    boardId,
    commitBacklogPage,
    onRuntimeBoardUnavailable,
    providerSettings,
    siteId
  ])

  return {
    sprintIssues: sprintPage.issues,
    sprintStartAt: sprintPage.startAt,
    sprintIsLast: sprintPage.isLast,
    sprintLoading,
    sprintLoadingMore,
    sprintError,
    loadMoreSprint,
    backlogIssues: backlogPage.issues,
    backlogStartAt: backlogPage.startAt,
    backlogPageToken: backlogPage.pageToken,
    backlogTotal: backlogPage.total,
    backlogIsLast: backlogPage.isLast,
    backlogLoading,
    backlogLoadingMore,
    backlogError,
    loadMoreBacklog
  }
}
