// @vitest-environment happy-dom

import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createGlobalSettingsFixture } from '../../../shared/global-settings-test-fixture'
import type { JiraEditableField, JiraIssue } from '../../../shared/jira-types'
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

const providerSettings = {
  kind: 'default-scope' as const,
  settings: createGlobalSettingsFixture()
}

function textField(value: string): JiraEditableField {
  return {
    field: { key: 'customfield_2', name: 'Notes', required: false, schema: { type: 'string' } },
    value
  }
}

afterEach(cleanup)

describe('JiraIssueEditFieldsDialog', () => {
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
        userFieldKeys: []
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
        userFieldKeys: []
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
