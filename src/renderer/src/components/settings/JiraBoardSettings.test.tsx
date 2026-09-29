// @vitest-environment happy-dom

import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createGlobalSettingsFixture } from '../../../../shared/global-settings-test-fixture'
import type { JiraBoard } from '../../../../shared/jira-types'
import { JiraBoardSettings } from './JiraBoardSettings'

const mocks = vi.hoisted(() => ({
  checkJiraConnection: vi.fn().mockResolvedValue(undefined),
  jiraListBoards: vi.fn()
}))

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: unknown) => unknown) =>
    selector({
      jiraStatus: {
        connected: true,
        viewer: { accountId: 'viewer-1', displayName: 'Ada', email: null },
        activeSiteId: 'site-1',
        selectedSiteId: 'site-1'
      },
      checkJiraConnection: mocks.checkJiraConnection,
      settingsSearchQuery: ''
    })
}))

vi.mock('@/runtime/runtime-jira-client', () => ({
  jiraListBoards: (...args: unknown[]) => mocks.jiraListBoards(...args)
}))

const boards: JiraBoard[] = [
  { id: '42', name: 'Payments', type: 'scrum', siteId: 'site-1', siteName: 'Example Jira' }
]

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('JiraBoardSettings', () => {
  it('loads the configured site boards and saves the picked default board', async () => {
    const user = userEvent.setup()
    const updateSettings = vi.fn()
    mocks.jiraListBoards.mockResolvedValue(boards)
    const settings = createGlobalSettingsFixture({ defaultJiraBoard: null })

    const { container } = render(
      <JiraBoardSettings settings={settings} updateSettings={updateSettings} />
    )
    await waitFor(() =>
      expect(mocks.jiraListBoards).toHaveBeenCalledWith(
        { activeRuntimeEnvironmentId: settings.activeRuntimeEnvironmentId },
        'site-1',
        undefined
      )
    )
    expect(container.querySelector('[data-settings-section="tasks-jira-board"]')).not.toBeNull()

    await user.click(screen.getByRole('combobox', { name: 'Default board' }))
    await user.click(await screen.findByRole('option', { name: 'Payments' }))
    expect(updateSettings).toHaveBeenCalledWith({
      defaultJiraBoard: { boardId: '42', siteId: 'site-1', name: 'Payments' }
    })
  })

  it('re-enables the selector and offers retry when the board list read fails', async () => {
    mocks.jiraListBoards.mockRejectedValue(new Error('Jira board list request timed out.'))
    const settings = createGlobalSettingsFixture({
      defaultJiraBoard: { boardId: '42', siteId: 'site-1' }
    })

    render(<JiraBoardSettings settings={settings} updateSettings={vi.fn()} />)

    await screen.findByRole('alert')
    await waitFor(() =>
      expect(screen.getByRole('combobox', { name: 'Default board' }).hasAttribute('disabled')).toBe(
        false
      )
    )
    expect(screen.getByRole('button', { name: 'Retry' })).not.toBeNull()
  })

  it('searches boards by name on the server instead of paging the whole site', async () => {
    const user = userEvent.setup()
    mocks.jiraListBoards.mockResolvedValue(boards)
    const settings = createGlobalSettingsFixture({ defaultJiraBoard: null })

    render(<JiraBoardSettings settings={settings} updateSettings={vi.fn()} />)
    await user.click(screen.getByRole('combobox', { name: 'Default board' }))
    await user.type(await screen.findByPlaceholderText('Search boards by name...'), 'Nebulite')

    await waitFor(() =>
      expect(mocks.jiraListBoards).toHaveBeenCalledWith(
        { activeRuntimeEnvironmentId: settings.activeRuntimeEnvironmentId },
        'site-1',
        'Nebulite'
      )
    )
  })

  it('says no boards match instead of rendering an empty list', async () => {
    const user = userEvent.setup()
    mocks.jiraListBoards.mockResolvedValue([])
    const settings = createGlobalSettingsFixture({ defaultJiraBoard: null })

    render(<JiraBoardSettings settings={settings} updateSettings={vi.fn()} />)
    await user.click(screen.getByRole('combobox', { name: 'Default board' }))
    // The permanent "No default board" row keeps the list non-empty, so the picker has
    // to render its own empty state.
    expect(await screen.findByText('No boards match this search.')).not.toBeNull()
  })

  it('names a saved board that the fetched page does not contain', async () => {
    mocks.jiraListBoards.mockResolvedValue([])
    const settings = createGlobalSettingsFixture({
      defaultJiraBoard: { boardId: '37169', siteId: 'site-1', name: 'Ps Nebulite Scrum Board' }
    })

    render(<JiraBoardSettings settings={settings} updateSettings={vi.fn()} />)

    expect((await screen.findByRole('combobox', { name: 'Default board' })).textContent).toContain(
      'Ps Nebulite Scrum Board'
    )
  })
})
