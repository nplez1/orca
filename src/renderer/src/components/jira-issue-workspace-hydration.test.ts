import { describe, expect, it } from 'vitest'
import type { JiraIssue } from '../../../shared/jira/jira-types'
import {
  editedJiraIssueFields,
  jiraIssueRollbackPatch,
  mergeJiraIssueHydration
} from './jira-issue-workspace-hydration'

function issue(overrides: Partial<JiraIssue> = {}): JiraIssue {
  return {
    id: '1001',
    key: 'ABC-1',
    title: 'Payments issue',
    url: 'https://example.atlassian.net/browse/ABC-1',
    project: { id: 'project-1', key: 'ABC', name: 'Payments' },
    issueType: { id: 'story', name: 'Story' },
    status: { id: '1', name: 'Ready', categoryKey: 'new', categoryName: 'To Do' },
    labels: [],
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-02T00:00:00.000Z',
    ...overrides
  }
}

describe('jira issue optimistic fields', () => {
  it('tracks story points, including a patch that clears them', () => {
    expect(editedJiraIssueFields({ storyPoints: 8 })).toEqual(['storyPoints'])
    expect(editedJiraIssueFields({ storyPoints: undefined })).toEqual(['storyPoints'])
  })

  it('puts the points back when their write fails', () => {
    expect(jiraIssueRollbackPatch(issue({ storyPoints: 5 }), { storyPoints: 8 })).toEqual({
      storyPoints: 5
    })
    expect(jiraIssueRollbackPatch(issue(), { storyPoints: 8 })).toEqual({ storyPoints: undefined })
  })

  it('keeps an edited points value over a fetched one', () => {
    const fetched = issue({ storyPoints: 2 })
    const current = issue({ storyPoints: 8 })

    expect(mergeJiraIssueHydration(fetched, current, new Set(['storyPoints'])).storyPoints).toBe(8)
    expect(mergeJiraIssueHydration(fetched, current, new Set()).storyPoints).toBe(2)
  })
})
