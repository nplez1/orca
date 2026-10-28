import React, { useCallback, useEffect, useRef, useState } from 'react'
import { useAppStore } from '@/store'
import { useActiveWorktree } from '@/store/selectors'
import type { GitLabProjectRef } from '../../../../../shared/gitlab-types'
import type { PRCheckDetail, PRCheckRunDetails } from '../../../../../shared/github/check-types'
import type { GitHubRepositoryIdentity } from '../../../../../shared/github/pull-request-types'
import { sortChecksBySeverity } from '../../../../../shared/pr-check-severity-order'
import { summarizeProviderChecks } from '../../../../../shared/provider-check-summary'
import { createCheckRunDetailsRequestId } from '@/components/editor/check-run-details-tab'
import { checkDetailsErrorAction } from '@/lib/check-details-error-action'
import { translate } from '@/i18n/i18n'
import { useCheckDetailsResize } from '../check-details-resize'
import {
  type CheckDetailsLoadState,
  type CheckDetailsStickySurface,
  getCheckDetailsKey,
  isFailedCheck
} from './check-details-model'
import {
  checkDetailsNeedRefresh,
  checkDetailsRowState,
  readCachedCheckDetails,
  rememberCheckDetails
} from '@/components/github/check-details-cache'

export type ChecksListProps = {
  checks: PRCheckDetail[]
  /** Set when the last read failed; replaces the empty-list copy. */
  checksError?: string | null
  checksLoading: boolean
  checkDetailsContextKey: string
  onLoadCheckDetails?: (check: PRCheckDetail) => Promise<PRCheckRunDetails | null>
  worktreeId?: string
  detailsStickySurface?: CheckDetailsStickySurface
  getGitLabProjectRef?: () => GitLabProjectRef | null
  githubRepository?: GitHubRepositoryIdentity | null
}

export function useChecksListState({
  checks,
  checkDetailsContextKey,
  onLoadCheckDetails,
  worktreeId: worktreeIdOverride,
  getGitLabProjectRef,
  githubRepository
}: ChecksListProps) {
  const activeWorktree = useActiveWorktree()
  const resolvedWorktreeId = worktreeIdOverride ?? activeWorktree?.id ?? null
  const patchOpenCheckRunDetails = useAppStore((s) => s.patchOpenCheckRunDetails)
  const [checksExpanded, setChecksExpanded] = useState(true)
  const [expandedCheckKeys, setExpandedCheckKeys] = useState<Set<string>>(new Set())
  const [detailsByCheckKey, setDetailsByCheckKey] = useState<Record<string, CheckDetailsLoadState>>(
    {}
  )
  const detailsContextRef = useRef(checkDetailsContextKey)
  const autoExpandedContextRef = useRef<string | null>(null)
  // Expanded details use the sidebar scroller; constraining the list too would create nested scrollbars.
  const shouldConstrainCheckList = checksExpanded && expandedCheckKeys.size === 0
  const { detailsHeight, handleResizeStart } = useCheckDetailsResize(
    shouldConstrainCheckList && checks.length > 0
  )
  detailsContextRef.current = checkDetailsContextKey
  const sorted = React.useMemo(() => sortChecksBySeverity(checks), [checks])
  const rows = React.useMemo(
    () =>
      sorted.map((check, index) => ({
        check,
        key: getCheckDetailsKey(checkDetailsContextKey, check, index)
      })),
    [checkDetailsContextKey, sorted]
  )
  // Share the pill's classifier for skipped passes and completed-without-verdict unresolved checks.
  const {
    passed: passingCount,
    failed: failingCount,
    pending: pendingCount,
    neutral: neutralCount
  } = summarizeProviderChecks(checks)

  useEffect(() => {
    const validKeys = new Set(rows.map((row) => row.key))
    setDetailsByCheckKey((current) => {
      const next: Record<string, CheckDetailsLoadState> = {}
      for (const [key, state] of Object.entries(current)) {
        if (validKeys.has(key)) {
          next[key] = state
        }
      }
      return next
    })
    // Close the one-shot latch outside the updater; React may run an updater twice.
    let autoExpandKey: string | undefined
    if (autoExpandedContextRef.current !== checkDetailsContextKey) {
      autoExpandKey = rows.find((row) => isFailedCheck(row.check))?.key
      autoExpandedContextRef.current = checkDetailsContextKey
    }
    setExpandedCheckKeys((current) => {
      const next = new Set([...current].filter((key) => validKeys.has(key)))
      if (autoExpandKey !== undefined) {
        next.add(autoExpandKey)
      }
      return next
    })
  }, [checkDetailsContextKey, rows])

  const requestCheckDetails = useCallback(
    (row: { check: PRCheckDetail; key: string }) => {
      if (detailsByCheckKey[row.key]?.loading) {
        return
      }
      const readFor = checkDetailsRowState(row.check)
      if (
        !row.check.checkRunId &&
        !row.check.workflowRunId &&
        !row.check.url &&
        !row.check.gitlabJobId
      ) {
        setDetailsByCheckKey((current) => ({
          ...current,
          [row.key]: {
            loading: false,
            details: null,
            error: translate(
              'auto.components.right.sidebar.checks.panel.content.e15a8b77ef',
              'No inline details are available for this check.'
            ),
            errorAction: null,
            readAt: Date.now(),
            readFor
          }
        }))
        return
      }
      if (!onLoadCheckDetails) {
        setDetailsByCheckKey((current) => ({
          ...current,
          [row.key]: {
            loading: false,
            details: null,
            error: translate(
              'auto.components.right.sidebar.checks.panel.content.e15a8b77ef',
              'No inline details are available for this check.'
            ),
            errorAction: null,
            readAt: Date.now(),
            readFor
          }
        }))
        return
      }
      const requestContextKey = checkDetailsContextKey
      const requestId = createCheckRunDetailsRequestId()
      const retryError = detailsByCheckKey[row.key]?.error ?? null
      const retryErrorAction = detailsByCheckKey[row.key]?.errorAction ?? null
      // Why: a refresh keeps the rows already on screen — the spinner belongs to the first read —
      // and a payload another mount read for this same build is as good as one of our own.
      const cached = readCachedCheckDetails(row.check)
      const previous = detailsByCheckKey[row.key]
      const carried = previous?.details
        ? { details: previous.details, readAt: previous.readAt, readFor: previous.readFor }
        : cached?.data
          ? { details: cached.data, readAt: cached.fetchedAt, readFor: cached.readFor }
          : { details: null }
      setDetailsByCheckKey((current) => ({
        ...current,
        [row.key]: {
          requestId,
          loading: true,
          ...carried,
          error: retryError,
          errorAction: retryErrorAction
        }
      }))
      if (resolvedWorktreeId) {
        patchOpenCheckRunDetails(resolvedWorktreeId, requestContextKey, row.check, {
          requestId,
          details: carried.details ?? null,
          loading: true,
          error: retryError,
          errorAction: retryErrorAction,
          githubRepository: githubRepository ?? null,
          gitlabProjectRef: getGitLabProjectRef?.() ?? null
        })
      }
      const request = Promise.resolve().then(() => onLoadCheckDetails(row.check))
      void request
        .then((details) => {
          const readAt = Date.now()
          if (details) {
            rememberCheckDetails(row.check, { data: details, fetchedAt: readAt, readFor })
          }
          if (resolvedWorktreeId) {
            patchOpenCheckRunDetails(resolvedWorktreeId, requestContextKey, row.check, {
              requestId,
              details,
              loading: false,
              error: details
                ? null
                : translate(
                    'auto.components.right.sidebar.checks.panel.content.e15a8b77ef',
                    'No inline details are available for this check.'
                  ),
              errorAction: null,
              githubRepository: githubRepository ?? null,
              gitlabProjectRef: getGitLabProjectRef?.() ?? null
            })
          }
          if (detailsContextRef.current !== requestContextKey) {
            return
          }
          setDetailsByCheckKey((current) => {
            if (current[row.key]?.requestId !== requestId) {
              return current
            }
            return {
              ...current,
              [row.key]: {
                requestId,
                loading: false,
                details,
                error: details
                  ? null
                  : translate(
                      'auto.components.right.sidebar.checks.panel.content.e15a8b77ef',
                      'No inline details are available for this check.'
                    ),
                errorAction: null,
                readAt,
                readFor
              }
            }
          })
        })
        .catch((err) => {
          const error =
            err instanceof Error
              ? err.message
              : translate(
                  'auto.components.right.sidebar.checks.panel.content.e45324fbed',
                  'Failed to load check details.'
                )
          const errorAction = checkDetailsErrorAction(err)
          if (resolvedWorktreeId) {
            patchOpenCheckRunDetails(resolvedWorktreeId, requestContextKey, row.check, {
              requestId,
              details: carried.details ?? null,
              loading: false,
              error,
              errorAction,
              githubRepository: githubRepository ?? null,
              gitlabProjectRef: getGitLabProjectRef?.() ?? null
            })
          }
          if (detailsContextRef.current !== requestContextKey) {
            return
          }
          setDetailsByCheckKey((current) => {
            if (current[row.key]?.requestId !== requestId) {
              return current
            }
            return {
              ...current,
              [row.key]: {
                requestId,
                loading: false,
                // Why: a failed refresh reports itself beside the rows it has; a first read has none.
                details: current[row.key]?.details ?? null,
                error,
                errorAction,
                readAt: Date.now(),
                readFor
              }
            }
          })
        })
    },
    [
      checkDetailsContextKey,
      detailsByCheckKey,
      getGitLabProjectRef,
      githubRepository,
      onLoadCheckDetails,
      patchOpenCheckRunDetails,
      resolvedWorktreeId
    ]
  )

  useEffect(() => {
    if (!checksExpanded) {
      return
    }
    for (const row of rows) {
      if (
        expandedCheckKeys.has(row.key) &&
        checkDetailsNeedRefresh(detailsByCheckKey[row.key], row.check)
      ) {
        requestCheckDetails(row)
      }
    }
  }, [checksExpanded, detailsByCheckKey, expandedCheckKeys, requestCheckDetails, rows])

  useEffect(() => {
    if (!resolvedWorktreeId) {
      return
    }
    for (const row of rows) {
      const detailsState = detailsByCheckKey[row.key]
      if (!detailsState) {
        continue
      }
      patchOpenCheckRunDetails(resolvedWorktreeId, checkDetailsContextKey, row.check, {
        requestId: detailsState.requestId,
        details: detailsState.details ?? null,
        loading: detailsState.loading ?? false,
        error: detailsState.error ?? null,
        errorAction: detailsState.errorAction ?? null,
        githubRepository: githubRepository ?? null,
        gitlabProjectRef: getGitLabProjectRef?.() ?? null
      })
    }
  }, [
    checkDetailsContextKey,
    detailsByCheckKey,
    getGitLabProjectRef,
    githubRepository,
    patchOpenCheckRunDetails,
    resolvedWorktreeId,
    rows
  ])

  const toggleCheckExpanded = useCallback(
    (row: { check: PRCheckDetail; key: string }) => {
      const willExpand = !expandedCheckKeys.has(row.key)
      setExpandedCheckKeys((current) => {
        const next = new Set(current)
        if (next.has(row.key)) {
          next.delete(row.key)
        } else {
          next.add(row.key)
        }
        return next
      })
      if (willExpand && checkDetailsNeedRefresh(detailsByCheckKey[row.key], row.check)) {
        requestCheckDetails(row)
      }
    },
    [detailsByCheckKey, expandedCheckKeys, requestCheckDetails]
  )
  return {
    resolvedWorktreeId,
    checksExpanded,
    setChecksExpanded,
    expandedCheckKeys,
    detailsByCheckKey,
    shouldConstrainCheckList,
    detailsHeight,
    handleResizeStart,
    rows,
    passingCount,
    failingCount,
    pendingCount,
    neutralCount,
    toggleCheckExpanded,
    requestCheckDetails
  }
}
