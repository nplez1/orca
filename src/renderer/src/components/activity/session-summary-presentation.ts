import { translate } from '@/i18n/i18n'
import type { SessionSummarySnapshot } from '../../../../shared/session-summary-types'

export type SessionSummaryHeaderState = {
  /** One-line status: what the fold is doing, or how much is waiting for the reader. */
  hint: string
  /** True while the fold runs, so hosts can show in-flight feedback. */
  folding: boolean
}

/** Header state shared by the activity strip and the right-sidebar summary pane. */
export function resolveSessionSummaryHeaderState(
  snapshot: SessionSummarySnapshot | null
): SessionSummaryHeaderState {
  if (snapshot?.fold.running) {
    return { hint: translate('activity.sessionSummary.updating', 'Updating…'), folding: true }
  }
  // Why: without a ledger there is nothing on screen, so the hint has to name
  // why. Falling through to "Up to date" told the reader a session with no
  // readable transcript was fully summarized.
  if (!snapshot?.ledger) {
    if (snapshot?.status === 'failed') {
      return {
        hint: translate('activity.sessionSummary.failedHint', 'Could not summarize this session'),
        folding: false
      }
    }
    if (snapshot?.status === 'unavailable') {
      return {
        hint: translate('activity.sessionSummary.noTranscriptHint', 'No readable transcript'),
        folding: false
      }
    }
  }
  const backlogCount = snapshot?.facts?.backlogCount ?? 0
  if (backlogCount > 0) {
    return {
      hint: translate('activity.sessionSummary.backlogHint', '{{count}} events to catch up on', {
        count: backlogCount
      }),
      folding: false
    }
  }
  return { hint: translate('activity.sessionSummary.upToDate', 'Up to date'), folding: false }
}
