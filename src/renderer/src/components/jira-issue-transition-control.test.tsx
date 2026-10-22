// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { JiraIssueTransitionControl } from './jira-issue-transition-control'
import type { JiraIssue, JiraTransition } from '../../../shared/jira-types'

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string, values?: Record<string, string>) =>
    fallback.replace(/{{(\w+)}}/g, (_match, key) => values?.[key] ?? '')
}))
afterEach(cleanup)
const status = { id: '1', name: 'Open', categoryKey: 'new', categoryName: 'To Do' }
const issue: JiraIssue = {
  id: '1',
  key: 'APP-1',
  title: 'Fix login',
  url: 'https://jira.example.com/browse/APP-1',
  project: { id: '1', key: 'APP', name: 'App' },
  issueType: { id: '1', name: 'Bug' },
  status,
  labels: [],
  createdAt: '',
  updatedAt: ''
}
const close: JiraTransition = { id: '31', name: 'Close', to: { ...status, id: '3', name: 'Done' } }

async function choose(
  transitions: JiraTransition[],
  onTransition = vi.fn().mockResolvedValue({ ok: true })
) {
  render(
    <JiraIssueTransitionControl
      issue={issue}
      transitions={transitions}
      loading={false}
      error={null}
      pending={false}
      onRetry={vi.fn()}
      onTransition={onTransition}
    />
  )
  fireEvent.click(screen.getByRole('button', { name: 'Change status: Open' }))
  fireEvent.click(await screen.findByRole('button', { name: 'Close' }))
  return onTransition
}

describe('Jira transition control', () => {
  it('applies simple transitions in one click', async () => {
    const mutate = await choose([close])
    await waitFor(() =>
      expect(mutate).toHaveBeenCalledExactlyOnceWith({ transitionId: '31' }, close)
    )
  })

  it('collects required resolution and comment before posting', async () => {
    const transition: JiraTransition = {
      ...close,
      fields: [
        {
          key: 'resolution',
          name: 'Resolution',
          required: true,
          allowedValues: [{ id: '1', name: 'Fixed' }]
        },
        { key: 'comment', name: 'Comment', required: true }
      ]
    }
    const mutate = await choose([transition])
    expect(mutate).not.toHaveBeenCalled()
    const submit = screen.getByRole('button', { name: 'Change status' })
    expect(submit.hasAttribute('disabled')).toBe(true)
    fireEvent.click(screen.getByRole('combobox'))
    fireEvent.click(await screen.findByRole('option', { name: 'Fixed' }))
    fireEvent.change(screen.getByLabelText('Comment'), { target: { value: 'Verified fix' } })
    fireEvent.click(submit)
    await waitFor(() =>
      expect(mutate).toHaveBeenCalledWith(
        {
          transitionId: '31',
          transitionFields: { resolution: { id: '1' } },
          transitionComment: 'Verified fix'
        },
        transition
      )
    )
  })

  it('retains required choices through rejected-save reload and metadata retry', async () => {
    const transition: JiraTransition = {
      ...close,
      fields: [
        {
          key: 'resolution',
          name: 'Resolution',
          required: true,
          allowedValues: [{ id: '1', name: 'Fixed' }]
        },
        { key: 'comment', name: 'Comment', required: true }
      ]
    }
    const mutate = vi.fn().mockResolvedValue({ ok: false, error: 'Jira rejected the resolution.' })
    const retry = vi.fn()
    const props = {
      issue,
      transitions: [transition],
      loading: false,
      error: null,
      pending: false,
      onRetry: retry,
      onTransition: mutate
    }
    const view = render(<JiraIssueTransitionControl {...props} />)
    fireEvent.click(screen.getByRole('button', { name: 'Change status: Open' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Close' }))
    fireEvent.click(screen.getByRole('combobox'))
    fireEvent.click(await screen.findByRole('option', { name: 'Fixed' }))
    fireEvent.change(screen.getByLabelText('Comment'), { target: { value: 'Verified fix' } })
    fireEvent.click(screen.getByRole('button', { name: 'Change status' }))
    expect((await screen.findByRole('alert')).textContent).toContain('Jira rejected')

    view.rerender(<JiraIssueTransitionControl {...props} loading />)
    expect(screen.getByLabelText('Comment').getAttribute('disabled')).not.toBeNull()
    expect(screen.getByDisplayValue('Verified fix')).toBeTruthy()
    expect(screen.getByRole('combobox').textContent).toContain('Fixed')
    view.rerender(<JiraIssueTransitionControl {...props} error="Metadata unavailable" />)
    expect(screen.getByDisplayValue('Verified fix')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Change status' }).hasAttribute('disabled')).toBe(
      true
    )
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(retry).toHaveBeenCalledOnce()

    view.rerender(<JiraIssueTransitionControl {...props} />)
    mutate.mockResolvedValue({ ok: true })
    fireEvent.click(screen.getByRole('button', { name: 'Change status' }))
    await waitFor(() => expect(mutate).toHaveBeenCalledTimes(2))
    expect(mutate.mock.calls[1]).toEqual(mutate.mock.calls[0])
  })

  it('collects a required custom field instead of refusing the transition', async () => {
    const mutate = await choose([
      {
        ...close,
        fields: [
          {
            key: 'customfield_123',
            name: 'Close reason',
            required: true,
            schema: { type: 'option' },
            allowedValues: [{ id: '9', value: 'Fixed' }]
          }
        ]
      }
    ])
    expect(mutate).not.toHaveBeenCalled()
    const submit = screen.getByRole('button', { name: 'Change status' })
    expect(submit.hasAttribute('disabled')).toBe(true)
    fireEvent.click(screen.getByRole('combobox'))
    fireEvent.click(await screen.findByRole('option', { name: 'Fixed' }))
    fireEvent.click(submit)
    await waitFor(() =>
      expect(mutate).toHaveBeenCalledExactlyOnceWith(
        {
          transitionId: '31',
          transitionFields: { customfield_123: { id: '9' } }
        },
        expect.objectContaining({ id: '31' })
      )
    )
  })

  it('moves without asking when the issue already fills the required field', async () => {
    const mutate = await choose([
      {
        ...close,
        fields: [
          {
            key: 'components',
            name: 'Component/s',
            required: true,
            currentValue: '10400',
            currentDisplayValue: 'Web',
            schema: { type: 'array', items: 'string' }
          }
        ]
      }
    ])
    await waitFor(() =>
      expect(mutate).toHaveBeenCalledExactlyOnceWith({ transitionId: '31' }, expect.anything())
    )
  })

  it('names the field Jira rejects beside its own control', async () => {
    const mutate = await choose(
      [
        {
          ...close,
          fields: [
            {
              key: 'customfield_123',
              name: 'Close reason',
              required: true,
              schema: { type: 'string' }
            }
          ]
        }
      ],
      vi.fn().mockResolvedValue({
        ok: false,
        error: 'Jira rejected the update.',
        fieldErrors: { customfield_123: 'Close reason is not one of the allowed values.' }
      })
    )
    const input = screen.getByPlaceholderText('Enter Close reason')
    fireEvent.change(input, { target: { value: 'something' } })
    const form = input.closest('form')
    if (!form) {
      throw new Error('Expected the transition form')
    }
    fireEvent.submit(form)
    expect(await screen.findByText('Close reason is not one of the allowed values.')).toBeTruthy()
    expect(mutate).toHaveBeenCalledTimes(1)
    // Why the form still stands: the value can be fixed and submitted again.
    expect(screen.getByPlaceholderText('Enter Close reason')).toBeTruthy()
  })

  it('keeps failures visible and exposes Jira fallback', async () => {
    await choose(
      [close],
      vi.fn().mockResolvedValue({ ok: false, error: 'Resolution is required.' })
    )
    expect((await screen.findByRole('alert')).textContent).toContain('Resolution is required.')
    expect(screen.getByRole('button', { name: 'Open in Jira' })).toBeTruthy()
  })

  it('keeps a rejected mutation visible and offers Jira fallback', async () => {
    await choose([close], vi.fn().mockRejectedValue(new Error('Disconnected from Jira host.')))
    expect((await screen.findByRole('alert')).textContent).toContain('Disconnected from Jira host.')
    expect(screen.getByRole('button', { name: 'Open in Jira' })).toBeTruthy()
  })

  it('makes transition load failures retryable instead of disabling the status pill', async () => {
    const retry = vi.fn()
    render(
      <JiraIssueTransitionControl
        issue={issue}
        transitions={[]}
        loading={false}
        error="Service unavailable"
        pending={false}
        onRetry={retry}
        onTransition={vi.fn()}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: 'Change status: Open' }))
    expect((await screen.findByRole('alert')).textContent).toContain(
      'Could not load status changes.'
    )
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(retry).toHaveBeenCalledOnce()
  })
})
