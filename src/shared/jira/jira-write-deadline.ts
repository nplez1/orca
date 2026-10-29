/** How long a Jira write may hold the issue's mutation queue before the surface
 *  gives up waiting. Comfortably above the 30 s every transport already bounds
 *  itself with, so this only fires when no answer arrives at all. */
export const JIRA_WRITE_DEADLINE_MS = 45_000

/** Also the main process's own fetch deadline: a hung connection must release the
 *  shared Jira request slot instead of holding it for the session. */
export const JIRA_WRITE_FETCH_TIMEOUT_MS = 30_000

/** Why above the host's fetch deadline: the host's own verdict on a write it aborted has
 *  to reach the client first, or the client would time out into the blind rollback this
 *  deadline exists to avoid. */
export const JIRA_WRITE_RPC_TIMEOUT_MS = 60_000

/** Reported when the fetch deadline fires: the write may still land, so callers
 *  re-read the issue rather than rolling the field back blindly. */
export const JIRA_WRITE_TIMEOUT_MESSAGE =
  'Jira did not answer in time, so this change may not have been saved. Reload the issue.'
