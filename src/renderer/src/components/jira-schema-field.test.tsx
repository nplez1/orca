// @vitest-environment happy-dom

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { JiraCreateField } from '../../../shared/jira-types'
import { JiraSchemaFieldControl } from './jira-schema-field'

vi.mock('@/runtime/runtime-jira-client', () => ({
  jiraSearchUsers: vi.fn().mockResolvedValue([])
}))

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string, values?: Record<string, string>) =>
    Object.entries(values ?? {}).reduce(
      (text, [name, value]) => text.replace(`{{${name}}}`, value),
      fallback
    )
}))

// The System field as the edit form receives it: allowedValues the payload needs,
// labels a person reads.
const SYSTEM: JiraCreateField = {
  key: 'customfield_10062',
  name: 'System',
  required: false,
  schema: { type: 'array', items: 'option' },
  allowedValues: [
    { id: '184354', value: 'mac-intel' },
    { id: '184355', value: 'mar-arm' },
    { id: '184356', value: 'win-intel' },
    { id: '184357', value: 'win-arm' }
  ]
}

afterEach(cleanup)

describe('JiraSchemaFieldControl', () => {
  it('shows a multi-select option field by label, never by option id', () => {
    render(
      <JiraSchemaFieldControl
        field={SYSTEM}
        value="184354, 184355, 184356, 184357"
        onValueChange={vi.fn()}
      />
    )

    const trigger = screen.getByRole('combobox')
    expect(trigger.textContent).toContain('mac-intel, mar-arm, win-intel, win-arm')
    for (const option of SYSTEM.allowedValues ?? []) {
      expect(document.body.textContent).not.toContain(option.id)
    }
    // The "Current:" hint the text box needed has no reason to appear beside a control
    // that already names its value.
    expect(document.body.textContent).not.toContain('Current:')
  })

  it('keeps a plain string list on its comma-separated text box', () => {
    render(
      <JiraSchemaFieldControl
        field={{
          key: 'customfield_10100',
          name: 'Notes',
          required: false,
          schema: { type: 'array', items: 'string' }
        }}
        value="one, two"
        onValueChange={vi.fn()}
      />
    )

    expect(screen.getByRole('textbox')).toBeTruthy()
    expect(screen.queryByRole('combobox')).toBeNull()
  })

  it('shows a multi-user field as a picker of names, not a box of accountIds', () => {
    render(
      <JiraSchemaFieldControl
        field={{
          key: 'customfield_10013',
          name: 'QEs',
          required: false,
          schema: { type: 'array', items: 'user' }
        }}
        value="u-ada, u-grace"
        onValueChange={vi.fn()}
        userField={{
          selectedUser: null,
          onSelectUser: vi.fn(),
          selectedUsers: [
            { accountId: 'u-ada', displayName: 'Ada Lovelace' },
            { accountId: 'u-grace', displayName: 'Grace Hopper' }
          ],
          onSelectUsers: vi.fn(),
          providerSettings: { kind: 'local' }
        }}
      />
    )

    expect(screen.getByRole('combobox').textContent).toContain('Ada Lovelace, Grace Hopper')
    expect(screen.queryByRole('textbox')).toBeNull()
    expect(document.body.textContent).not.toContain('u-ada')
  })

  it('shows a single option field as a select, not a text box', () => {
    render(
      <JiraSchemaFieldControl
        field={{
          key: 'customfield_10101',
          name: 'Severity',
          required: false,
          schema: { type: 'option' },
          allowedValues: [{ id: '2', value: 'High' }]
        }}
        value="2"
        onValueChange={vi.fn()}
      />
    )

    expect(screen.getByRole('combobox')).toBeTruthy()
  })
})
