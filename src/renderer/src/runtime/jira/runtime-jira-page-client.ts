import type {
  JiraIssue,
  JiraIssueFilter,
  JiraIssueListFilters,
  JiraIssueSearchContinuation,
  JiraIssueSearchPage,
  JiraSiteSelection
} from '../../../../shared/jira/jira-types'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import { hasRuntimeRpcErrorCode } from '../../../../shared/runtime-rpc-error-code'
import { JIRA_CURRENT_SPRINT_RUNTIME_CAPABILITY } from '../../../../shared/jira/jira-detail-capabilities'
import {
  JIRA_STATUS_FILTER_RUNTIME_CAPABILITY,
  JIRA_STATUS_FILTER_UPDATE_REQUIRED
} from '../../../../shared/jira/jira-quick-filters'
import { callRuntimeRpc } from '../rpc/calls/runtime-rpc-call'
import { assertRuntimeEnvironmentCapability } from '../rpc/compatibility/runtime-capability-proof'
import { isRuntimeProviderSearchQueryWithinLimit } from '../issue-search/runtime-provider-search-bounds'
import { searchLocalJiraIssues, searchLocalJiraIssuesPage } from './local-jira-search-cancellation'
import { getJiraRuntimeTarget, type RuntimeJiraSettings } from './runtime-jira-target'

/** Where a page read resumes. Only the fields the host understands travel. */
export type JiraIssuePageCursor = Pick<JiraIssueSearchContinuation, 'pageToken' | 'startAt'>

function pageCursorArgs(cursor?: JiraIssuePageCursor): {
  pageToken?: string
  startAt?: number
} {
  return cursor ? { pageToken: cursor.pageToken ?? undefined, startAt: cursor.startAt } : {}
}

const EMPTY_ISSUE_PAGE: JiraIssueSearchPage = {
  issues: [],
  hasMore: false,
  total: null,
  continuation: null
}

/** A host that predates the page methods answers `method_not_found`; one extra row past the
 *  page size is the only truncation signal the array methods can give, and it cannot resume. */
async function readJiraIssuePage(
  readPage: () => Promise<JiraIssueSearchPage>,
  readTruncationProbe: () => Promise<JiraIssue[]>,
  limit: number,
  cursor: JiraIssuePageCursor | undefined
): Promise<JiraIssueSearchPage> {
  try {
    return await readPage()
  } catch (error) {
    if (cursor || !hasRuntimeRpcErrorCode(error, 'method_not_found')) {
      throw error
    }
    const issues = await readTruncationProbe()
    return {
      issues: issues.slice(0, limit),
      hasMore: issues.length > limit,
      total: null,
      continuation: null
    }
  }
}

export async function jiraSearchIssuesPage(
  settings: RuntimeJiraSettings,
  jql: string,
  limit = 30,
  siteId?: JiraSiteSelection | null,
  signal?: AbortSignal,
  cursor?: JiraIssuePageCursor
): Promise<JiraIssueSearchPage> {
  return jiraSearchIssuesPageForTarget(
    getJiraRuntimeTarget(settings),
    jql,
    limit,
    siteId,
    signal,
    cursor
  )
}

export async function jiraSearchIssuesPageForTarget(
  target: RuntimeClientTarget,
  jql: string,
  limit = 30,
  siteId?: JiraSiteSelection | null,
  signal?: AbortSignal,
  cursor?: JiraIssuePageCursor
): Promise<JiraIssueSearchPage> {
  if (!isRuntimeProviderSearchQueryWithinLimit(jql)) {
    return EMPTY_ISSUE_PAGE
  }
  const args = { jql, limit, siteId: siteId ?? undefined, ...pageCursorArgs(cursor) }
  return readJiraIssuePage(
    () =>
      target.kind === 'environment'
        ? callRuntimeRpc<JiraIssueSearchPage>(target, 'jira.searchIssuesPage', args, {
            timeoutMs: 30_000,
            signal
          })
        : signal
          ? searchLocalJiraIssuesPage(args, signal)
          : window.api.jira.searchIssuesPage(args),
    () =>
      target.kind === 'environment'
        ? callRuntimeRpc<JiraIssue[]>(
            target,
            'jira.searchIssues',
            { ...args, limit: limit + 1 },
            {
              timeoutMs: 30_000,
              signal
            }
          )
        : signal
          ? searchLocalJiraIssues({ ...args, limit: limit + 1 }, signal)
          : window.api.jira.searchIssues({ ...args, limit: limit + 1 }),
    limit,
    cursor
  )
}

export async function jiraListIssuesPage(
  settings: RuntimeJiraSettings,
  filter?: JiraIssueFilter,
  limit = 30,
  siteId?: JiraSiteSelection | null,
  filters?: JiraIssueListFilters,
  cursor?: JiraIssuePageCursor
): Promise<JiraIssueSearchPage> {
  return jiraListIssuesPageForTarget(
    getJiraRuntimeTarget(settings),
    filter,
    limit,
    siteId,
    filters,
    cursor
  )
}

export async function jiraListIssuesPageForTarget(
  target: RuntimeClientTarget,
  filter?: JiraIssueFilter,
  limit = 30,
  siteId?: JiraSiteSelection | null,
  filters?: JiraIssueListFilters,
  cursor?: JiraIssuePageCursor
): Promise<JiraIssueSearchPage> {
  const args = {
    filter,
    limit,
    siteId: siteId ?? undefined,
    ...(filters ? { filters } : {}),
    ...pageCursorArgs(cursor)
  }
  const probeArgs = { ...args, limit: limit + 1 }
  return readJiraIssuePage(
    async () => {
      if (target.kind === 'environment') {
        await assertListIssuePageCapabilities(target, filters)
        return callRuntimeRpc<JiraIssueSearchPage>(target, 'jira.listIssuesPage', args, {
          timeoutMs: 30_000
        })
      }
      return window.api.jira.listIssuesPage(args)
    },
    async () => {
      if (target.kind === 'environment') {
        await assertListIssuePageCapabilities(target, filters)
        return callRuntimeRpc<JiraIssue[]>(target, 'jira.listIssues', probeArgs, {
          timeoutMs: 30_000
        })
      }
      return window.api.jira.listIssues(probeArgs)
    },
    limit,
    cursor
  )
}

async function assertListIssuePageCapabilities(
  target: RuntimeClientTarget,
  filters?: JiraIssueListFilters
): Promise<void> {
  if (target.kind !== 'environment') {
    return
  }
  if (filters?.currentSprint) {
    await assertRuntimeEnvironmentCapability(
      target.environmentId,
      JIRA_CURRENT_SPRINT_RUNTIME_CAPABILITY,
      'Update the remote Orca server to filter preset issues by current sprint.'
    )
  }
  if (filters?.statuses?.length) {
    await assertRuntimeEnvironmentCapability(
      target.environmentId,
      JIRA_STATUS_FILTER_RUNTIME_CAPABILITY,
      JIRA_STATUS_FILTER_UPDATE_REQUIRED,
      15_000
    )
  }
}
