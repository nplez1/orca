// @vitest-environment happy-dom

import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { JiraCreateFieldAllowedValue } from '../../../shared/jira/jira-types'
import { buildJiraCreateFieldValue } from './task-page/jira/task-page-jira-create-fields'
import {
  JiraOptionMultiSelect,
  jiraOptionLabels,
  jiraOptionToken
} from './jira-option-multi-select'

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))

// The System field as Jira reports it: ids the payload needs, labels a person reads.
const SYSTEM: JiraCreateFieldAllowedValue[] = [
  { id: '184354', value: 'mac-intel' },
  { id: '184355', value: 'mar-arm' },
  { id: '184356', value: 'win-intel' },
  { id: '184357', value: 'win-arm' }
]

afterEach(cleanup)

describe('jiraOptionToken', () => {
  it('prefers the id Jira accepts, then the value, then the name', () => {
    expect(jiraOptionToken({ id: '1', value: 'mac-intel', name: 'Mac' })).toBe('1')
    expect(jiraOptionToken({ value: 'mac-intel', name: 'Mac' })).toBe('mac-intel')
    expect(jiraOptionToken({ name: 'Mac' })).toBe('Mac')
  })
})

describe('jiraOptionLabels', () => {
  it('names every token the allowed-value list carries', () => {
    expect(jiraOptionLabels(SYSTEM, '184354, 184357')).toEqual(['mac-intel', 'win-arm'])
  })

  it('names a token that arrives as a value rather than an id', () => {
    expect(jiraOptionLabels(SYSTEM, 'mac-intel')).toEqual(['mac-intel'])
  })

  // A value the issue holds but the list omits is already a label on Server/DC, and
  // hiding it would read as "no value" on a field that has one.
  it('keeps a token the list omits rather than dropping the value', () => {
    expect(jiraOptionLabels(SYSTEM, 'retired-option')).toEqual(['retired-option'])
  })
})

describe('JiraOptionMultiSelect', () => {
  function renderControl(value: string, onValueChange = vi.fn()): void {
    render(
      <JiraOptionMultiSelect
        options={SYSTEM}
        value={value}
        onValueChange={onValueChange}
        placeholder="Select System"
      />
    )
  }

  it('reads back the labels of the ids it holds, never the ids themselves', () => {
    renderControl('184354, 184355, 184356, 184357')

    const trigger = screen.getByRole('combobox')
    expect(trigger.textContent).toContain('mac-intel, mar-arm, win-intel, win-arm')
    for (const option of SYSTEM) {
      expect(trigger.textContent).not.toContain(option.id)
    }
  })

  it('asks for a choice by name when the field is unset', () => {
    renderControl('')

    expect(screen.getByRole('combobox').textContent).toContain('Select System')
  })

  it('adds an option by its label and submits the id', async () => {
    const user = userEvent.setup()
    const onValueChange = vi.fn()
    renderControl('184354, 184355', onValueChange)

    await user.click(screen.getByRole('combobox'))
    await user.click(await screen.findByRole('option', { name: 'win-intel' }))

    expect(onValueChange).toHaveBeenCalledWith('184354, 184355, 184356')
  })

  it('removes an option by its label and keeps the rest', async () => {
    const user = userEvent.setup()
    const onValueChange = vi.fn()
    renderControl('184354, 184355', onValueChange)

    await user.click(screen.getByRole('combobox'))
    await user.click(await screen.findByRole('option', { name: 'mac-intel' }))

    expect(onValueChange).toHaveBeenCalledWith('184355')
  })

  it('lists every option by label', async () => {
    const user = userEvent.setup()
    renderControl('')

    await user.click(screen.getByRole('combobox'))

    expect((await screen.findAllByRole('option')).map((option) => option.textContent)).toEqual([
      'mac-intel',
      'mar-arm',
      'win-intel',
      'win-arm'
    ])
  })

  it('searches on labels only, so an id finds nothing', async () => {
    const user = userEvent.setup()
    renderControl('')

    await user.click(screen.getByRole('combobox'))
    await user.type(await screen.findByPlaceholderText('Search options...'), '184')

    expect(await screen.findByText('No options match your search.')).toBeTruthy()
  })

  it('narrows the list to the labels that match', async () => {
    const user = userEvent.setup()
    renderControl('')

    await user.click(screen.getByRole('combobox'))
    await user.type(await screen.findByPlaceholderText('Search options...'), 'win')

    expect((await screen.findAllByRole('option')).map((option) => option.textContent)).toEqual([
      'win-intel',
      'win-arm'
    ])
  })

  it('ticks the option a value-form token names, so one option is never picked twice', async () => {
    const user = userEvent.setup()
    const onValueChange = vi.fn()
    // A draft the edit form resolved by value rather than by id.
    renderControl('mac-intel', onValueChange)

    await user.click(screen.getByRole('combobox'))
    const macIntel = await screen.findByRole('option', { name: 'mac-intel' })
    expect(macIntel.getAttribute('data-state')).toBe('checked')

    await user.click(macIntel)

    expect(onValueChange).toHaveBeenCalledWith('')
  })

  // Jira drops a value from the allowed list when it is disabled or removed, but the
  // issue keeps holding it. Without a row of its own it could never be cleared.
  it('offers a value Jira no longer names, so it can still be removed', async () => {
    const user = userEvent.setup()
    const onValueChange = vi.fn()
    renderControl('184354, retired-option', onValueChange)

    expect(screen.getByRole('combobox').textContent).toContain('mac-intel, retired-option')

    await user.click(screen.getByRole('combobox'))
    expect((await screen.findAllByRole('option')).map((option) => option.textContent)).toEqual([
      'mac-intel',
      'mar-arm',
      'win-intel',
      'win-arm',
      'retired-option'
    ])

    await user.click(screen.getByRole('option', { name: 'retired-option' }))

    expect(onValueChange).toHaveBeenCalledWith('184354')
  })

  it('submits the ids the labels stand for', async () => {
    const user = userEvent.setup()
    let draft = '184354'
    const field = {
      key: 'customfield_10062',
      name: 'System',
      required: false,
      schema: { type: 'array', items: 'option' },
      allowedValues: SYSTEM
    }
    render(
      <JiraOptionMultiSelect
        options={SYSTEM}
        value={draft}
        onValueChange={(next) => {
          draft = next
        }}
        placeholder="Select System"
      />
    )

    await user.click(screen.getByRole('combobox'))
    await user.click(await screen.findByRole('option', { name: 'win-arm' }))

    expect(buildJiraCreateFieldValue(field, draft)).toEqual([{ id: '184354' }, { id: '184357' }])
  })
})
