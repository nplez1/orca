import type { JiraSiteSelection } from '../../shared/jira-types'
import { acquire, release } from './request-queue'

export type JiraIssueSearchFailure = {
  error: unknown
  auth: boolean
}

/**
 * Run against one signal that trips on the caller's abort or the request deadline.
 *
 * `timeoutMessage` replaces the transport's abort error when the deadline (not the
 * caller) fired, so a stalled read reaches the user as what it is.
 */
export async function withJiraDeadline<T>(
  signal: AbortSignal | undefined,
  timeoutMs: number,
  run: (deadlineSignal: AbortSignal) => Promise<T>,
  timeoutMessage?: string
): Promise<T> {
  const controller = new AbortController()
  const abort = (): void => controller.abort()
  signal?.addEventListener('abort', abort, { once: true })
  if (signal?.aborted) {
    controller.abort()
  }
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    abort()
  }, timeoutMs)
  try {
    return await run(controller.signal)
  } catch (error) {
    if (timedOut && timeoutMessage) {
      throw new Error(timeoutMessage)
    }
    throw error
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', abort)
  }
}

/**
 * Deadline-wrapped run that holds one shared Jira pool slot, released on every path.
 *
 * Why: a read that backs a settings select must end. Without the deadline a stalled
 * request keeps its slot and leaves the select disabled with nothing to retry.
 */
export function withJiraQueuedDeadline<T>(
  description: string,
  timeoutMs: number,
  run: (signal: AbortSignal) => Promise<T>
): Promise<T> {
  return withJiraDeadline(
    undefined,
    timeoutMs,
    async (signal) => {
      await acquire(signal)
      try {
        return await run(signal)
      } finally {
        release()
      }
    },
    `Jira ${description} request timed out.`
  )
}

export function settleJiraSummaryRead<T>(read: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(new Error('Jira summary lookup aborted'))
  }
  return new Promise((resolve, reject) => {
    const handleAbort = (): void => {
      cleanup()
      reject(new Error('Jira summary lookup aborted'))
    }
    const cleanup = (): void => signal.removeEventListener('abort', handleAbort)
    signal.addEventListener('abort', handleAbort, { once: true })
    void read.then(
      (value) => {
        cleanup()
        resolve(value)
      },
      (error: unknown) => {
        cleanup()
        reject(error)
      }
    )
  })
}

export function getErrorStatus(error: unknown): number | null {
  if (!error || typeof error !== 'object' || !('status' in error)) {
    return null
  }
  const status = (error as { status?: unknown }).status
  return typeof status === 'number' && Number.isFinite(status) ? status : null
}

export function toIssueSearchFailureError(error: unknown): unknown {
  const status = getErrorStatus(error)
  if (
    status === null ||
    !(error instanceof Error) ||
    error.message.startsWith(`Error ${status}:`)
  ) {
    return error
  }
  return new Error(`Error ${status}: ${error.message}`)
}

export function shouldSurfaceSiteFailure(
  selection: JiraSiteSelection | null | undefined,
  entryCount: number
): boolean {
  // getClients can resolve an omitted selection to the persisted 'all' choice;
  // multi-entry reads need the same resilient fan-out policy as explicit 'all'.
  return selection !== 'all' && entryCount <= 1
}
