import { useEffect, useRef, useState } from 'react'
import type { SessionSummarySnapshot } from '../../../../shared/session-summary-types'

/**
 * Summary data for a pane. The fold only runs while `open` is true — open()
 * starts it, the unmount/close path cancels it — so this hook is the "user is
 * looking" signal the service keys its work on.
 */
export function useSessionSummary(paneKey: string, open: boolean): SessionSummarySnapshot | null {
  const [snapshot, setSnapshot] = useState<SessionSummarySnapshot | null>(null)
  // Timeline length displayed at any point this view was open: what the next
  // "since you last looked" cursor advances to on close.
  const seenCountRef = useRef(0)

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
    void window.api.sessionSummary.open({ paneKey }).then(accept)
    return () => {
      cancelled = true
      unsubscribe()
      window.api.sessionSummary.close({ paneKey, seenTimelineCount: seenCountRef.current })
    }
  }, [paneKey, open])

  return snapshot?.paneKey === paneKey ? snapshot : null
}
