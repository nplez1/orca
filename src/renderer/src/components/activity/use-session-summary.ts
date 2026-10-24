import { useEffect, useRef, useState } from 'react'
import type {
  SessionSummarySessionRef,
  SessionSummarySnapshot
} from '../../../../shared/session-summary-types'

/**
 * Summary data for a pane. The fold only runs while `open` is true — open()
 * starts it, the unmount/close path cancels it — so this hook is the "user is
 * looking" signal the service keys its work on.
 */
export function useSessionSummary(
  paneKey: string,
  open: boolean,
  executionHostId?: string | null,
  session?: SessionSummarySessionRef | null
): SessionSummarySnapshot | null {
  const [snapshot, setSnapshot] = useState<SessionSummarySnapshot | null>(null)
  // Timeline length displayed at any point this view was open: what the next
  // "since you last looked" cursor advances to on close.
  const seenCountRef = useRef(0)
  // Why scalars: the identity is an object literal from the store on every render, so it
  // cannot be an effect dependency without restarting the fold on each one.
  const sessionAgentType = session?.agentType ?? ''
  const sessionKey = session?.providerSession?.key ?? 'session_id'
  const sessionId = session?.providerSession?.id ?? ''
  const sessionTranscriptPath = session?.providerSession?.transcriptPath ?? ''

  useEffect(() => {
    if (!open) {
      return
    }
    let cancelled = false
    const accept = (next: SessionSummarySnapshot): void => {
      if (cancelled || next.paneKey !== paneKey) {
        return
      }
      if (next.ledger) {
        seenCountRef.current = Math.max(seenCountRef.current, next.ledger.timeline.length)
      }
      setSnapshot(next)
    }
    setSnapshot((prev) => (prev?.paneKey === paneKey ? prev : null))
    const unsubscribe = window.api.sessionSummary.onUpdate(accept)
    void window.api.sessionSummary
      .open({
        paneKey,
        ...(executionHostId ? { executionHostId } : {}),
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
                        ...(sessionTranscriptPath ? { transcriptPath: sessionTranscriptPath } : {})
                      }
                    }
                  : {})
              }
            }
          : {})
      })
      .then(accept)
    return () => {
      cancelled = true
      unsubscribe()
      window.api.sessionSummary.close({ paneKey, seenTimelineCount: seenCountRef.current })
    }
  }, [
    paneKey,
    open,
    executionHostId,
    sessionAgentType,
    sessionKey,
    sessionId,
    sessionTranscriptPath
  ])

  return snapshot?.paneKey === paneKey ? snapshot : null
}
