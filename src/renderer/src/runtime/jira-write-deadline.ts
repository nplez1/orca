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

/** Races a Jira write against its deadline. `signal` reaches transports that can
 *  cancel (the remote RPC); the local IPC channel cannot, so the race is what bounds
 *  the wait there — the main process bounds its own fetch separately. */
export async function withJiraWriteDeadline<TResult>(
  work: (signal: AbortSignal) => Promise<TResult>
): Promise<TResult> {
  const signal = AbortSignal.timeout(JIRA_WRITE_DEADLINE_MS)
  const expired = new Promise<never>((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(new JiraWriteTimeoutError()), { once: true })
  })
  return await Promise.race([work(signal), expired])
}
