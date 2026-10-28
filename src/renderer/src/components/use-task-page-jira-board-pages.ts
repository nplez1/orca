import { useCallback, useEffect, useRef, useState } from 'react'
import type { RuntimeJiraSettings } from '@/runtime/runtime-jira-client'
import { hasRuntimeRpcErrorCode } from '@/runtime/runtime-rpc-client'
import {
  patchTaskPageJiraBoardCache,
  taskPageJiraBoardCacheKey,
  type TaskPageJiraBoardCacheEntry,
  type TaskPageJiraBoardCachedPage
} from './task-page-jira-board-cache'
import {
  describeJiraBoardPageError,
  emptyJiraBoardPage,
  loadMoreJiraBoardPage,
  readJiraBoardScopePages
} from './task-page-jira-board-page-fetch'
import { useJiraBoardIssuePatch } from './use-jira-board-issue-patch'

export function useTaskPageJiraBoardPages(args: {
  providerSettings: RuntimeJiraSettings
  boardId: string
  siteId: string
  activeSprintId: string
  activeSprintAvailable: boolean
  refreshNonce: number
  /** Whether the refresh behind `refreshNonce` may blank the rendered page. */
  refreshSilent: boolean
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
    refreshSilent,
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
  // Why a flag of its own: an empty sprint that is loaded and one that was just cleared
  // both have no issues, and only the second may show a loader over them.
  const [sprintBlanked, setSprintBlanked] = useState(false)
  const [sprintLoadingMore, setSprintLoadingMore] = useState(false)
  const [sprintError, setSprintError] = useState<string | null>(null)
  const [backlogPage, setBacklogPage] = useState<TaskPageJiraBoardCachedPage>(
    () => initialCache?.backlog ?? emptyJiraBoardPage()
  )
  const [backlogLoading, setBacklogLoading] = useState(false)
  const [backlogBlanked, setBacklogBlanked] = useState(false)
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

  // Local-only pending patch; the hook documents why it is never cached.
  const patchBoardIssue = useJiraBoardIssuePatch({
    sprintPageRef,
    backlogPageRef,
    setSprintPageLocal,
    setBacklogPageLocal
  })

  useEffect(() => {
    const generation = ++sprintGeneration.current
    if (!activeSprintAvailable || !activeSprintId) {
      // Why: local only — a placeholder must not be cached as a confidently-empty sprint.
      setSprintPageLocal(emptyJiraBoardPage())
      sprintLoadedRef.current = false
      setSprintLoading(false)
      setSprintBlanked(false)
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
    const silent = !(refreshChanged && !refreshSilent) && !sprintChanged && sprintLoadedRef.current
    if (!silent) {
      setSprintPageLocal(emptyJiraBoardPage())
    }
    // Why not inside the blanking branch: the read is in flight either way, and that is all
    // the header's indicator needs; the loader belongs to a page that was actually cleared.
    setSprintLoading(true)
    setSprintBlanked(!silent)
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
          setSprintBlanked(false)
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
    refreshSilent,
    setSprintPageLocal,
    siteId
  ])

  useEffect(() => {
    const generation = ++backlogGeneration.current
    const previous = backlogRunRef.current
    const refreshChanged = refreshNonce !== previous.refreshNonce
    backlogRunRef.current = { refreshNonce }
    const silent = !(refreshChanged && !refreshSilent) && backlogLoadedRef.current
    if (!silent) {
      setBacklogPageLocal(emptyJiraBoardPage())
    }
    setBacklogLoading(true)
    setBacklogBlanked(!silent)
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
          setBacklogBlanked(false)
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
    refreshSilent,
    setBacklogPageLocal,
    siteId
  ])

  const loadMoreSprint = useCallback(async (): Promise<void> => {
    const current = sprintPageRef.current
    // Why the loading guards: a read in flight owns the page, so a page appended over it
    // would write a pre-reload snapshot back — the reload's own answer would be lost.
    if (sprintLoadingMore || sprintLoading || current.isLast || !activeSprintId) {
      return
    }
    await loadMoreJiraBoardPage({
      providerSettings,
      boardId,
      siteId,
      issueScope: { scope: 'sprint', sprintId: activeSprintId },
      current,
      generation: sprintGeneration.current,
      generationRef: sprintGeneration,
      commit: commitSprintPage,
      setError: setSprintError,
      setLoadingMore: setSprintLoadingMore,
      onRuntimeBoardUnavailable
    })
  }, [
    activeSprintId,
    boardId,
    commitSprintPage,
    onRuntimeBoardUnavailable,
    providerSettings,
    siteId,
    sprintLoading,
    sprintLoadingMore
  ])

  const loadMoreBacklog = useCallback(async (): Promise<void> => {
    const current = backlogPageRef.current
    if (backlogLoadingMore || backlogLoading || current.isLast) {
      return
    }
    await loadMoreJiraBoardPage({
      providerSettings,
      boardId,
      siteId,
      issueScope: { scope: 'backlog' },
      current,
      generation: backlogGeneration.current,
      generationRef: backlogGeneration,
      commit: commitBacklogPage,
      setError: setBacklogError,
      setLoadingMore: setBacklogLoadingMore,
      onRuntimeBoardUnavailable
    })
  }, [
    backlogLoading,
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
    sprintBlanked,
    sprintLoadingMore,
    sprintError,
    loadMoreSprint,
    backlogIssues: backlogPage.issues,
    backlogStartAt: backlogPage.startAt,
    backlogPageToken: backlogPage.pageToken,
    backlogTotal: backlogPage.total,
    backlogIsLast: backlogPage.isLast,
    backlogLoading,
    backlogBlanked,
    backlogLoadingMore,
    backlogError,
    loadMoreBacklog,
    patchBoardIssue
  }
}
