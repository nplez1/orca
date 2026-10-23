// @vitest-environment happy-dom

import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { JiraCreateField, JiraEditableField, JiraIssue } from '../../../shared/jira-types'
import { JiraIssueEditFieldsDialog } from './jira-issue-edit-fields-dialog'

vi.mock('@/runtime/runtime-jira-client', () => ({
  jiraSearchUsers: vi.fn().mockResolvedValue([])
}))

const issue: JiraIssue = {
  id: 'ABC-1',
  key: 'ABC-1',
  siteId: 'site-1',
  title: 'Fix auth',
  url: 'https://example.atlassian.net/browse/ABC-1',
  project: { id: 'project-1', key: 'ABC', name: 'Payments' },
  issueType: { id: 'story', name: 'Story' },
  status: { id: '1', name: 'Ready', categoryKey: 'new', categoryName: 'To Do' },
  labels: [],
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-02T00:00:00.000Z'
}

/** The dialog only forwards its source, so a decided local owner is enough here. */
const providerSettings = { kind: 'local' } as const

function textField(value: string): JiraEditableField {
  return {
    field: { key: 'customfield_2', name: 'Notes', required: false, schema: { type: 'string' } },
    value
  }
}

afterEach(cleanup)

// Component/s as Jira reports it: `array/items: string` whose entries are references,
// with the project's own component list standing in for the allowedValues Jira omits.
const COMPONENTS_FIELD: JiraCreateField = {
  key: 'components',
  name: 'Component/s',
  required: false,
  schema: { type: 'array', items: 'string', system: 'components' },
  allowedValues: [
    { id: '10400', name: 'Web' },
    { id: '10401', name: 'Platform' }
  ]
}

const QES_FIELD: JiraCreateField = {
  key: 'customfield_13',
  name: 'QEs',
  required: false,
  schema: { type: 'array', items: 'user' }
}

describe('JiraIssueEditFieldsDialog', () => {
  // The reporter's second field: a person list that used to show accountIds.
  it('names the people a multi-user field holds and submits their ids', async () => {
    const user = userEvent.setup()
    const onSubmit = vi.fn().mockResolvedValue({ ok: true })
    render(
      <JiraIssueEditFieldsDialog
        open
        onOpenChange={vi.fn()}
        issue={issue}
        fields={[
          {
            field: QES_FIELD,
            value: 'u-ada, u-grace',
            users: [
              { accountId: 'u-ada', displayName: 'Ada Lovelace' },
              { accountId: 'u-grace', displayName: 'Grace Hopper' }
            ]
          }
        ]}
        providerSettings={providerSettings}
        submitting={false}
        onSubmit={onSubmit}
      />
    )

    const trigger = screen.getByRole('combobox')
    expect(trigger.textContent).toContain('Ada Lovelace, Grace Hopper')
    expect(document.body.textContent).not.toContain('u-ada')

    await user.click(trigger)
    await user.click(await screen.findByRole('option', { name: /Ada Lovelace/ }))
    await user.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() =>
      expect(onSubmit).toHaveBeenCalledWith({
        customFields: { customfield_13: ['u-grace'] },
        userFieldKeys: ['customfield_13'],
        textFieldKeys: []
      })
    )
  })

  // A host that predates the per-user names sends only the joined hint; pairing the two
  // back up is what keeps the picker from showing bare accountIds against it.
  it("pairs an older host's joined names back onto its accountIds", () => {
    render(
      <JiraIssueEditFieldsDialog
        open
        onOpenChange={vi.fn()}
        issue={issue}
        fields={[
          {
            field: QES_FIELD,
            value: 'u-ada, u-grace',
            displayName: 'Ada Lovelace, Grace Hopper'
          }
        ]}
        providerSettings={providerSettings}
        submitting={false}
        onSubmit={vi.fn()}
      />
    )

    const trigger = screen.getByRole('combobox')
    expect(trigger.textContent).toContain('Ada Lovelace, Grace Hopper')
    expect(trigger.textContent).not.toContain('u-ada')
    // Named, so the hint the text box needed would only repeat the trigger.
    expect(document.body.textContent).not.toContain('Current:')
  })

  // When the joined names cannot be lined up with the ids — a name holding a comma, or a
  // count Jira left short — the hint is the only readable form left, so it stays.
  it("keeps the name hint when an older host's names cannot be paired", () => {
    render(
      <JiraIssueEditFieldsDialog
        open
        onOpenChange={vi.fn()}
        issue={issue}
        fields={[
          {
            field: QES_FIELD,
            value: 'u-ada, u-grace',
            displayName: 'Ada Lovelace, Hopper, Grace'
          }
        ]}
        providerSettings={providerSettings}
        submitting={false}
        onSubmit={vi.fn()}
      />
    )

    expect(document.body.textContent).toContain('Current: Ada Lovelace, Hopper, Grace')
  })

  it('submits only the fields the user changed', async () => {
    const user = userEvent.setup()
    const onSubmit = vi.fn().mockResolvedValue({ ok: true })
    render(
      <JiraIssueEditFieldsDialog
        open
        onOpenChange={vi.fn()}
        issue={issue}
        fields={[textField('old')]}
        providerSettings={providerSettings}
        submitting={false}
        onSubmit={onSubmit}
      />
    )

    const input = screen.getByDisplayValue('old')
    await user.clear(input)
    await user.type(input, 'new')
    await user.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() =>
      expect(onSubmit).toHaveBeenCalledWith({
        customFields: { customfield_2: 'new' },
        userFieldKeys: [],
        textFieldKeys: []
      })
    )
  })

  // Issue #162: a bare string array is rejected for Component/s, so the form has to
  // submit a reference per entry.
  it('submits a components change as object references', async () => {
    const user = userEvent.setup()
    const onSubmit = vi.fn().mockResolvedValue({ ok: true })
    render(
      <JiraIssueEditFieldsDialog
        open
        onOpenChange={vi.fn()}
        issue={issue}
        fields={[{ field: COMPONENTS_FIELD, value: '10400', displayName: 'Web' }]}
        providerSettings={providerSettings}
        submitting={false}
        onSubmit={onSubmit}
      />
    )

    const trigger = screen.getByRole('combobox')
    expect(trigger.textContent).toContain('Web')
    expect(trigger.textContent).not.toContain('10400')

    await user.click(trigger)
    await user.click(await screen.findByRole('option', { name: 'Platform' }))
    await user.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() =>
      expect(onSubmit).toHaveBeenCalledWith({
        customFields: { components: [{ id: '10400' }, { id: '10401' }] },
        userFieldKeys: [],
        textFieldKeys: []
      })
    )
  })

  it('clears every component by submitting null', async () => {
    const user = userEvent.setup()
    const onSubmit = vi.fn().mockResolvedValue({ ok: true })
    render(
      <JiraIssueEditFieldsDialog
        open
        onOpenChange={vi.fn()}
        issue={issue}
        fields={[{ field: COMPONENTS_FIELD, value: '10400', displayName: 'Web' }]}
        providerSettings={providerSettings}
        submitting={false}
        onSubmit={onSubmit}
      />
    )

    await user.click(screen.getByRole('combobox'))
    await user.click(await screen.findByRole('option', { name: 'Web' }))
    await user.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() =>
      expect(onSubmit).toHaveBeenCalledWith({
        customFields: { components: null },
        userFieldKeys: [],
        textFieldKeys: []
      })
    )
  })

  it('clears a field Jira already holds a value for', async () => {
    const user = userEvent.setup()
    const onSubmit = vi.fn().mockResolvedValue({ ok: true })
    render(
      <JiraIssueEditFieldsDialog
        open
        onOpenChange={vi.fn()}
        issue={issue}
        fields={[textField('old')]}
        providerSettings={providerSettings}
        submitting={false}
        onSubmit={onSubmit}
      />
    )

    await user.clear(screen.getByDisplayValue('old'))
    await user.click(screen.getByRole('button', { name: 'Save' }))

    // null is the clear; an omitted key would leave the old value behind.
    await waitFor(() =>
      expect(onSubmit).toHaveBeenCalledWith({
        customFields: { customfield_2: null },
        userFieldKeys: [],
        textFieldKeys: []
      })
    )
  })

  it("shows Jira's field-level rejection and keeps the form open", async () => {
    const user = userEvent.setup()
    const onOpenChange = vi.fn()
    const onSubmit = vi.fn().mockResolvedValue({
      ok: false,
      error: 'Dev is required',
      fieldErrors: { customfield_2: 'Dev is required' }
    })
    render(
      <JiraIssueEditFieldsDialog
        open
        onOpenChange={onOpenChange}
        issue={issue}
        fields={[textField('old')]}
        providerSettings={providerSettings}
        submitting={false}
        onSubmit={onSubmit}
      />
    )

    await user.clear(screen.getByDisplayValue('old'))
    await user.click(screen.getByRole('button', { name: 'Save' }))

    expect((await screen.findAllByText('Dev is required')).length).toBeGreaterThan(0)
    expect(onOpenChange).not.toHaveBeenCalledWith(false)
  })

  it('names a changed textarea field so the host can convert it', async () => {
    const user = userEvent.setup()
    const onSubmit = vi.fn().mockResolvedValue({ ok: true })
    render(
      <JiraIssueEditFieldsDialog
        open
        onOpenChange={vi.fn()}
        issue={issue}
        fields={[
          {
            field: {
              key: 'customfield_7',
              name: 'Notes',
              required: false,
              schema: { custom: 'com.atlassian.jira:textarea' }
            },
            value: ''
          }
        ]}
        providerSettings={providerSettings}
        submitting={false}
        onSubmit={onSubmit}
      />
    )

    await user.type(screen.getByRole('textbox'), 'hello')
    await user.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() =>
      expect(onSubmit).toHaveBeenCalledWith({
        customFields: { customfield_7: 'hello' },
        userFieldKeys: [],
        textFieldKeys: ['customfield_7']
      })
    )
  })

  it('shows the current assignee name for a user-picker field', () => {
    render(
      <JiraIssueEditFieldsDialog
        open
        onOpenChange={vi.fn()}
        issue={issue}
        fields={[
          {
            field: {
              key: 'customfield_10001',
              name: 'Dev',
              required: false,
              schema: { type: 'user' }
            },
            value: 'account-9',
            displayName: 'Dev Name'
          }
        ]}
        providerSettings={providerSettings}
        submitting={false}
        onSubmit={vi.fn()}
      />
    )

    expect(screen.getByRole('button', { name: 'Dev' }).textContent).toContain('Dev Name')
  })
})
