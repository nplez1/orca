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
