import type {
  SessionSummaryCloseRequest,
  SessionSummaryOpenRequest,
  SessionSummarySnapshot
} from '../../shared/session-summary-types'

export type SessionSummaryApi = {
  /** Open the summary pane for a pane: returns cached snapshot, starts a fold. */
  open: (request: SessionSummaryOpenRequest) => Promise<SessionSummarySnapshot>
  /** Pane closed: cancel in-flight folds and advance the last-seen cursor. */
  close: (request: SessionSummaryCloseRequest) => void
  onUpdate: (callback: (snapshot: SessionSummarySnapshot) => void) => () => void
}
