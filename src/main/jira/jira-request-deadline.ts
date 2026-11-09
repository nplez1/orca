/** Every Jira request has to end. A stalled response — a VPN drop, a proxy that swallows
 *  the connection — otherwise holds one of the four global request slots for the rest of
 *  the session, and four of them stop every Jira call in the app. */
export const JIRA_REQUEST_TIMEOUT_MS = 30_000

/** Says the read may simply be retried; nothing was written, so nothing is in doubt. */
export const JIRA_REQUEST_TIMEOUT_MESSAGE = 'Jira did not answer in time. Try again.'

/** Request fields Orca reads before handing the rest to `fetch`. */
export type JiraRequestInit = RequestInit & {
  /** Opts a non-idempotent write out of the transport deadline. An aborted create can
   *  still have landed server-side, so the user has to be told it may have worked
   *  before any retry — a blind abort would invite a duplicate. */
  noDefaultDeadline?: boolean
}

/** Runs one request under a deadline that settles the promise itself.
 *
 *  Why a race and not just a signal: the Jira transport awaits a proxy probe before it
 *  touches fetch, so a stall there never observes an abort. Only a timer that rejects
 *  guarantees the caller's `finally { release() }` runs and the slot comes back. */
export async function withJiraRequestDeadline<T>(
  callerSignal: AbortSignal | undefined,
  run: (signal: AbortSignal) => Promise<T>
): Promise<T> {
  const controller = new AbortController()
  const signal = callerSignal
    ? AbortSignal.any([callerSignal, controller.signal])
    : controller.signal
  let timedOut = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const expiry = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      timedOut = true
      controller.abort()
      reject(new Error(JIRA_REQUEST_TIMEOUT_MESSAGE))
    }, JIRA_REQUEST_TIMEOUT_MS)
  })
  const work = run(signal)
  // Why: the deadline may win the race, and the request nobody waits on any more must
  // not reach the process as an unhandled rejection when it eventually settles.
  work.catch(() => {})
  try {
    return await Promise.race([work, expiry])
  } catch (error) {
    // Why `timedOut` rather than `signal.aborted`: a caller's own deadline can abort the
    // combined signal, and its verdict on what happened has to reach it unchanged.
    if (timedOut) {
      throw new Error(JIRA_REQUEST_TIMEOUT_MESSAGE)
    }
    throw error
  } finally {
    clearTimeout(timer)
    controller.abort()
  }
}
