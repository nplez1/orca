// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import userEvent from '@testing-library/user-event'

import { createGlobalSettingsFixture } from '../../../../../shared/global-settings-test-fixture'
import type { JiraIssue } from '../../../../../shared/jira/jira-types'
import { buildJiraIssueWorkspaceAttachmentIndex } from '@/lib/work-items/jira/jira-issue-workspace-attachment'
import { TooltipProvider } from '@/components/ui/tooltip'
import { defaultJiraListColumnIds, visibleJiraListColumns } from '../../jira-list-columns'
import type { TaskPageComposerActionsModel } from '../use-task-page-composer-actions'
import type { TaskPageJiraListPage } from './task-page-jira-list-pagination'
import { TaskPageJiraContent } from './Content'

vi.mock('@/components/JiraIssueWorkspace', () => ({ default: () => null }))
vi.mock('@/components/task-page/linear/Content', () => ({ TaskPageLinearContent: () => null }))

function issue(index: number): JiraIssue {
  const key = `ABC-${index}`
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
    assignee: { accountId: 'viewer-1', displayName: 'Ada' },
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-02T00:00:00.000Z'
  }
}

const issues = Array.from({ length: 50 }, (_, index) => issue(index + 1))

function model(
  overrides: {
    page?: TaskPageJiraListPage | null
    loadingMore?: boolean
    loadMoreError?: string | null
    loadMore?: () => void
  } = {}
): TaskPageComposerActionsModel {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the test supplies only the members this component reads.
  return {
    settings: createGlobalSettingsFixture({ defaultJiraBoard: null }),
    jiraStatus: {
      connected: true,
      viewer: { accountId: 'viewer-1', displayName: 'Ada', email: null },
      activeSiteId: 'site-1',
      credentialError: null
    },
    jiraStatusReady: true,
    jiraConnected: true,
    jiraHasWorkspace: false,
    jiraTaskSourceContext: null,
    jiraTaskSourceScopeKey: 'list-pagination-scope',
    accountBackedTaskSourceHostId: 'runtime:account-jira-owner',
    selectedJiraSiteId: 'site-1',
    selectedJiraIssue: null,
    jiraDetailSourceContext: null,
    openJiraDetailPage: vi.fn(),
    closeTaskDetailPage: vi.fn(),
    hideTaskSource: vi.fn(),
    taskSource: 'jira',
    jiraBoardViewMode: 'list',
    setJiraBoardViewMode: vi.fn(),
    jiraViewMode: 'list',
    setJiraViewMode: vi.fn(),
    jiraCurrentSprint: false,
    setJiraCurrentSprint: vi.fn(),
    jiraIssueAttachmentIndex: buildJiraIssueWorkspaceAttachmentIndex([]),
    jiraIssues: issues,
    jiraListPage: overrides.page ?? null,
    jiraListLoadingMore: overrides.loadingMore ?? false,
    jiraListLoadMoreError: overrides.loadMoreError ?? null,
    loadMoreJiraListPage: overrides.loadMore ?? vi.fn(),
    jiraLoading: false,
    jiraError: null,
    jiraErrorDetailsOpen: false,
    setJiraErrorDetailsOpen: vi.fn(),
    jiraJqlRejection: null,
    jiraSearchInput: '',
    jiraOrderBy: 'status',
    jiraOrderDirection: 'asc',
    handleJiraSort: vi.fn(),
    jiraColumnIds: defaultJiraListColumnIds(),
    jiraColumns: visibleJiraListColumns(defaultJiraListColumnIds()),
    toggleJiraColumn: vi.fn(),
    displayedJiraIssues: issues,
    displayedJiraStatusOrder: null,
    sortedJiraIssues: issues,
    setJiraConnectOpen: vi.fn(),
    handleUseJiraItem: vi.fn(),
    handleOpenOrUseJiraItem: vi.fn(),
    getJiraIssueWorkspaces: () => [],
    setJiraRefreshNonce: vi.fn()
  } as unknown as TaskPageComposerActionsModel
}

function renderContent(overrides: Parameters<typeof model>[0]) {
  return render(
    <TooltipProvider>
      <TaskPageJiraContent model={model(overrides)} />
    </TooltipProvider>
  )
}

afterEach(() => {
  cleanup()
})

describe('TaskPageJiraContent list pagination', () => {
  it('names the total and continues the list when one cursor can', async () => {
    const user = userEvent.setup()
    const loadMore = vi.fn()
    renderContent({
      page: {
        hasMore: true,
        total: 312,
        continuation: { siteId: 'site-1', jql: 'project = ABC', pageToken: 'token-2', startAt: 0 }
      },
      loadMore
    })

    expect(await screen.findByText('Showing 50 of 312')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Load more issues' }))
    expect(loadMore).toHaveBeenCalledTimes(1)
  })

  it('says more exist without a count when the source reports no total', async () => {
    renderContent({
      page: {
        hasMore: true,
        total: null,
        continuation: { siteId: 'site-1', jql: 'project = ABC', pageToken: 'token-2', startAt: 0 }
      }
    })

    expect(await screen.findByText('50 shown · more available')).toBeInTheDocument()
  })

  it('asks for a narrower filter when no single cursor reaches the rest', async () => {
    renderContent({ page: { hasMore: true, total: null, continuation: null } })

    expect(
      await screen.findByText('Showing the first 50 — refine the filter to see the rest.')
    ).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Load more issues' })).toBeNull()
  })

  it('leaves a complete list alone', async () => {
    renderContent({ page: { hasMore: false, total: null, continuation: null } })

    expect(await screen.findByText('50 shown')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Load more issues' })).toBeNull()
    expect(screen.queryByText(/Showing the first/)).toBeNull()
  })

  it('keeps the loaded rows and offers a retry when a page fails', async () => {
    const user = userEvent.setup()
    const loadMore = vi.fn()
    renderContent({
      page: {
        hasMore: true,
        total: 312,
        continuation: { siteId: 'site-1', jql: 'project = ABC', pageToken: 'token-2', startAt: 0 }
      },
      loadMoreError: 'Unable to load more Jira issues.',
      loadMore
    })

    expect(await screen.findByText('Unable to load more Jira issues.')).toBeInTheDocument()
    expect(screen.getByText('ABC-1 title')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Try again' }))
    expect(loadMore).toHaveBeenCalledTimes(1)
  })

  it('holds the button while the next page is in flight', async () => {
    renderContent({
      page: {
        hasMore: true,
        total: 312,
        continuation: { siteId: 'site-1', jql: 'project = ABC', pageToken: 'token-2', startAt: 0 }
      },
      loadingMore: true
    })

    expect(await screen.findByRole('button', { name: 'Loading…' })).toBeDisabled()
  })
})
