// @vitest-environment happy-dom

import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ComponentProps } from 'react'
import type { JiraEditableField, JiraIssue } from '../../../../shared/jira-types'
import { JiraStoryPointsRow } from './jira-story-points-row'

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string, options?: Record<string, unknown>) =>
    fallback.replace(/\{\{(\w+)\}\}/g, (_match, name: string) => String(options?.[name] ?? ''))
}))

const POINTS_FIELD: JiraEditableField = {
  field: {
    key: 'customfield_10016',
    name: 'Story Points',
    required: false,
    schema: { type: 'number', custom: 'com.atlassian.jira.plugin.system.customfieldtypes:float' }
  },
  value: '5'
}

function issue(storyPoints?: number): JiraIssue {
  return {
    id: '1001',
    key: 'ABC-1',
    siteId: 'site-1',
    title: 'Payments issue',
    url: 'https://example.atlassian.net/browse/ABC-1',
    project: { id: 'project-1', key: 'ABC', name: 'Payments' },
    issueType: { id: 'story', name: 'Story' },
    status: { id: '1', name: 'Ready', categoryKey: 'new', categoryName: 'To Do' },
    labels: [],
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-02T00:00:00.000Z',
    ...(storyPoints === undefined ? {} : { storyPoints })
  }
}

type MutateIssue = ComponentProps<typeof JiraStoryPointsRow>['mutateIssue']

function renderRow({
  displayed = issue(5),
  editFields = [POINTS_FIELD],
  mutateIssue = vi.fn<MutateIssue>(async () => ({ ok: true }))
}: {
  displayed?: JiraIssue
  editFields?: JiraEditableField[]
  mutateIssue?: MutateIssue
} = {}): MutateIssue {
  render(
    <JiraStoryPointsRow
      displayed={displayed}
      editFields={editFields}
      pendingField={null}
      mutateIssue={mutateIssue}
    />
  )
  return mutateIssue
}

afterEach(cleanup)

describe('JiraStoryPointsRow', () => {
  it('shows the points in the row and writes a new value from its popover', async () => {
    const user = userEvent.setup()
    const mutateIssue = renderRow()

    await user.click(screen.getByRole('button', { name: /Story points/ }))
    const input = screen.getByRole('spinbutton', { name: 'Story points' })
    await user.clear(input)
    await user.type(input, '3')
    await user.click(screen.getByRole('button', { name: 'Save' }))

    expect(mutateIssue).toHaveBeenCalledWith(
      'storyPoints',
      { customFields: { customfield_10016: 3 } },
      { storyPoints: 3 }
    )
  })

  it('renders no row when the issue has no points and none are writable', () => {
    renderRow({ displayed: issue(), editFields: [] })

    expect(screen.queryByRole('button')).toBeNull()
  })

  it('shows points Jira will not let this user write, without an editor', async () => {
    const user = userEvent.setup()
    renderRow({ editFields: [] })

    expect(screen.getByText('5')).toBeTruthy()
    await user.click(screen.getByRole('button', { name: /Story points/ }))
    expect(screen.queryByRole('spinbutton', { name: 'Story points' })).toBeNull()
  })
})
