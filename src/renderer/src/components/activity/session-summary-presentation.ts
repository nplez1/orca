import { translate } from '@/i18n/i18n'
import {
  SESSION_SUMMARY_HOST_OUTDATED_MESSAGE,
  type SessionSummarySnapshot
} from '../../../../shared/session-summary-types'

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
  // Why status too: while a paired host is asked, the local fold flag is idle until its
  // answer lands, and falling through said "Up to date" over a skeleton.
  if (snapshot?.fold.running || snapshot?.status === 'folding') {
    return { hint: translate('activity.sessionSummary.updating', 'Updating…'), folding: true }
  }
  // Why: without a ledger there is nothing on screen, so the hint has to name
  // why. Falling through to "Up to date" told the reader a session with no
  // readable transcript was fully summarized.
  if (!snapshot?.ledger) {
    if (snapshot?.status === 'failed') {
      return {
        hint: isHostOutdated(snapshot)
          ? translate(
              'activity.sessionSummary.hostOutdatedHint',
              'Update Orca on this host to summarize'
            )
          : translate('activity.sessionSummary.failedHint', 'Could not summarize this session'),
        folding: false
      }
    }
    if (snapshot?.status === 'unsupported-host') {
      return {
        hint: translate(
          'activity.sessionSummary.unsupportedHostHint',
          'Session summaries are not available on this host'
        ),
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
  // Why here and not above: with a ledger on screen the failure has to win over an
  // "Up to date" body, but a real backlog is still the more useful thing to say.
  if (snapshot?.status === 'failed' && backlogCount === 0) {
    return {
      hint: isHostOutdated(snapshot)
        ? translate(
            'activity.sessionSummary.hostOutdatedHint',
            'Update Orca on this host to summarize'
          )
        : translate(
            'activity.sessionSummary.staleHint',
            "Couldn't refresh — showing the last summary"
          ),
      folding: false
    }
  }
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

/** A paired host too old to fold its own sessions: a remedy, not a failure. */
export function isHostOutdated(snapshot: SessionSummarySnapshot | null): boolean {
  return snapshot?.error === SESSION_SUMMARY_HOST_OUTDATED_MESSAGE
}
