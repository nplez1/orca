import { describe, expect, it } from 'vitest'
import type { JiraBoardColumn, JiraIssue, JiraTransition } from '../../../shared/jira-types'
import {
  filterTaskPageJiraBoardIssues,
  getTaskPageJiraBoardTransitionTargets,
  getTaskPageJiraBoardViewerAccountId,
  groupTaskPageJiraBoardIssues,
  shouldShowJiraSiteSelector
} from './task-page-jira-board-model'

function issue(key: string, statusId: string, overrides: Partial<JiraIssue> = {}): JiraIssue {
  return {
    id: key,
    key,
    siteId: 'site-1',
    title: key,
    url: `https://example.atlassian.net/browse/${key}`,
    project: { id: 'project-1', key: 'ABC', name: 'Example' },
    issueType: { id: 'story', name: 'Story' },
    status: { id: statusId, name: statusId, categoryKey: 'undefined', categoryName: 'None' },
    labels: [],
    updatedAt: '2026-09-01T00:00:00.000Z',
    createdAt: '2026-09-01T00:00:00.000Z',
    ...overrides
  }
}

const columns: JiraBoardColumn[] = [
  { name: 'Ready', statusIds: ['1', '2'] },
  { name: 'Doing', statusIds: ['3'] }
]

describe('Jira board projection', () => {
  it('keeps the Jira site selector available from the issue-list view', () => {
    expect(shouldShowJiraSiteSelector(true, true, 'board', 2)).toBe(false)
    expect(shouldShowJiraSiteSelector(true, true, 'list', 2)).toBe(true)
    expect(shouldShowJiraSiteSelector(true, false, 'board', 2)).toBe(true)
    expect(shouldShowJiraSiteSelector(true, true, 'list', 1)).toBe(false)
  })

  it('uses the viewer account associated with the board site, not another active site', () => {
    expect(
      getTaskPageJiraBoardViewerAccountId(
        {
          connected: true,
          viewer: { accountId: 'account-site-a', displayName: 'Ada', email: null },
          activeSiteId: 'site-a',
          sites: [
            {
              id: 'site-a',
              siteUrl: 'https://a.atlassian.net',
              email: 'ada@example.com',
              displayName: 'A',
              accountId: 'account-site-a'
            },
            {
              id: 'site-b',
              siteUrl: 'https://b.atlassian.net',
              email: 'ada@example.com',
              displayName: 'B',
              accountId: 'account-site-b'
            }
          ]
        },
        'site-b'
      )
    ).toBe('account-site-b')
  })

  it('filters by the Jira viewer account, exact configured team value, or all issues', () => {
    const issues = [
      issue('ABC-1', '1', {
        assignee: { accountId: 'viewer-1', displayName: 'Ada' },
        teamValue: { key: 'team-1', label: 'Payments' }
      }),
      issue('ABC-2', '2', {
        assignee: { accountId: 'viewer-2', displayName: 'Grace' },
        teamValue: { key: 'team-2', label: 'Platform' }
      }),
      issue('ABC-3', '3')
    ]

    expect(
      filterTaskPageJiraBoardIssues(issues, 'me', 'viewer-1', 'team-1').map((item) => item.key)
    ).toEqual(['ABC-1'])
    expect(
      filterTaskPageJiraBoardIssues(issues, 'team', 'viewer-1', 'team-2').map((item) => item.key)
    ).toEqual(['ABC-2'])
    expect(
      filterTaskPageJiraBoardIssues(issues, 'team', 'viewer-1', '').map((item) => item.key)
    ).toEqual([])
    expect(filterTaskPageJiraBoardIssues(issues, 'all', null, '').map((item) => item.key)).toEqual([
      'ABC-1',
      'ABC-2',
      'ABC-3'
    ])
  })

  it('maps each sprint issue to one configured status column and keeps unmapped issues visible', () => {
    const issues = [issue('ABC-1', '1'), issue('ABC-2', '3'), issue('ABC-3', '9')]
    const overlappingColumns: JiraBoardColumn[] = [
      columns[0],
      { name: 'Duplicate', statusIds: ['1'] },
      columns[1]
    ]

    expect(groupTaskPageJiraBoardIssues(overlappingColumns, issues)).toEqual({
      columns: [
        { column: columns[0], issues: [issues[0]] },
        { column: overlappingColumns[1], issues: [] },
        { column: columns[1], issues: [issues[1]] }
      ],
      otherIssues: [issues[2]]
    })
  })

  it('only offers transitions whose destination status belongs to the dropped column', () => {
    const transitions: JiraTransition[] = [
      {
        id: 'transition-1',
        name: 'Start work',
        to: {
          id: '3',
          name: 'In Progress',
          categoryKey: 'indeterminate',
          categoryName: 'In Progress'
        }
      },
      {
        id: 'transition-2',
        name: 'Reopen',
        to: { id: '2', name: 'Ready', categoryKey: 'new', categoryName: 'To Do' }
      }
    ]

    expect(getTaskPageJiraBoardTransitionTargets(transitions, ['3'])).toEqual([transitions[0]])
    expect(getTaskPageJiraBoardTransitionTargets(transitions, ['4'])).toEqual([])
  })
})
