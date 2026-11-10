/* eslint-disable max-lines -- Why: upstream-owned, and this fork touches it only to clear React
   Compiler bailouts; splitting it would put a fork hunk in the way of the next sync. */
import { runAsyncTaskWithFailure } from '@/lib/async-task-with-cleanup'
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'

import { aiVaultScanErrorText } from './ai-vault-scan-issue-copy'
import type { ExecutionHostScope } from '../../../../../../shared/execution-host'
import { useAppStore } from '@/store/index'
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
  readCachedAiVaultSessionList
} from './ai-vault-session-list-request'
import { getAgentSessionIdsKey } from './ai-vault-agent-session-refresh-key'
import { useAiVaultAssociationObservation } from './ai-vault-association-observation'
import { createNonSecureContextUuid as createBrowserUuid } from '../../../../../../shared/non-secure-context-uuid'

// Share the forced-rescan budget across remounts so session creation cannot amplify full scans.
import {
  claimAiVaultForcedRescan,
  forcedRescanRetryDelayMs,
  markForcedRescanSpent
} from '../../ai-vault-forced-rescan-throttle'
import type {
  AiVaultListResult,
  AiVaultSession
} from '../../../../../../shared/ai-vault/contracts/ai-vault-types'
import { isAiVaultScanCancelledError } from '../../../../../../shared/ai-vault/contracts/ai-vault-types'

// Why re-exported: upstream defines this test hook in this module and its suites import it here; the
// fork keeps the throttle in its own module, so the name stays reachable from where upstream's tests
// look for it.
export { resetAiVaultForcedRescanThrottleForTest } from '../../ai-vault-forced-rescan-throttle'

type ConditionalSnapshot = AiVaultConditionalSnapshot & { scopeKey: string }

type AiVaultRefreshArgs = { force?: boolean; background?: boolean; reuseLoadedDepth?: boolean }

export function useAiVaultSessionRefresh(
  scopePaths: readonly string[],
  executionHostScope: ExecutionHostScope,
  sessionLimit: AiVaultSessionLimit,
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
  const scanResult = scan?.result ?? null
  const sessions = scanResult?.sessions ?? EMPTY_AI_VAULT_SESSIONS
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
  const scanScopeKey = `${aiVaultSessionResultCacheKey(executionHostScope, scopePaths, sessionLimit, hostQuery)}\n${sessionLimit}`
  // Kept through rescans so a repeat failure doesn't blink; shown only for the scope that failed.
  const error = failure?.scopeKey === scanScopeKey ? aiVaultScanErrorText(failure.cause) : null
  const scopePathsRef = useRef<readonly string[]>(scopePaths)
  const hostQueryRef = useRef(hostQuery)
  const executionHostScopeRef = useRef<ExecutionHostScope>(executionHostScope)
  const sessionLimitRef = useRef(sessionLimit)
  // Keep render pure for React Doctor; layout effect still lands before refresh effects.
  useLayoutEffect(() => {
    sessionLimitRef.current = sessionLimit
    associationsRef.current = associations
    scopePathsRef.current = scopePaths
    hostQueryRef.current = hostQuery
    executionHostScopeRef.current = executionHostScope
  }, [associations, executionHostScope, hostQuery, scopePaths, sessionLimit])
  const currentScanScopeKey = useCallback(
    () =>
      `${aiVaultSessionResultCacheKey(
        executionHostScopeRef.current,
        scopePathsRef.current,
        sessionLimitRef.current,
        hostQueryRef.current
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
      const cachedResult =
        args.reuseLoadedDepth === true
          ? readCachedAiVaultSessionList({
              scopePaths: scopePathsRef.current,
              executionHostScope: hostScope,
              sessionLimit: selectedLimit,
              ...(hostQueryRef.current ? { query: hostQueryRef.current } : {})
            })
          : null
      if (cachedResult) {
        const scanKey = currentScanScopeKey()
        setFailure(null)
        setTerminalScopeKey(null)
        publicationGate.publish(cachedResult, (published) => {
          if (!mountedRef.current || scanKey !== currentScanScopeKey() || !associationCurrent()) {
            return
          }
          applyScan(published, selectedLimit, scanKey, (applied) => {
            conditionalSnapshotRef.current = published.fingerprint
              ? { scopeKey: scanKey, fingerprint: published.fingerprint, result: applied }
              : null
          })
        })
        setLoading(false)
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
      const scanKey = currentScanScopeKey()
      const requestCurrent = () =>
        mountedRef.current &&
        refreshIdRef.current === refreshId &&
        scanKey === currentScanScopeKey() &&
        associationCurrent()
      const request = {
        scopePaths: scopePathsRef.current,
        executionHostScope: hostScope,
        sessionLimit: selectedLimit,
        ...(hostQueryRef.current ? { query: hostQueryRef.current } : {})
      }
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
              applyScan(published, selectedLimit, scanKey, (applied) => {
                conditionalSnapshotRef.current = published.fingerprint
                  ? { scopeKey: scanKey, fingerprint: published.fingerprint, result: applied }
                  : null
              })
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
  // Defer throttled new-session rescans until budget frees so sessions cannot remain invisible indefinitely.
  const forcedRescanTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const requestForcedRescanRef = useRef<(() => void) | null>(null)
  const requestForcedRescan = useCallback(() => {
    if (claimAiVaultForcedRescan()) {
      void refresh({ background: true, force: true })
      return
    }
    const waitMs = forcedRescanRetryDelayMs()
    if (forcedRescanTimerRef.current !== null) {
      return
    }
    forcedRescanTimerRef.current = setTimeout(() => {
      forcedRescanTimerRef.current = null
      requestForcedRescanRef.current?.()
    }, waitMs)
  }, [refresh])
  useLayoutEffect(() => {
    refreshRef.current = refresh
    requestForcedRescanRef.current = requestForcedRescan
  }, [refresh, requestForcedRescan])

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
      if (forcedRescanTimerRef.current !== null) {
        clearTimeout(forcedRescanTimerRef.current)
        forcedRescanTimerRef.current = null
      }
    }
  }, [publicationGate, requestToken])

  // Panel entry reuses the renderer result first, then the host scan cache.
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

  // In-app launches never blur; rescan on new provider session IDs, avoiding frequent state transitions.
  const agentSessionIdsKey = useAppStore((s) => getAgentSessionIdsKey(s.agentStatusByPaneKey))
  const seenAgentSessionIdsRef = useRef<Set<string> | null>(null)
  useEffect(() => {
    const ids = agentSessionIdsKey === '' ? [] : agentSessionIdsKey.split('\n')
    // The mount refresh already covers sessions live at mount time.
    if (seenAgentSessionIdsRef.current === null) {
      seenAgentSessionIdsRef.current = new Set(ids)
      return
    }
    const seen = seenAgentSessionIdsRef.current
    const freshIds = ids.filter((id) => !seen.has(id))
    if (freshIds.length === 0) {
      return
    }
    for (const id of freshIds) {
      seen.add(id)
    }
    requestForcedRescan()
  }, [agentSessionIdsKey, requestForcedRescan])

  const scopePending = scan?.scopeKey !== scanScopeKey && terminalScopeKey !== scanScopeKey
  return {
    error,
    loading: loading || scopePending,
    scopePending,
    refresh,
    scanResult,
    sessions,
    loadedSessionLimit: scan?.limit ?? null
  }
}
