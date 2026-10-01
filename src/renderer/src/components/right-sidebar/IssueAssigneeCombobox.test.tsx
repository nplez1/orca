// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { IssueAssigneeCombobox, type IssueAssigneeOption } from './IssueAssigneeCombobox'

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback?: string) => fallback ?? _key
}))

const ALICE: IssueAssigneeOption = { id: 'u-alice', label: 'Alice' }
const BOB: IssueAssigneeOption = { id: 'u-bob', label: 'Bob' }
const ZED: IssueAssigneeOption = { id: 'u-zed', label: 'Zed' }

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

function personButtonLabels(): string[] {
  return screen
    .getAllByRole('button')
    .filter((button) => button.hasAttribute('aria-pressed'))
    .map((button) => button.textContent ?? '')
}

function openCombobox(): void {
  fireEvent.click(screen.getByRole('button', { name: /^Assignee/ }))
}

describe('IssueAssigneeCombobox', () => {
  it('lists the roster on open with the current user pinned first', () => {
    render(
      <IssueAssigneeCombobox
        label="Assignee"
        roster={[ALICE, BOB]}
        selected={[]}
        isSelf={(option) => option.id === 'u-bob'}
        onSelect={() => {}}
        onUnassign={() => {}}
      />
    )
    openCombobox()
    expect(personButtonLabels()[0]).toContain('Bob')
    expect(personButtonLabels()[0]).toContain('You')
    expect(personButtonLabels()[1]).toContain('Alice')
  })

  it('filters the roster client-side when there is no directory search', () => {
    render(
      <IssueAssigneeCombobox
        label="Assignee"
        roster={[ALICE, BOB]}
        selected={[]}
        onSelect={() => {}}
      />
    )
    openCombobox()
    fireEvent.change(screen.getByPlaceholderText('Search people'), { target: { value: 'al' } })
    expect(personButtonLabels().some((label) => label.includes('Alice'))).toBe(true)
    expect(personButtonLabels().some((label) => label.includes('Bob'))).toBe(false)
  })

  it('searches the wider directory when a search is provided', async () => {
    const search = vi.fn().mockResolvedValue([ZED])
    render(
      <IssueAssigneeCombobox
        label="Assignee"
        roster={[ALICE, BOB]}
        selected={[]}
        search={search}
        onSelect={() => {}}
      />
    )
    openCombobox()
    expect(personButtonLabels().some((label) => label.includes('Alice'))).toBe(true)
    expect(personButtonLabels().some((label) => label.includes('Bob'))).toBe(true)

    fireEvent.change(screen.getByPlaceholderText('Search people'), { target: { value: 'zed' } })
    await waitFor(() => expect(search).toHaveBeenCalledWith('zed'))
    await waitFor(() =>
      expect(personButtonLabels().some((label) => label.includes('Zed'))).toBe(true)
    )
  })

  it('matches a typed query against a secondary identity (login/email)', () => {
    render(
      <IssueAssigneeCombobox
        label="Assignee"
        roster={[
          { id: 'u-ren', label: 'Ren', login: 'ren-gh' },
          { id: 'u-sam', label: 'Sam', email: 'sam@example.com' }
        ]}
        selected={[]}
        onSelect={() => {}}
      />
    )
    openCombobox()
    const input = screen.getByPlaceholderText('Search people')
    fireEvent.change(input, { target: { value: 'ren-gh' } })
    expect(personButtonLabels().some((label) => label.includes('Ren'))).toBe(true)
    fireEvent.change(input, { target: { value: 'sam@example' } })
    expect(personButtonLabels().some((label) => label.includes('Sam'))).toBe(true)
  })

  it('clears the previous directory results while a new search is in flight', async () => {
    const search = vi
      .fn()
      .mockResolvedValueOnce([ALICE])
      .mockImplementationOnce(() => new Promise<IssueAssigneeOption[]>(() => {}))
    render(
      <IssueAssigneeCombobox
        label="Assignee"
        roster={[]}
        selected={[]}
        search={search}
        onSelect={() => {}}
      />
    )
    openCombobox()
    const input = screen.getByPlaceholderText('Search people')
    fireEvent.change(input, { target: { value: 'al' } })
    await waitFor(() =>
      expect(personButtonLabels().some((label) => label.includes('Alice'))).toBe(true)
    )

    fireEvent.change(input, { target: { value: 'alx' } })
    expect(screen.getByText('Searching…')).toBeTruthy()
    expect(personButtonLabels().some((label) => label.includes('Alice'))).toBe(false)
  })

  it('reports the selected option', () => {
    const onSelect = vi.fn()
    render(
      <IssueAssigneeCombobox
        label="Assignee"
        roster={[ALICE, BOB]}
        selected={[]}
        onSelect={onSelect}
      />
    )
    openCombobox()
    fireEvent.click(screen.getByText('Alice'))
    expect(onSelect).toHaveBeenCalledWith(ALICE)
  })
})
