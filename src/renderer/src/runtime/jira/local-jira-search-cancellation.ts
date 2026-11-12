import type {
  JiraIssue,
  JiraIssueSearchPage,
  JiraSiteSelection
} from '../../../../shared/jira/jira-types'
import { createNonSecureContextUuid as createBrowserUuid } from '../../../../shared/non-secure-context-uuid'

type LocalJiraSearchArgs = {
  jql: string
  limit?: number
  siteId?: JiraSiteSelection
  pageToken?: string
  startAt?: number
}

function createJiraSearchAbortError(): Error {
  const error = new Error('Jira search aborted')
  error.name = 'AbortError'
  return error
}

async function runLocalJiraSearch<T>(
  signal: AbortSignal,
  read: (requestId: string) => Promise<T>
): Promise<T> {
  if (signal.aborted) {
    throw createJiraSearchAbortError()
  }
  const requestId = createBrowserUuid()
  const handleAbort = (): void => {
    void window.api.jira.cancelSearchIssues({ requestId }).catch(() => {})
  }
  signal.addEventListener('abort', handleAbort, { once: true })
  try {
    const result = await read(requestId)
    // Why: cancel can race ahead of main-process registration; drop late successes.
    if (signal.aborted) {
      throw createJiraSearchAbortError()
    }
    return result
  } finally {
    signal.removeEventListener('abort', handleAbort)
  }
}

/** Cancel superseded local searches in main or abandoned keystrokes hold shared Jira pool slots and stall the next query. */
export async function searchLocalJiraIssues(
  args: LocalJiraSearchArgs,
  signal: AbortSignal
): Promise<JiraIssue[]> {
  return runLocalJiraSearch(signal, (requestId) =>
    window.api.jira.searchIssues({ ...args, requestId })
  )
}

export async function searchLocalJiraIssuesPage(
  args: LocalJiraSearchArgs,
  signal: AbortSignal
): Promise<JiraIssueSearchPage> {
  return runLocalJiraSearch(signal, (requestId) =>
    window.api.jira.searchIssuesPage({ ...args, requestId })
  )
}
