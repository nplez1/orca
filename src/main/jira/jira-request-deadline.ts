/** Every Jira request has to end. A stalled response — a VPN drop, a proxy that swallows
 *  the connection — otherwise holds one of the four global request slots for the rest of
 *  the session, and four of them stop every Jira call in the app. */
export const JIRA_REQUEST_TIMEOUT_MS = 30_000

/** Says the request may simply be retried; nothing was written, so nothing is in doubt. */
export const JIRA_REQUEST_TIMEOUT_MESSAGE = 'Jira did not answer in time. Try again.'

/** A request the transport gave up on. Typed so a caller that must not swallow a stall —
 *  one board's sprint list, say — can tell this apart from that board's own failure. */
export class JiraRequestTimeoutError extends Error {
  constructor() {
    super(JIRA_REQUEST_TIMEOUT_MESSAGE)
    this.name = 'JiraRequestTimeoutError'
  }
}

function createAbortError(): Error {
  const error = new Error('Jira request aborted')
  error.name = 'AbortError'
  return error
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
      reject(new JiraRequestTimeoutError())
    }, JIRA_REQUEST_TIMEOUT_MS)
  })
  // Why the caller's abort is raced too: a stall in the proxy probe would otherwise
  // ignore the caller's deadline and answer it with the transport's verdict instead.
  let stopListening: (() => void) | undefined
  const callerAbort = callerSignal
    ? new Promise<never>((_resolve, reject) => {
        if (callerSignal.aborted) {
          reject(createAbortError())
          return
        }
        const onAbort = (): void => reject(createAbortError())
        callerSignal.addEventListener('abort', onAbort, { once: true })
        stopListening = () => callerSignal.removeEventListener('abort', onAbort)
      })
    : undefined
  const work = run(signal)
  // Why: the deadline may win the race, and the request nobody waits on any more must
  // not reach the process as an unhandled rejection when it eventually settles.
  work.catch(() => {})
  const racing: Promise<T>[] = callerAbort ? [work, expiry, callerAbort] : [work, expiry]
  try {
    return await Promise.race(racing)
  } catch (error) {
    // Why `timedOut` rather than `signal.aborted`: a caller's own deadline can abort the
    // combined signal, and its verdict on what happened has to reach it unchanged.
    if (timedOut) {
      throw new JiraRequestTimeoutError()
    }
    throw error
  } finally {
    clearTimeout(timer)
    stopListening?.()
    controller.abort()
  }
}
