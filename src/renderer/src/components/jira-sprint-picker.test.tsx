// @vitest-environment happy-dom

import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { JiraSprint } from '../../../shared/jira-types'
import { JiraSprintPicker } from './jira-sprint-picker'

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))

const sprints: JiraSprint[] = [
  { id: '87', name: 'September sprint', state: 'active' },
  { id: '88', name: 'October sprint', state: 'future' }
]

function renderPicker({
  includeBacklog,
  onSelect = vi.fn(),
  options = sprints,
  current = options[0] ?? null
}: {
  includeBacklog?: boolean
  onSelect?: (sprintId: string | null) => void
  options?: JiraSprint[]
  current?: JiraSprint | null
} = {}): (sprintId: string | null) => void {
  render(
    <JiraSprintPicker
      sprint={current}
      sprints={options}
      onSelect={onSelect}
      includeBacklog={includeBacklog}
    >
      <button type="button">{current?.name ?? '+ Sprint'}</button>
    </JiraSprintPicker>
  )
  return onSelect
}

afterEach(cleanup)

describe('JiraSprintPicker', () => {
  it('reports the chosen sprint', async () => {
    const user = userEvent.setup()
    const onSelect = renderPicker()

    await user.click(screen.getByRole('button', { name: 'September sprint' }))
    await user.click(await screen.findByRole('option', { name: /October sprint/ }))

    expect(onSelect).toHaveBeenCalledWith('88')
  })

  it('reports the backlog when the assignment is cleared', async () => {
    const user = userEvent.setup()
    const onSelect = renderPicker()

    await user.click(screen.getByRole('button', { name: 'September sprint' }))
    await user.click(await screen.findByRole('option', { name: /Backlog/ }))

    expect(onSelect).toHaveBeenCalledWith(null)
  })

  // A backlog row is already in the backlog, so offering it back is a no-op entry.
  it('omits the backlog entry where the caller cannot use it', async () => {
    const user = userEvent.setup()
    renderPicker({ includeBacklog: false })

    await user.click(screen.getByRole('button', { name: 'September sprint' }))

    expect(await screen.findByRole('option', { name: /October sprint/ })).toBeTruthy()
    expect(screen.queryByRole('option', { name: /Backlog/ })).toBeNull()
  })

  it('labels each sprint with its state', async () => {
    const user = userEvent.setup()
    renderPicker()

    await user.click(screen.getByRole('button', { name: 'September sprint' }))

    expect(
      within(await screen.findByRole('option', { name: /October sprint/ })).getByText('Future')
    ).toBeTruthy()
  })

  // The whole point of the search field: a production board has hundreds of sprints.
  it('filters the list by typed text', async () => {
    const user = userEvent.setup()
    renderPicker({
      options: [
        { id: '87', name: 'September sprint', state: 'active' },
        { id: '88', name: 'October sprint', state: 'future' },
        { id: '89', name: 'Payments hardening', state: 'future' }
      ]
    })

    await user.click(screen.getByRole('button', { name: 'September sprint' }))
    await user.type(await screen.findByPlaceholderText('Find a sprint…'), 'payment')

    expect(screen.getByRole('option', { name: /Payments hardening/ })).toBeTruthy()
    expect(screen.queryByRole('option', { name: /October sprint/ })).toBeNull()
  })

  // cmdk's own scorer would accept scattered letters, which turns a search into noise.
  it('does not match a sprint on scattered letters', async () => {
    const user = userEvent.setup()
    renderPicker({
      options: [
        { id: '87', name: 'September sprint', state: 'active' },
        { id: '90', name: 'Project cleanup', state: 'future' }
      ]
    })

    await user.click(screen.getByRole('button', { name: 'September sprint' }))
    await user.type(await screen.findByPlaceholderText('Find a sprint…'), 'oct')

    expect(screen.queryByRole('option', { name: /Project cleanup/ })).toBeNull()
  })

  // The current sprint is listed to show where the issue is; re-picking it is not a move.
  it('reports nothing when the current sprint is picked again', async () => {
    const user = userEvent.setup()
    const onSelect = renderPicker()

    await user.click(screen.getByRole('button', { name: 'September sprint' }))
    await user.click(await screen.findByRole('option', { name: /September sprint/ }))

    expect(onSelect).not.toHaveBeenCalled()
  })

  it('says so when nothing matches', async () => {
    const user = userEvent.setup()
    renderPicker()

    await user.click(screen.getByRole('button', { name: 'September sprint' }))
    await user.type(await screen.findByPlaceholderText('Find a sprint…'), 'zzz')

    expect(await screen.findByText('No sprint matches.')).toBeTruthy()
  })

  it('ranks the sprints around today ahead of the distant ones', async () => {
    const user = userEvent.setup()
    const now = Date.now()
    const day = 24 * 60 * 60 * 1000
    const isoDay = (offset: number): string => new Date(now + offset * day).toISOString()
    renderPicker({
      includeBacklog: false,
      current: { id: 'active', name: 'Current sprint', state: 'active', startDate: isoDay(-7) },
      options: [
        { id: 'far-past', name: 'Stale leftover', state: 'future', startDate: isoDay(-900) },
        { id: 'near', name: 'Next week', state: 'future', startDate: isoDay(7) },
        { id: 'far-future', name: 'Next year', state: 'future', startDate: isoDay(365) },
        { id: 'active', name: 'Current sprint', state: 'active', startDate: isoDay(-7) }
      ]
    })

    await user.click(screen.getByRole('button', { name: 'Current sprint' }))

    expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual([
      'Current sprintActive',
      'Next weekFuture',
      'Next yearFuture',
      'Stale leftoverFuture'
    ])
  })
})
