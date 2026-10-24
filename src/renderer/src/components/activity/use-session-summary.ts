import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  SessionSummarySessionRef,
  SessionSummarySnapshot
} from '../../../../shared/session-summary-types'

/**
 * How old a brief may be before re-entering the pane folds again.
 *
 * Why a window at all: switching back to the tab is a weak signal — usually the reader wants the
 * brief they left, not another model call. Five minutes is the point past which "you just
 * looked" stops being true.
 */
const REVALIDATE_WITHIN_MS = 5 * 60_000

/**
 * How often a *visible* pane refreshes itself while the agent keeps working.
 *
 * Why not on every chunk: a fold costs a model call, and the feature is lazy by construction.
 * Hourly is slow enough to be unobtrusive, and the manual button covers everything faster.
 */
export const SESSION_SUMMARY_AUTO_REFRESH_MS = 60 * 60_000

export type SessionSummaryView = {
  snapshot: SessionSummarySnapshot | null
  /** Fold unconditionally — the pane's refresh button. */
  refresh: () => void
  refreshing: boolean
}

/**
 * Summary data for a pane. The fold only runs while `open` is true — open() starts it, the
 * unmount/close path cancels it — so this hook is the "user is looking" signal the service
 * keys its work on.
 */
export function useSessionSummary(
  paneKey: string,
  open: boolean,
  executionHostId?: string | null,
  session?: SessionSummarySessionRef | null
): SessionSummaryView {
  const [snapshot, setSnapshot] = useState<SessionSummarySnapshot | null>(null)
  const seenCountRef = useRef(0)
  // Why a scalar each: the identity is an object literal from the store on every render, so it
  // cannot be an effect dependency without restarting the fold on each one.
  const sessionAgentType = session?.agentType ?? ''
  const sessionKey = session?.providerSession?.key ?? 'session_id'
  const sessionId = session?.providerSession?.id ?? ''
  const sessionTranscriptPath = session?.providerSession?.transcriptPath ?? ''
  // Reads the latest snapshot without tearing down and recreating the auto-refresh timer.
  const snapshotRef = useRef<SessionSummarySnapshot | null>(null)
  snapshotRef.current = snapshot

  const accept = useCallback(
    (next: SessionSummarySnapshot): void => {
      if (next.paneKey !== paneKey) {
        return
      }
      if (next.ledger) {
        seenCountRef.current = Math.max(seenCountRef.current, next.ledger.timeline.length)
      }
      setSnapshot(next)
    },
    [paneKey]
  )

  const request = useCallback(
    (revalidateWithinMs: number): void => {
      void window.api.sessionSummary
        .open({
          paneKey,
          ...(executionHostId ? { executionHostId } : {}),
          ...(revalidateWithinMs > 0 ? { revalidateWithinMs } : {}),
          // Why: this window holds the pane, so it is the one process that always knows which
          // session is on screen — including when the folding side's own row is absent.
          ...(sessionAgentType || sessionId
            ? {
                session: {
                  ...(sessionAgentType ? { agentType: sessionAgentType } : {}),
                  ...(sessionId
                    ? {
                        providerSession: {
                          key: sessionKey,
                          id: sessionId,
                          ...(sessionTranscriptPath
                            ? { transcriptPath: sessionTranscriptPath }
                            : {})
                        }
                      }
                    : {})
                }
              }
            : {})
        })
        .then(accept)
    },
    [
      accept,
      paneKey,
      executionHostId,
      sessionAgentType,
      sessionKey,
      sessionId,
      sessionTranscriptPath
    ]
  )

  useEffect(() => {
    if (!open) {
      return
    }
    let cancelled = false
    const unsubscribe = window.api.sessionSummary.onUpdate((next) => {
      if (!cancelled) {
        accept(next)
      }
    })
    // The freshness window: re-entering the pane usually means "show me the brief I left".
    request(REVALIDATE_WITHIN_MS)
    return () => {
      cancelled = true
      unsubscribe()
      window.api.sessionSummary.close({ paneKey, seenTimelineCount: seenCountRef.current })
    }
  }, [open, paneKey, request, accept])

  // Auto-refresh a visible pane, but only when the agent produced something since the last
  // fold: an idle or finished session must not cost a model call an hour.
  useEffect(() => {
    if (!open) {
      return
    }
    const timer = setInterval(() => {
      const current = snapshotRef.current
      const foldedAt = current?.ledger?.foldedAt ?? 0
      const agentUpdatedAt = current?.facts?.updatedAt ?? 0
      if (!current?.ledger || agentUpdatedAt <= foldedAt) {
        return
      }
      request(0)
    }, SESSION_SUMMARY_AUTO_REFRESH_MS)
    return () => clearInterval(timer)
  }, [open, request])

  const refresh = useCallback((): void => request(0), [request])

  return {
    snapshot: snapshot?.paneKey === paneKey ? snapshot : null,
    refresh,
    refreshing: snapshot?.fold.running === true || snapshot?.status === 'folding'
  }
}
