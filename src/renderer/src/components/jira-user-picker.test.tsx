// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { JiraUser } from '../../../shared/jira-types'
import type { RuntimeJiraSettings } from '@/runtime/runtime-jira-target'
import { JiraUserPicker, splitJiraUserPickerOptions } from './jira-user-picker'

vi.mock('@/runtime/runtime-jira-client', () => ({ jiraSearchUsers: vi.fn() }))

const SETTINGS: RuntimeJiraSettings = { kind: 'local' }

function user(accountId: string, displayName: string, email?: string): JiraUser {
  return { accountId, displayName, email }
}

const ADA = user('u-ada', 'Ada Lovelace', 'ada@example.com')
const GRACE = user('u-grace', 'Grace Hopper')
const ZED = user('u-zed', 'Zed Shaw')

afterEach(cleanup)

describe('splitJiraUserPickerOptions', () => {
  it("keeps the caller's order in the pinned group and drops a pinned duplicate", () => {
    expect(
      splitJiraUserPickerOptions({
        candidates: [GRACE, ADA, ZED],
        pinned: [ADA, GRACE, GRACE],
        query: ''
      })
    ).toEqual({ pinned: [ADA, GRACE], rest: [ZED] })
  })

  it('narrows the pinned side by the query, over the name or the email', () => {
    expect(
      splitJiraUserPickerOptions({ candidates: [GRACE, ZED], pinned: [ADA], query: 'ada@' })
    ).toEqual({ pinned: [ADA], rest: [GRACE, ZED] })
    expect(
      splitJiraUserPickerOptions({ candidates: [GRACE, ZED], pinned: [ADA], query: 'SHAW' })
    ).toEqual({ pinned: [], rest: [GRACE, ZED] })
  })

  it('leaves a pinned person in the results when the query only matches them there', () => {
    const { pinned, rest } = splitJiraUserPickerOptions({
      candidates: [ADA, ZED],
      pinned: [ADA],
      query: 'zed'
    })
    expect(pinned).toEqual([])
    expect(rest).toEqual([ADA, ZED])
  })
})

describe('JiraUserPicker', () => {
  function renderPicker(search: (query: string) => Promise<JiraUser[]>, onSelect = () => {}): void {
    render(
      <JiraUserPicker
        providerSettings={SETTINGS}
        value=""
        selectedUser={null}
        onSelect={onSelect}
        label="Assignee"
        searchUsers={search}
      />
    )
  }

  it('searches again for the typed query and drops the previous matches', async () => {
    const search = vi.fn().mockResolvedValueOnce([GRACE]).mockResolvedValueOnce([ZED])
    renderPicker(search)
    fireEvent.click(screen.getByRole('button', { name: 'Assignee' }))
    await screen.findByRole('button', { name: 'Grace Hopper' })

    fireEvent.change(screen.getByPlaceholderText('Search users'), { target: { value: 'zed' } })
    await waitFor(() => expect(search).toHaveBeenLastCalledWith('zed'))
    await screen.findByRole('button', { name: 'Zed Shaw' })
    expect(screen.queryByRole('button', { name: 'Grace Hopper' })).toBeNull()
  })

  it('clears the previous matches while the next query is in flight', async () => {
    const search = vi
      .fn()
      .mockResolvedValueOnce([GRACE])
      .mockImplementationOnce(() => new Promise<JiraUser[]>(() => {}))
    renderPicker(search)
    fireEvent.click(screen.getByRole('button', { name: 'Assignee' }))
    await screen.findByRole('button', { name: 'Grace Hopper' })

    fireEvent.change(screen.getByPlaceholderText('Search users'), { target: { value: 'zed' } })
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Grace Hopper' })).toBeNull())
  })

  it('reports the picked user and closes the popover', async () => {
    const onSelect = vi.fn()
    renderPicker(vi.fn().mockResolvedValue([GRACE]), onSelect)
    fireEvent.click(screen.getByRole('button', { name: 'Assignee' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Grace Hopper' }))

    expect(onSelect).toHaveBeenCalledWith(GRACE)
    await waitFor(() => expect(screen.queryByPlaceholderText('Search users')).toBeNull())
  })
})
