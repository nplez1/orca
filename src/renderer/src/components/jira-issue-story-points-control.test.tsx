// @vitest-environment happy-dom

import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ComponentProps } from 'react'
import type { JiraEditableField, JiraIssue } from '../../../shared/jira-types'
import { JiraIssueStoryPointsControl } from './jira-issue-story-points-control'

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string, options?: Record<string, unknown>) =>
    fallback.replace(/\{\{(\w+)\}\}/g, (_match, name: string) => String(options?.[name] ?? ''))
}))

const FLOAT = 'com.atlassian.jira.plugin.system.customfieldtypes:float'

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

function pointsField(value: string, key = 'customfield_10016'): JiraEditableField {
  return {
    field: {
      key,
      name: 'Story Points',
      required: false,
      schema: { type: 'number', custom: FLOAT }
    },
    value
  }
}

type MutateIssue = ComponentProps<typeof JiraIssueStoryPointsControl>['mutateIssue']

function renderControl({
  displayed = issue(),
  editFields = [pointsField('')],
  pendingField = null,
  mutateIssue = vi.fn<MutateIssue>(async () => ({ ok: true }))
}: {
  displayed?: JiraIssue
  editFields?: JiraEditableField[]
  pendingField?: string | null
  mutateIssue?: MutateIssue
} = {}): MutateIssue {
  render(
    <JiraIssueStoryPointsControl
      displayed={displayed}
      editFields={editFields}
      pendingField={pendingField}
      mutateIssue={mutateIssue}
    />
  )
  return mutateIssue
}

afterEach(cleanup)

describe('JiraIssueStoryPointsControl', () => {
  it('shows the points the issue holds and writes a new value', async () => {
    const user = userEvent.setup()
    const mutateIssue = renderControl({ displayed: issue(5), editFields: [pointsField('5')] })

    await user.click(screen.getByRole('button', { name: 'Story points: 5' }))
    const input = screen.getByLabelText('Story points')
    await user.clear(input)
    await user.type(input, '8')
    await user.click(screen.getByRole('button', { name: 'Save' }))

    expect(mutateIssue).toHaveBeenCalledWith(
      'storyPoints',
      { customFields: { customfield_10016: 8 } },
      { storyPoints: 8 }
    )
  })

  it('clears the points when the value is emptied', async () => {
    const user = userEvent.setup()
    const mutateIssue = renderControl({ displayed: issue(5), editFields: [pointsField('5')] })

    await user.click(screen.getByRole('button', { name: 'Story points: 5' }))
    await user.clear(screen.getByLabelText('Story points'))
    await user.click(screen.getByRole('button', { name: 'Save' }))

    // null is the clear; an omitted key would leave the old points behind.
    expect(mutateIssue).toHaveBeenCalledWith(
      'storyPoints',
      { customFields: { customfield_10016: null } },
      { storyPoints: undefined }
    )
  })

  it('offers nothing to submit until the value changes', async () => {
    const user = userEvent.setup()
    renderControl({ displayed: issue(5), editFields: [pointsField('5')] })

    await user.click(screen.getByRole('button', { name: 'Story points: 5' }))

    expect(screen.getByRole('button', { name: 'Save' }).hasAttribute('disabled')).toBe(true)
  })

  it('keeps the field open with its draft when Jira rejects the write', async () => {
    const user = userEvent.setup()
    const mutateIssue = vi.fn<MutateIssue>(async () => ({ ok: false, error: 'Not a number' }))
    renderControl({ displayed: issue(5), editFields: [pointsField('5')], mutateIssue })

    await user.click(screen.getByRole('button', { name: 'Story points: 5' }))
    const input = screen.getByLabelText('Story points')
    await user.clear(input)
    await user.type(input, '8')
    await user.click(screen.getByRole('button', { name: 'Save' }))

    expect(await screen.findByRole('spinbutton', { name: 'Story points' })).toBeTruthy()
    expect(screen.getByDisplayValue('8')).toBeTruthy()
  })

  it('leaves a number field that is not the story-points field alone', () => {
    renderControl({
      editFields: [
        {
          field: {
            key: 'customfield_2',
            name: 'Budget',
            required: false,
            schema: { type: 'number', custom: FLOAT }
          },
          value: '10'
        }
      ]
    })

    // Nothing to show and nothing Jira offers to write, so no control at all.
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('shows points Jira will not let this user write', () => {
    renderControl({ displayed: issue(3), editFields: [] })

    expect(screen.getByText('3')).toBeTruthy()
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('renders no control for an issue with no points and no writable field', () => {
    renderControl({ displayed: issue(), editFields: [] })

    expect(screen.queryByTitle('Story points')).toBeNull()
    expect(screen.queryByRole('button')).toBeNull()
  })
})
