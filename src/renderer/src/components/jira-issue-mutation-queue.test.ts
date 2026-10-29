import { describe, expect, it } from 'vitest'
import type { JiraIssue } from '../../../shared/jira/jira-types'
import { JiraWriteTimeoutError } from '@/runtime/jira-write-deadline'
import { enqueueJiraIssueMutation, subscribeJiraIssueMutation } from './jira-issue-mutation-queue'

function issue(key: string, title = 'Server title'): JiraIssue {
  return {
    id: key,
    key,
    siteId: 'site-1',
    title,
    url: `https://example.atlassian.net/browse/${key}`,
    project: { id: 'project-1', key: 'ABC', name: 'Payments' },
    issueType: { id: 'story', name: 'Story' },
    status: { id: '1', name: 'Ready', categoryKey: 'new', categoryName: 'To Do' },
    labels: [],
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-02T00:00:00.000Z'
  }
}

type Published = { patch: Partial<JiraIssue>; rollback: boolean }

function collect(scope: string): Published[] {
  const published: Published[] = []
  subscribeJiraIssueMutation(
    scope,
    (patch, rollback) => published.push({ patch, rollback }),
    () => {}
  )
  return published
}

describe('enqueueJiraIssueMutation', () => {
  it('re-reads after a timed-out write instead of rolling the field back', async () => {
    const published = collect('timeout-not-landed')

    await expect(
      enqueueJiraIssueMutation({
        scope: 'timeout-not-landed',
        previous: issue('ABC-1', 'Old title'),
        optimistic: { title: 'Mine' },
        update: async () => ({ ok: false, error: 'timed out', timedOut: true }),
        refresh: async () => issue('ABC-1', 'Newest server title'),
        patchIssue: () => {}
      })
    ).rejects.toBeInstanceOf(JiraWriteTimeoutError)

    // The read, not the pre-write snapshot: the host may have committed the write.
    expect(published.at(-1)).toEqual({
      patch: { title: 'Newest server title' },
      rollback: true
    })
  })

  it('treats a timed-out write the read confirms as saved', async () => {
    const published = collect('timeout-landed')

    await enqueueJiraIssueMutation({
      scope: 'timeout-landed',
      previous: issue('ABC-1', 'Old title'),
      optimistic: { title: 'Mine' },
      update: async () => ({ ok: false, error: 'timed out', timedOut: true }),
      refresh: async () => issue('ABC-1', 'Mine'),
      patchIssue: () => {}
    })

    expect(published.at(-1)).toMatchObject({
      patch: { key: 'ABC-1', title: 'Mine' },
      rollback: false
    })
  })

  it('rolls back to the previous value when the write is refused', async () => {
    const published = collect('refused')

    await expect(
      enqueueJiraIssueMutation({
        scope: 'refused',
        previous: issue('ABC-1', 'Old title'),
        optimistic: { title: 'Mine' },
        update: async () => ({ ok: false, error: 'Field refused' }),
        refresh: async () => issue('ABC-1', 'Old title'),
        patchIssue: () => {}
      })
    ).rejects.toThrow('Field refused')

    expect(published.at(-1)).toEqual({
      patch: { title: 'Old title' },
      rollback: true
    })
  })
})
