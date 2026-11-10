/* eslint-disable max-lines -- Why: upstream-owned, and this fork touches it only to clear React
   Compiler bailouts; splitting it would put a fork hunk in the way of the next sync. */
import { runAsyncTaskWithFailure } from '@/lib/async-task-with-cleanup'
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'

import { aiVaultScanErrorText } from './ai-vault-scan-issue-copy'
import type { ExecutionHostScope } from '../../../../../../shared/execution-host'
import type { AiVaultSessionLimit } from '../session-list/ai-vault-session-limit'
import { AiVaultSessionPublicationGate } from './ai-vault-session-publication-gate'
import { EMPTY_AI_VAULT_SESSIONS } from '../session-list/ai-vault-session-identity'
import { useAppliedAiVaultScan } from './ai-vault-applied-scan'
import { useAiVaultSessionHostRefreshEvents } from '../scope/ai-vault-host-scope'
import { aiVaultSessionResultCacheKey } from './ai-vault-session-result-cache'
import {
  refreshAiVaultSessionList,
  type AiVaultConditionalSnapshot,
  cacheAiVaultSessionList,
  readCachedAiVaultSessionList,
  readLastAiVaultSessionList
} from './ai-vault-session-list-request'
import { useAiVaultNewSessionRescan } from './ai-vault-new-session-rescan'
import { saveAiVaultSessionList } from './ai-vault-saved-session-lists'
import { useAiVaultAssociationObservation } from './ai-vault-association-observation'
import { createNonSecureContextUuid as createBrowserUuid } from '../../../../../../shared/non-secure-context-uuid'
import {
  markForcedRescanSpent,
  resetAiVaultForcedRescanThrottleForTest as resetThrottleForTest
} from '../../ai-vault-forced-rescan-throttle'
import { resetAiVaultForcedRescanBudgetForTest } from './ai-vault-forced-rescan-budget'
import type {
  AiVaultListResult,
  AiVaultSession
} from '../../../../../../shared/ai-vault/contracts/ai-vault-types'
import { isAiVaultScanCancelledError } from '../../../../../../shared/ai-vault/contracts/ai-vault-types'

// Why a wrapper: upstream's suites import this name here and its own copy reset upstream's budget;
// the fork's throttle holds the state this hook's manual-refresh mark spends. Both lanes start clean.
export function resetAiVaultForcedRescanThrottleForTest(): void {
  resetAiVaultForcedRescanBudgetForTest()
  resetThrottleForTest()
}

type ConditionalSnapshot = AiVaultConditionalSnapshot & { scopeKey: string }

type AiVaultRefreshArgs = { force?: boolean; background?: boolean; reuseLoadedDepth?: boolean }

export function useAiVaultSessionRefresh(
  scopePaths: readonly string[],
  executionHostScope: ExecutionHostScope,
  sessionLimit: AiVaultSessionLimit,
  scopeOnly = false,
  /**
   * The plain-text filter the host applies, already settled by the panel (see
   * `useAiVaultHostQuery`). Empty means the client filters, and it is part of the
   * scan key because a filtered listing is not the unfiltered one.
   */
  hostQuery = ''
): {
  error: string | null
  loading: boolean
  scopePending: boolean
  refresh: (args?: AiVaultRefreshArgs) => Promise<void>
  scanResult: AiVaultListResult | null
  sessions: readonly AiVaultSession[]
  /** The depth the sessions on screen came from, which trails the selected one during a rescan. */
  loadedSessionLimit: AiVaultSessionLimit | null
} {
  const { scan, applyScan } = useAppliedAiVaultScan()
  const associations = useAiVaultAssociationObservation(executionHostScope)
  const associationsRef = useRef(associations)
  const [loading, setLoading] = useState(false)
  const [failure, setFailure] = useState<{ scopeKey: string; cause: string } | null>(null)
  const [terminalScopeKey, setTerminalScopeKey] = useState<string | null>(null)
  const [requestToken] = useState(() => createBrowserUuid())
  const refreshIdRef = useRef(0)
  const refreshInFlightRef = useRef(false)
  const pendingRefreshRef = useRef(false)
  const pendingForceRef = useRef(false)
  const pendingBackgroundRef = useRef(true)
  const conditionalSnapshotRef = useRef<ConditionalSnapshot | null>(null)
  const mountedRef = useRef(true)
  const [publicationGate] = useState(() => new AiVaultSessionPublicationGate())
  const scanScopeKey = `${aiVaultSessionResultCacheKey(executionHostScope, scopePaths, sessionLimit, hostQuery, scopeOnly)}\n${sessionLimit}`
  // Workspace or Project rows would pass for All's list while it loads or after it fails; the filter narrows the rest.
  const shown = scan?.scopeOnly && !scopeOnly ? null : scan
  // Kept through rescans so a repeat failure doesn't blink; shown only for the scope that failed.
  const error = failure?.scopeKey === scanScopeKey ? aiVaultScanErrorText(failure.cause) : null
  const scopePathsRef = useRef<readonly string[]>(scopePaths)
  const hostQueryRef = useRef(hostQuery)
  const scopeOnlyRef = useRef(scopeOnly)
  const executionHostScopeRef = useRef<ExecutionHostScope>(executionHostScope)
  const sessionLimitRef = useRef(sessionLimit)
  // Keep render pure for React Doctor; layout effect still lands before refresh effects.
  useLayoutEffect(() => {
    sessionLimitRef.current = sessionLimit
    scopeOnlyRef.current = scopeOnly
    associationsRef.current = associations
    scopePathsRef.current = scopePaths
    hostQueryRef.current = hostQuery
    executionHostScopeRef.current = executionHostScope
  }, [associations, executionHostScope, hostQuery, scopePaths, scopeOnly, sessionLimit])
  const currentScanScopeKey = useCallback(
    () =>
      `${aiVaultSessionResultCacheKey(
        executionHostScopeRef.current,
        scopePathsRef.current,
        sessionLimitRef.current,
        hostQueryRef.current,
        scopeOnlyRef.current
      )}\n${sessionLimitRef.current}`,
    []
  )
  const refreshRef = useRef<((args?: AiVaultRefreshArgs) => Promise<void>) | null>(null)
  const refresh = useCallback(
    async (args: AiVaultRefreshArgs = {}): Promise<void> => {
      const observation = associationsRef.current
      const associationRevision = observation.getSnapshot()
      const associationCurrent = () =>
        observation === associationsRef.current && associationRevision === observation.getSnapshot()
      const hostScope = executionHostScopeRef.current
      const selectedLimit = sessionLimitRef.current
      const request = {
        scopePaths: scopePathsRef.current,
        scopeOnly: scopeOnlyRef.current,
        executionHostScope: hostScope,
        sessionLimit: selectedLimit,
        ...(hostQueryRef.current ? { query: hostQueryRef.current } : {})
      }
      const { scopeOnly } = request
      const baseKey = aiVaultSessionResultCacheKey(
        hostScope,
        request.scopePaths,
        selectedLimit,
        request.query,
        scopeOnly
      )
      const scanKey = `${baseKey}\n${selectedLimit}`
      const applyListed = (published: AiVaultListResult, scanned = false) =>
        applyScan(
          { result: published, limit: selectedLimit, scopeKey: scanKey, scopeOnly },
          (applied) => {
            conditionalSnapshotRef.current = published.fingerprint
              ? { scopeKey: scanKey, fingerprint: published.fingerprint, result: applied }
              : null
            // The applied rows keep their identity when a rescan changed nothing, so the save skips.
            if (scanned) {
              void saveAiVaultSessionList(baseKey, selectedLimit, applied)
            }
          }
        )
      const cachedResult =
        args.reuseLoadedDepth === true ? readCachedAiVaultSessionList(request) : null
      if (cachedResult) {
        setFailure(null)
        setTerminalScopeKey(null)
        publicationGate.publish(cachedResult, (published) => {
          if (mountedRef.current && scanKey === currentScanScopeKey() && associationCurrent()) {
            applyListed(published)
          }
        })
        setLoading(false)
      } else if (args.reuseLoadedDepth === true) {
        publicationGate.showUntilPublished(
          readLastAiVaultSessionList(request),
          // Chat links only change which rows are linked; the stale list is replaced by the rescan anyway.
          ({ result, limit }) => {
            if (mountedRef.current && scanKey === currentScanScopeKey()) {
              applyScan({ result, limit, scopeKey: scanKey, scopeOnly, stale: true })
            }
          }
        )
      }
      // Queue scope changes during an in-flight scan so the new view still refreshes.
      if (refreshInFlightRef.current) {
        pendingRefreshRef.current = true
        if (args.force === true) {
          pendingForceRef.current = true
        }
        pendingBackgroundRef.current =
          pendingBackgroundRef.current && (args.background === true || cachedResult !== null)
        if (args.force === true && args.background !== true) {
          void window.api.aiVault
            .cancelListSessions({ requestToken: requestToken })
            .catch((error: unknown) => console.warn('Could not cancel Session History scan', error))
        }
        return
      }

      refreshInFlightRef.current = true
      const refreshId = refreshIdRef.current + 1
      refreshIdRef.current = refreshId
      // Count manual refresh against the throttle to prevent an immediate automatic full scan.
      if (args.force === true) {
        markForcedRescanSpent()
      }
      // Background cache hits must not flash a loading spinner on every refocus.
      if (args.background !== true && !cachedResult) {
        setLoading(true)
      }
      setTerminalScopeKey(null)
      const requestCurrent = () =>
        mountedRef.current &&
        refreshIdRef.current === refreshId &&
        scanKey === currentScanScopeKey() &&
        associationCurrent()
      await runAsyncTaskWithFailure(
        async () => {
          const previous = conditionalSnapshotRef.current
          const result = await refreshAiVaultSessionList(
            request,
            { force: args.force, requestToken: requestToken },
            previous?.scopeKey === scanKey ? previous : undefined
          )
          // Reject superseded or old-scope replies before they can repaint History.
          if (!requestCurrent()) {
            return
          }
          if (result.cancelled) {
            setTerminalScopeKey(scanKey)
            return
          }
          setFailure(null)
          cacheAiVaultSessionList(request, result, { replaceHostEntries: args.force === true })
          publicationGate.publish(result, (published) => {
            if (requestCurrent()) {
              applyListed(published, true)
            }
          })
        },
        (err) => {
          // Cancellation means another shared scan superseded this one; do not replace its incoming list with an error.
          if (requestCurrent()) {
            setTerminalScopeKey(scanKey)
            if (!isAiVaultScanCancelledError(err)) {
              setFailure({
                scopeKey: scanKey,
                cause: err instanceof Error ? err.message : String(err)
              })
            }
          }
        },
        () => {
          refreshInFlightRef.current = false
          if (mountedRef.current && refreshIdRef.current === refreshId) {
            setLoading(false)
          }
          if (pendingRefreshRef.current && mountedRef.current) {
            pendingRefreshRef.current = false
            const force = pendingForceRef.current
            // The queued refresh is background-only if every queued caller was.
            const background = pendingBackgroundRef.current
            pendingForceRef.current = false
            pendingBackgroundRef.current = true
            void refreshRef.current?.({ force, background })
          }
        }
      )
      // Read changing scope through refs; recursion requires a stable refresh identity.
    },
    [applyScan, currentScanScopeKey, publicationGate, requestToken]
  )
  useLayoutEffect(() => {
    refreshRef.current = refresh
  }, [refresh])

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      publicationGate.cancel()
      pendingRefreshRef.current = false
      pendingForceRef.current = false
      pendingBackgroundRef.current = true
      refreshIdRef.current += 1
      refreshInFlightRef.current = false
      void window.api.aiVault.cancelListSessions({
        requestToken
      })
    }
  }, [publicationGate, requestToken])

  // Panel entry reuses the renderer result, else paints the last list while the host answers.
  useEffect(() => {
    publicationGate.cancel()
    pendingRefreshRef.current = false
    pendingForceRef.current = false
    pendingBackgroundRef.current = true
    if (refreshInFlightRef.current) {
      void window.api.aiVault.cancelListSessions({
        requestToken: requestToken
      })
    }
    void refresh({ force: false, reuseLoadedDepth: true })
  }, [associations, executionHostScope, publicationGate, refresh, requestToken, scanScopeKey])

  useEffect(
    () =>
      associations.subscribe(() => {
        publicationGate.cancel()
        conditionalSnapshotRef.current = null
        void refresh({ background: true, force: false })
      }),
    [associations, publicationGate, refresh]
  )

  // Retry prior relay-readiness errors on host events; otherwise startup/reconnect failures can persist indefinitely.
  useAiVaultSessionHostRefreshEvents(error, refresh)

  useAiVaultNewSessionRescan(refresh)

  // A stale list keeps the scope pending, so it shows as refreshing until the rescan answers.
  const scopePending =
    (scan?.scopeKey !== scanScopeKey || scan?.stale === true) && terminalScopeKey !== scanScopeKey
  return {
    error,
    loading: loading || scopePending,
    scopePending,
    refresh,
    scanResult: shown?.result ?? null,
    sessions: shown?.result.sessions ?? EMPTY_AI_VAULT_SESSIONS,
    loadedSessionLimit: shown?.limit ?? null
  }
}
