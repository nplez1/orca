import type { Page } from '@stablyai/playwright-test'
import type { JiraIssue } from '../../../src/shared/jira-types'
import { waitForSessionReady } from './store'

export const ISSUE_TITLE = 'Keep planning notes visible while switching between project tasks'
export const ISSUE: JiraIssue = {
  id: 'layout-fixture',
  key: 'DEMO-101',
  siteId: 'layout-site',
  title: ISSUE_TITLE,
  url: 'https://example.atlassian.net/browse/DEMO-101',
  project: { id: 'layout-project', key: 'DEMO', name: 'Demo' },
  issueType: { id: 'task', name: 'Task' },
  status: { id: 'open', name: 'To Do', categoryKey: 'new', categoryName: 'To Do' },
  labels: [],
  parent: { key: 'DEMO-10', title: 'Epic planning' },
  sprint: 'Sprint 12',
  storyPoints: 5,
  originalEstimateSeconds: 7200,
  remainingEstimateSeconds: 1800,
  priority: { id: 'high', name: 'High' },
  assignee: { accountId: 'layout-user', displayName: 'Demo User' },
  createdAt: '2026-10-01T00:00:00Z',
  updatedAt: '2026-10-13T00:00:00Z'
}

/** Opens the tasks page on a Jira source backed by the fixture issue, with no network. */
export async function openFixtureJiraList(page: Page): Promise<void> {
  await waitForSessionReady(page)
  await page.setViewportSize({ width: 1500, height: 900 })
  await page.evaluate((issue) => {
    const store = window.__store
    if (!store) {
      throw new Error('Store unavailable')
    }
    const state = store.getState()
    if (!state.settings) {
      throw new Error('Settings unavailable')
    }
    const status = {
      connected: true,
      viewer: null,
      selectedSiteId: 'layout-site',
      sites: [
        {
          id: 'layout-site',
          siteUrl: 'https://example.atlassian.net',
          email: '',
          displayName: 'Demo Jira',
          accountId: 'layout-user'
        }
      ]
    }
    store.setState({
      settings: { ...state.settings, defaultTaskSource: 'jira', visibleTaskProviders: ['jira'] },
      jiraStatus: status,
      jiraStatusChecked: true,
      jiraStatusContextKey: 'local#0',
      checkJiraConnection: async () => {},
      readJiraStatus: async () => status,
      listJiraIssues: async () => [issue],
      searchJiraIssues: async () => [issue]
    })
    store.getState().openTaskPage({ taskSource: 'jira' })
  }, ISSUE)
}
