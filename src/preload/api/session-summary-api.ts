import type {
  SessionSummaryAskRequest,
  SessionSummaryCloseRequest,
  SessionSummaryOpenRequest,
  SessionSummarySnapshot
} from '../../shared/session-summary-types'

export type SessionSummaryApi = {
  /** Open the summary pane for a pane: returns cached snapshot, starts a fold. */
  open: (request: SessionSummaryOpenRequest) => Promise<SessionSummarySnapshot>
  /** Pane closed: cancel in-flight folds and advance the last-seen cursor. */
  close: (request: SessionSummaryCloseRequest) => void
  /**
   * Ask a question about the session, answered by the summary's own agent; the answer arrives
   * through `onUpdate`. Absent where this window cannot ask — a paired browser client today.
   */
  ask?: (request: SessionSummaryAskRequest) => Promise<SessionSummarySnapshot>
  onUpdate: (callback: (snapshot: SessionSummarySnapshot) => void) => () => void
}
