// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { useRef, useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { JiraIssue, JiraIssueSearchPage } from '../../../../../shared/jira/jira-types'
import type { JiraSlice } from '@/store/slices/jira/jira-slice-contract'
import { useTaskPageJiraListLoadMore } from './use-task-page-jira-list-load-more'
import type { TaskPageJiraListPage } from './task-page-jira-list-pagination'

function issue(key: string): JiraIssue {
  return {
    id: key,
    key,
    siteId: 'site-1',
    title: `${key} title`,
    url: `https://example.atlassian.net/browse/${key}`,
    project: { id: 'project-1', key: 'ABC', name: 'Payments' },
    issueType: { id: 'story', name: 'Story' },
    status: { id: '1', name: 'Ready', categoryKey: 'new', categoryName: 'To Do' },
    labels: [],
    assignee: undefined,
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-02T00:00:00.000Z'
  }
}

const firstPage: TaskPageJiraListPage = {
  hasMore: true,
  total: 312,
  continuation: { siteId: 'site-1', jql: 'project = ABC', pageToken: 'token-2', startAt: 0 }
}

function page(keys: string[], overrides: Partial<JiraIssueSearchPage> = {}): JiraIssueSearchPage {
  return { issues: keys.map(issue), hasMore: false, total: null, continuation: null, ...overrides }
}

function harness(
  loadMoreJiraIssues: JiraSlice['loadMoreJiraIssues'],
  initialPage: TaskPageJiraListPage | null = firstPage,
  statusCatalogScopeKey: string | null = null,
  setJiraStatusCatalog: (value: { scopeKey: string; items: { name: string }[] }) => void = () => {}
) {
  return renderHook(() => {
    const [issues, setJiraIssues] = useState<JiraIssue[]>([issue('ABC-1')])
    const [jiraListPage, setJiraListPage] = useState<TaskPageJiraListPage | null>(initialPage)
    const [jiraListLoadingMore, setJiraListLoadingMore] = useState(false)
    const [jiraListLoadMoreError, setJiraListLoadMoreError] = useState<string | null>(null)
    const jiraListGenerationRef = useRef(0)
    const loadMore = useTaskPageJiraListLoadMore({
      jiraIssues: issues,
      setJiraIssues,
      jiraListPage,
      setJiraListPage,
      jiraListGenerationRef,
      jiraListLoadingMore,
      setJiraListLoadingMore,
      setJiraListLoadMoreError,
      jiraLoading: false,
      jiraTaskSourceContext: null,
      loadMoreJiraIssues,
      statusCatalogScopeKey,
      setJiraStatusCatalog
    })
    return {
      issues,
      jiraListPage,
      jiraListLoadingMore,
      jiraListLoadMoreError,
      jiraListGenerationRef,
      loadMore
    }
  })
}

afterEach(cleanup)

describe('useTaskPageJiraListLoadMore', () => {
  it('appends the next page once, dropping a row the updated window served twice', async () => {
    const loadMoreJiraIssues = vi.fn(async () => page(['ABC-1', 'ABC-2'], { hasMore: true }))
    const { result } = harness(loadMoreJiraIssues)

    await act(async () => {
      await result.current.loadMore()
    })

    expect(result.current.issues.map((item) => item.key)).toEqual(['ABC-1', 'ABC-2'])
    expect(result.current.jiraListPage).toEqual({
      hasMore: true,
      total: null,
      continuation: null
    })
    expect(loadMoreJiraIssues).toHaveBeenLastCalledWith(firstPage.continuation, 50, {
      sourceContext: null
    })
  })

  it('drops a page that lands after the list was reloaded', async () => {
    let resolvePage: (value: JiraIssueSearchPage) => void = () => {}
    const loadMoreJiraIssues = vi.fn(
      () =>
        new Promise<JiraIssueSearchPage>((resolve) => {
          resolvePage = resolve
        })
    )
    const { result } = harness(loadMoreJiraIssues)

    await act(async () => {
      const pending = result.current.loadMore()
      result.current.jiraListGenerationRef.current += 1
      resolvePage(page(['ABC-2']))
      await pending
    })

    expect(result.current.issues.map((item) => item.key)).toEqual(['ABC-1'])
    // Why still set: the reload that bumped the generation owns the flag now, so a stale
    // read must not clear it and let a second click start from the same continuation.
    expect(result.current.jiraListLoadingMore).toBe(true)
  })

  it('reports a failed page without touching the rows already shown', async () => {
    const loadMoreJiraIssues = vi.fn(async () => {
      throw new Error('Jira is down')
    })
    const { result } = harness(loadMoreJiraIssues)

    await act(async () => {
      await result.current.loadMore()
    })

    expect(result.current.jiraListLoadMoreError).toBe('Jira is down')
    expect(result.current.issues.map((item) => item.key)).toEqual(['ABC-1'])
  })

  it('widens the status options with the statuses the new page brought', async () => {
    const secondPageIssue = issue('ABC-2')
    secondPageIssue.status = {
      id: '2',
      name: 'Blocked',
      categoryKey: 'indeterminate',
      categoryName: 'In Progress'
    }
    const loadMoreJiraIssues = vi.fn(async () => ({
      ...page([]),
      issues: [secondPageIssue]
    }))
    const setJiraStatusCatalog = vi.fn()
    const { result } = harness(loadMoreJiraIssues, firstPage, 'scope-1', setJiraStatusCatalog)

    await act(async () => {
      await result.current.loadMore()
    })

    expect(setJiraStatusCatalog).toHaveBeenCalledWith({
      scopeKey: 'scope-1',
      items: [
        expect.objectContaining({ name: 'Ready' }),
        expect.objectContaining({ name: 'Blocked' })
      ]
    })
  })

  it('leaves the status options alone when this list does not own them', async () => {
    const loadMoreJiraIssues = vi.fn(async () => page(['ABC-2']))
    const setJiraStatusCatalog = vi.fn()
    const { result } = harness(loadMoreJiraIssues, firstPage, null, setJiraStatusCatalog)

    await act(async () => {
      await result.current.loadMore()
    })

    expect(setJiraStatusCatalog).not.toHaveBeenCalled()
  })

  it('reads nothing when the source gave no continuation', async () => {
    const loadMoreJiraIssues = vi.fn(async () => page(['ABC-2']))
    const { result } = harness(loadMoreJiraIssues, {
      hasMore: true,
      total: null,
      continuation: null
    })

    await act(async () => {
      await result.current.loadMore()
    })

    expect(loadMoreJiraIssues).not.toHaveBeenCalled()
    expect(result.current.jiraListLoadMoreError).toBeNull()
  })
})
