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
const POINTS_KEY = 'customfield_10016'

function issue(storyPoints?: number, storyPointsFieldId?: string): JiraIssue {
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
    // The host names the field exactly when it found a value, so the fixture does too.
    ...(storyPoints === undefined
      ? {}
      : { storyPoints, storyPointsFieldId: storyPointsFieldId ?? POINTS_KEY })
  }
}

function pointsField(value: string, key = POINTS_KEY, name = 'Story Points'): JiraEditableField {
  return {
    field: { key, name, required: false, schema: { type: 'number', custom: FLOAT } },
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

    await user.click(screen.getByRole('button', { name: 'Points: 5' }))
    const input = screen.getByLabelText('Story points')
    await user.clear(input)
    await user.type(input, '8')
    await user.click(screen.getByRole('button', { name: 'Save' }))

    expect(mutateIssue).toHaveBeenCalledWith(
      'storyPoints',
      { customFields: { [POINTS_KEY]: 8 } },
      { storyPoints: 8 },
      { reportsInline: true }
    )
  })

  it('clears the points when the value is emptied', async () => {
    const user = userEvent.setup()
    const mutateIssue = renderControl({ displayed: issue(5), editFields: [pointsField('5')] })

    await user.click(screen.getByRole('button', { name: 'Points: 5' }))
    await user.clear(screen.getByLabelText('Story points'))
    await user.click(screen.getByRole('button', { name: 'Save' }))

    // null is the clear; an omitted key would leave the old points behind.
    expect(mutateIssue).toHaveBeenCalledWith(
      'storyPoints',
      { customFields: { [POINTS_KEY]: null } },
      { storyPoints: undefined },
      { reportsInline: true }
    )
  })

  it('names the value without leaning on a plural ending', () => {
    renderControl({ displayed: issue(1), editFields: [pointsField('1')] })

    expect(screen.getByRole('button', { name: 'Points: 1' })).toBeTruthy()
  })

  it('offers nothing to submit until the value changes', async () => {
    const user = userEvent.setup()
    renderControl({ displayed: issue(5), editFields: [pointsField('5')] })

    await user.click(screen.getByRole('button', { name: 'Points: 5' }))

    expect(screen.getByRole('button', { name: 'Save' }).hasAttribute('disabled')).toBe(true)
  })

  it("keeps the field open with its draft and Jira's reason when the write is refused", async () => {
    const user = userEvent.setup()
    const mutateIssue = vi.fn<MutateIssue>(async () => ({ ok: false, error: 'Not a number' }))
    renderControl({ displayed: issue(5), editFields: [pointsField('5')], mutateIssue })

    await user.click(screen.getByRole('button', { name: 'Points: 5' }))
    const input = screen.getByLabelText('Story points')
    await user.clear(input)
    await user.type(input, '8')
    await user.click(screen.getByRole('button', { name: 'Save' }))

    expect(await screen.findByRole('textbox', { name: 'Story points' })).toBeTruthy()
    expect(screen.getByDisplayValue('8')).toBeTruthy()
    // The reason stays where the value it rejected is, rather than in a toast.
    expect(screen.getByRole('alert').textContent).toBe('Not a number')
    expect(input.getAttribute('aria-invalid')).toBe('true')
  })

  it('describes the field with its own message, and with none when there is none', async () => {
    const user = userEvent.setup()
    renderControl({ displayed: issue(5), editFields: [pointsField('5')] })

    await user.click(screen.getByRole('button', { name: 'Points: 5' }))
    const input = screen.getByRole('textbox', { name: 'Story points' })
    const describedBy = input.getAttribute('aria-describedby')

    expect(describedBy).toBeTruthy()
    expect(document.getElementById(describedBy ?? '')?.textContent).toBe(
      'An empty value clears the field.'
    )
  })

  it('points at no description at all when there is nothing to say', async () => {
    const user = userEvent.setup()
    renderControl({ displayed: issue(), editFields: [pointsField('')] })

    await user.click(screen.getByRole('button', { name: 'No points' }))

    expect(
      screen.getByRole('textbox', { name: 'Story points' }).getAttribute('aria-describedby')
    ).toBeNull()
  })

  it('refuses a draft that is not a number instead of reading it as a clear', async () => {
    const user = userEvent.setup()
    const mutateIssue = renderControl({ displayed: issue(5), editFields: [pointsField('5')] })

    await user.click(screen.getByRole('button', { name: 'Points: 5' }))
    const input = screen.getByRole('textbox', { name: 'Story points' })
    await user.clear(input)
    await user.type(input, '5e')

    expect(screen.getByText('Enter a number.')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Save' }).hasAttribute('disabled')).toBe(true)
    expect(mutateIssue).not.toHaveBeenCalled()
  })

  it('keeps the value editable but unsendable while another field is writing', async () => {
    const user = userEvent.setup()
    const mutateIssue = vi.fn<MutateIssue>(async () => ({ ok: true }))
    const props = { displayed: issue(5), editFields: [pointsField('5')], mutateIssue }
    const { rerender } = render(<JiraIssueStoryPointsControl {...props} pendingField={null} />)

    await user.click(screen.getByRole('button', { name: 'Points: 5' }))
    const input = screen.getByRole('textbox', { name: 'Story points' })
    await user.clear(input)
    await user.type(input, '8')
    // Another surface's write can start while this form is already open.
    rerender(<JiraIssueStoryPointsControl {...props} pendingField="labels" />)

    // The write would be refused with an error this form has nowhere to show it.
    expect(screen.getByRole('button', { name: 'Save' }).hasAttribute('disabled')).toBe(true)
    expect(mutateIssue).not.toHaveBeenCalled()
    // Read-only rather than disabled, so this form's own save cannot drop focus.
    expect(screen.getByRole('textbox', { name: 'Story points' }).hasAttribute('readonly')).toBe(
      true
    )
  })

  it('writes the field the issue says its points came from', async () => {
    const user = userEvent.setup()
    const mutateIssue = renderControl({
      displayed: issue(5, 'customfield_10016'),
      editFields: [pointsField('', 'customfield_10020', 'Story point estimate'), pointsField('5')]
    })

    await user.click(screen.getByRole('button', { name: 'Points: 5' }))
    const input = screen.getByRole('textbox', { name: 'Story points' })
    await user.clear(input)
    await user.type(input, '8')
    await user.click(screen.getByRole('button', { name: 'Save' }))

    // The estimate field sorts first, but the value on screen came from this one.
    expect(mutateIssue).toHaveBeenCalledWith(
      'storyPoints',
      { customFields: { [POINTS_KEY]: 8 } },
      { storyPoints: 8 },
      { reportsInline: true }
    )
  })

  it('offers no editor when Jira will not write the field the value came from', () => {
    renderControl({
      displayed: issue(5, 'customfield_99999'),
      editFields: [pointsField('5')]
    })

    // Writing the other field would leave the value on screen unchanged.
    expect(screen.getByText('Points: 5')).toBeTruthy()
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('matches the value for a host that does not name the field', async () => {
    const user = userEvent.setup()
    const mutateIssue = renderControl({
      displayed: { ...issue(5), storyPointsFieldId: undefined },
      editFields: [pointsField('', 'customfield_10020', 'Story point estimate'), pointsField('5')]
    })

    await user.click(screen.getByRole('button', { name: 'Points: 5' }))
    const input = screen.getByRole('textbox', { name: 'Story points' })
    await user.clear(input)
    await user.type(input, '8')
    await user.click(screen.getByRole('button', { name: 'Save' }))

    expect(mutateIssue).toHaveBeenCalledWith(
      'storyPoints',
      { customFields: { [POINTS_KEY]: 8 } },
      { storyPoints: 8 },
      { reportsInline: true }
    )
  })

  it('shows points Jira will not let this user write', () => {
    renderControl({ displayed: issue(3), editFields: [] })

    expect(screen.getByText('Points: 3')).toBeTruthy()
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('renders no control for an issue with no points and no writable field', () => {
    renderControl({ displayed: issue(), editFields: [] })

    expect(screen.queryByTitle('Story points')).toBeNull()
    expect(screen.queryByRole('button')).toBeNull()
  })
})
