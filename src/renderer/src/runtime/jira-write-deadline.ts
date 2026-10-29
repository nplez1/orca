import {
  JIRA_WRITE_DEADLINE_MS,
  JIRA_WRITE_TIMEOUT_MESSAGE
} from '../../../shared/jira/jira-write-deadline'

/** A write whose deadline fired: the host may still commit it, so the caller has to
 *  re-read the issue instead of treating the field as unsaved. */
export class JiraWriteTimeoutError extends Error {
  constructor() {
    super(JIRA_WRITE_TIMEOUT_MESSAGE)
    this.name = 'JiraWriteTimeoutError'
  }
}

/** Stops waiting on a Jira write, so no surface stays pending behind one nobody
 *  answered. Transport-level bounds are shorter (the main process's fetch, the
 *  remote RPC), so this only fires when no answer arrives at all. */
export async function withJiraWriteDeadline<TResult>(work: Promise<TResult>): Promise<TResult> {
  const signal = AbortSignal.timeout(JIRA_WRITE_DEADLINE_MS)
  const expired = new Promise<never>((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(new JiraWriteTimeoutError()), { once: true })
  })
  return await Promise.race([work, expired])
}

// Why: every transport reports a lost answer in its own words, and a caller that treats
// one as an ordinary failure rolls back a field the host may have saved.
const TRANSPORT_TIMEOUT = /timed out|timeout/i

/** Rethrows a transport timeout as the write-timeout the queue re-reads after. */
export function rethrowJiraWriteTimeout(error: unknown): never {
  if (error instanceof JiraWriteTimeoutError) {
    throw error
  }
  if (error instanceof Error && TRANSPORT_TIMEOUT.test(error.message)) {
    throw new JiraWriteTimeoutError()
  }
  throw error
}
