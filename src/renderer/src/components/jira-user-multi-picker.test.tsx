// @vitest-environment happy-dom

import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { JiraUser } from '../../../shared/jira/jira-types'
import type { RuntimeJiraSettings } from '@/runtime/runtime-jira-client'
import { JiraUserMultiPicker, jiraHeldUsers } from './jira-user-multi-picker'

const { jiraSearchUsersMock } = vi.hoisted(() => ({ jiraSearchUsersMock: vi.fn() }))

vi.mock('@/runtime/runtime-jira-client', () => ({ jiraSearchUsers: jiraSearchUsersMock }))

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))

const SETTINGS: RuntimeJiraSettings = { kind: 'local' }

function user(accountId: string, displayName: string, email?: string): JiraUser {
  return { accountId, displayName, ...(email ? { email } : {}) }
}

const ADA = user('u-ada', 'Ada Lovelace', 'ada@example.com')
const GRACE = user('u-grace', 'Grace Hopper')
const ZED = user('u-zed', 'Zed Shaw')

afterEach(cleanup)

beforeEach(() => {
  jiraSearchUsersMock.mockReset()
  jiraSearchUsersMock.mockResolvedValue([ADA, GRACE, ZED])
})

describe('jiraHeldUsers', () => {
  it('names each held accountId in draft order', () => {
    expect(jiraHeldUsers([GRACE, ADA], 'u-grace, u-ada').map((entry) => entry.displayName)).toEqual(
      ['Grace Hopper', 'Ada Lovelace']
    )
  })

  // The row has to exist, or a held account the site gives no name for could never be
  // removed from the field.
  it('falls back to the accountId when no name is known', () => {
    expect(jiraHeldUsers([], 'u-ghost')).toEqual([{ accountId: 'u-ghost', displayName: 'u-ghost' }])
  })
})

describe('JiraUserMultiPicker', () => {
  function renderPicker(value: string, users: JiraUser[], onChange = vi.fn()): void {
    render(
      <JiraUserMultiPicker
        providerSettings={SETTINGS}
        value={value}
        users={users}
        onChange={onChange}
        label="QEs"
        placeholder="Select QEs"
      />
    )
  }

  it('reads back the names of the accountIds it holds, never the accountIds', () => {
    renderPicker('u-ada, u-grace', [ADA, GRACE])

    const trigger = screen.getByRole('combobox')
    expect(trigger.textContent).toContain('Ada Lovelace, Grace Hopper')
    expect(trigger.textContent).not.toContain('u-ada')
    expect(trigger.textContent).not.toContain('u-grace')
  })

  it('asks for a choice by name when the field is unset', () => {
    renderPicker('', [])

    expect(screen.getByRole('combobox').textContent).toContain('Select QEs')
  })

  it('adds a person picked from the search and keeps the people already held', async () => {
    const userEventSetup = userEvent.setup()
    const onChange = vi.fn()
    renderPicker('u-ada', [ADA], onChange)

    await userEventSetup.click(screen.getByRole('combobox'))
    await userEventSetup.click(await screen.findByRole('option', { name: 'Zed Shaw' }))

    expect(onChange).toHaveBeenCalledWith([ADA, ZED])
  })

  it('removes a person already held', async () => {
    const userEventSetup = userEvent.setup()
    const onChange = vi.fn()
    renderPicker('u-ada, u-grace', [ADA, GRACE], onChange)

    await userEventSetup.click(screen.getByRole('combobox'))
    const held = await screen.findByRole('option', { name: /Ada Lovelace/ })
    expect(held.getAttribute('data-state')).toBe('checked')
    await userEventSetup.click(held)

    expect(onChange).toHaveBeenCalledWith([GRACE])
  })

  it('leaves a person already held out of the search results', async () => {
    const userEventSetup = userEvent.setup()
    renderPicker('u-ada', [ADA])

    await userEventSetup.click(screen.getByRole('combobox'))

    // Ada appears once — as the held row, not again among the results.
    expect(await screen.findAllByRole('option', { name: /Ada Lovelace/ })).toHaveLength(1)
  })

  it('searches the site for a person by name', async () => {
    const userEventSetup = userEvent.setup()
    renderPicker('', [])

    await userEventSetup.click(screen.getByRole('combobox'))
    await userEventSetup.type(await screen.findByPlaceholderText('Search users'), 'grace')

    await waitFor(() =>
      expect(jiraSearchUsersMock).toHaveBeenLastCalledWith(SETTINGS, 'grace', undefined)
    )
  })
})
