import { useCallback, useEffect, useRef, useState } from 'react'
import type { JiraBoardSelection, JiraIssue } from '../../../shared/jira-types'
import { applyBacklogIssuePage, applySprintIssuePage } from './task-page-jira-board-page-state'
import type { RuntimeJiraSettings } from '@/runtime/runtime-jira-client'
import { hasRuntimeRpcErrorCode } from '@/runtime/runtime-rpc-client'
import { jiraListBoardIssues } from '@/runtime/runtime-jira-client'

const JIRA_BOARD_ISSUE_PAGE_SIZE = 100

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : 'Unable to load this Jira board.'
}

export function useTaskPageJiraBoardPages(args: {
  providerSettings: RuntimeJiraSettings
  selection: JiraBoardSelection
  activeSprintId: string
  activeSprintAvailable: boolean
  teamFieldId: string
  refreshNonce: number
  onRuntimeBoardUnavailable: () => void
}) {
  const {
    providerSettings,
    selection,
    activeSprintId,
    activeSprintAvailable,
    teamFieldId,
    refreshNonce,
    onRuntimeBoardUnavailable
  } = args
  const [sprintIssues, setSprintIssues] = useState<JiraIssue[]>([])
  const [sprintStartAt, setSprintStartAt] = useState(0)
  const [sprintPageToken, setSprintPageToken] = useState<string | null>(null)
  const [sprintIsLast, setSprintIsLast] = useState(true)
  const [sprintLoading, setSprintLoading] = useState(false)
  const [sprintLoadingMore, setSprintLoadingMore] = useState(false)
  const [sprintError, setSprintError] = useState<string | null>(null)
  const [backlogIssues, setBacklogIssues] = useState<JiraIssue[]>([])
  const [backlogStartAt, setBacklogStartAt] = useState(0)
  const [backlogPageToken, setBacklogPageToken] = useState<string | null>(null)
  const [backlogTotal, setBacklogTotal] = useState<number | null>(null)
  const [backlogIsLast, setBacklogIsLast] = useState(true)
  const [backlogLoading, setBacklogLoading] = useState(false)
  const [backlogLoadingMore, setBacklogLoadingMore] = useState(false)
  const [backlogError, setBacklogError] = useState<string | null>(null)
  const sprintGeneration = useRef(0)
  const backlogGeneration = useRef(0)

  useEffect(() => {
    let cancelled = false
    const generation = ++sprintGeneration.current
    if (!activeSprintAvailable || !activeSprintId) {
      setSprintIssues([])
      setSprintStartAt(0)
      setSprintPageToken(null)
      setSprintIsLast(true)
      setSprintLoading(false)
      setSprintError(null)
      return
    }
    setSprintIssues([])
    setSprintStartAt(0)
    setSprintPageToken(null)
    setSprintIsLast(true)
    setSprintLoading(true)
    setSprintError(null)
    void jiraListBoardIssues(providerSettings, {
      boardId: selection.boardId,
      siteId: selection.siteId,
      scope: 'sprint',
      sprintId: activeSprintId,
      teamFieldId: teamFieldId || undefined,
      startAt: 0,
      maxResults: JIRA_BOARD_ISSUE_PAGE_SIZE
    })
      .then((page) => {
        if (!cancelled && generation === sprintGeneration.current) {
          applySprintIssuePage(
            page,
            setSprintIssues,
            setSprintStartAt,
            setSprintPageToken,
            setSprintIsLast
          )
        }
      })
      .catch((error: unknown) => {
        if (!cancelled && generation === sprintGeneration.current) {
          setSprintError(describeError(error))
          if (hasRuntimeRpcErrorCode(error, 'method_not_found')) {
            onRuntimeBoardUnavailable()
          }
        }
      })
      .finally(() => {
        if (!cancelled && generation === sprintGeneration.current) {
          setSprintLoading(false)
        }
      })
    return () => {
      cancelled = true
      sprintGeneration.current += 1
    }
  }, [
    activeSprintAvailable,
    activeSprintId,
    onRuntimeBoardUnavailable,
    providerSettings,
    refreshNonce,
    selection.boardId,
    selection.siteId,
    teamFieldId
  ])

  useEffect(() => {
    let cancelled = false
    const generation = ++backlogGeneration.current
    setBacklogIssues([])
    setBacklogStartAt(0)
    setBacklogPageToken(null)
    setBacklogTotal(null)
    setBacklogIsLast(true)
    setBacklogLoading(true)
    setBacklogError(null)
    void jiraListBoardIssues(providerSettings, {
      boardId: selection.boardId,
      siteId: selection.siteId,
      scope: 'backlog',
      teamFieldId: teamFieldId || undefined,
      startAt: 0,
      maxResults: JIRA_BOARD_ISSUE_PAGE_SIZE
    })
      .then((page) => {
        if (!cancelled && generation === backlogGeneration.current) {
          applyBacklogIssuePage(
            page,
            false,
            setBacklogIssues,
            setBacklogStartAt,
            setBacklogPageToken,
            setBacklogTotal,
            setBacklogIsLast
          )
        }
      })
      .catch((error: unknown) => {
        if (!cancelled && generation === backlogGeneration.current) {
          setBacklogError(describeError(error))
          if (hasRuntimeRpcErrorCode(error, 'method_not_found')) {
            onRuntimeBoardUnavailable()
          }
        }
      })
      .finally(() => {
        if (!cancelled && generation === backlogGeneration.current) {
          setBacklogLoading(false)
        }
      })
    return () => {
      cancelled = true
      backlogGeneration.current += 1
    }
  }, [
    onRuntimeBoardUnavailable,
    providerSettings,
    refreshNonce,
    selection.boardId,
    selection.siteId,
    teamFieldId
  ])

  const loadMoreSprint = useCallback(async (): Promise<void> => {
    if (sprintLoadingMore || sprintIsLast || !activeSprintId) {
      return
    }
    const generation = sprintGeneration.current
    setSprintLoadingMore(true)
    setSprintError(null)
    try {
      const page = await jiraListBoardIssues(providerSettings, {
        boardId: selection.boardId,
        siteId: selection.siteId,
        scope: 'sprint',
        sprintId: activeSprintId,
        teamFieldId: teamFieldId || undefined,
        pageToken: sprintPageToken ?? undefined,
        startAt: sprintStartAt,
        maxResults: JIRA_BOARD_ISSUE_PAGE_SIZE
      })
      if (generation === sprintGeneration.current) {
        applySprintIssuePage(
          page,
          setSprintIssues,
          setSprintStartAt,
          setSprintPageToken,
          setSprintIsLast,
          true
        )
      }
    } catch (error) {
      if (generation === sprintGeneration.current) {
        setSprintError(describeError(error))
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
    onRuntimeBoardUnavailable,
    providerSettings,
    selection.boardId,
    selection.siteId,
    sprintIsLast,
    sprintLoadingMore,
    sprintPageToken,
    sprintStartAt,
    teamFieldId
  ])

  const loadMoreBacklog = useCallback(async (): Promise<void> => {
    if (backlogLoadingMore || backlogIsLast) {
      return
    }
    const generation = backlogGeneration.current
    setBacklogLoadingMore(true)
    setBacklogError(null)
    try {
      const page = await jiraListBoardIssues(providerSettings, {
        boardId: selection.boardId,
        siteId: selection.siteId,
        scope: 'backlog',
        teamFieldId: teamFieldId || undefined,
        pageToken: backlogPageToken ?? undefined,
        startAt: backlogStartAt,
        maxResults: JIRA_BOARD_ISSUE_PAGE_SIZE
      })
      if (generation === backlogGeneration.current) {
        applyBacklogIssuePage(
          page,
          true,
          setBacklogIssues,
          setBacklogStartAt,
          setBacklogPageToken,
          setBacklogTotal,
          setBacklogIsLast
        )
      }
    } catch (error) {
      if (generation === backlogGeneration.current) {
        setBacklogError(describeError(error))
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
    backlogIsLast,
    backlogLoadingMore,
    backlogPageToken,
    backlogStartAt,
    onRuntimeBoardUnavailable,
    providerSettings,
    selection.boardId,
    selection.siteId,
    teamFieldId
  ])

  return {
    sprintIssues,
    sprintStartAt,
    sprintIsLast,
    sprintLoading,
    sprintLoadingMore,
    sprintError,
    loadMoreSprint,
    backlogIssues,
    backlogStartAt,
    backlogPageToken,
    backlogTotal,
    backlogIsLast,
    backlogLoading,
    backlogLoadingMore,
    backlogError,
    loadMoreBacklog
  }
}
