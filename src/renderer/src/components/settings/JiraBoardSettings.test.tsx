// @vitest-environment happy-dom

import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createGlobalSettingsFixture } from '../../../../shared/settings/global-settings-test-fixture'
import type { JiraBoard, JiraSite } from '../../../../shared/jira/jira-types'
import { JiraBoardSettings } from './JiraBoardSettings'

const mocks = vi.hoisted(() => ({
  checkJiraConnection: vi.fn().mockResolvedValue(undefined),
  jiraListBoards: vi.fn(),
  saveError: vi.fn()
}))

vi.mock('sonner', () => ({ toast: { error: (...args: unknown[]) => mocks.saveError(...args) } }))

const sites: JiraSite[] = [
  {
    id: 'site-1',
    siteUrl: 'https://one.atlassian.net',
    email: 'ada@example.com',
    displayName: 'Example Jira',
    accountId: 'viewer-1'
  }
]

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: unknown) => unknown) =>
    selector({
      jiraStatus: {
        connected: true,
        viewer: { accountId: 'viewer-1', displayName: 'Ada', email: null },
        activeSiteId: 'site-1',
        selectedSiteId: 'site-1',
        sites
      },
      checkJiraConnection: mocks.checkJiraConnection,
      settingsSearchQuery: ''
    })
}))

vi.mock('@/runtime/jira/runtime-jira-client.ts', () => ({
  jiraListBoards: (...args: unknown[]) => mocks.jiraListBoards(...args)
}))

const payments: JiraBoard = {
  id: '42',
  name: 'Payments',
  type: 'scrum',
  siteId: 'site-1',
  siteName: 'Example Jira'
}
const platform: JiraBoard = {
  id: '7',
  name: 'Platform',
  type: 'kanban',
  siteId: 'site-1',
  siteName: 'Example Jira'
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('JiraBoardSettings', () => {
  it('adds a board as a one-element set and mirrors it into the single-board setting', async () => {
    const user = userEvent.setup()
    mocks.jiraListBoards.mockResolvedValue([payments])
    const updateSettings = vi.fn().mockResolvedValue(undefined)
    const settings = createGlobalSettingsFixture({ defaultJiraBoard: null })

    const { container } = render(
      <JiraBoardSettings settings={settings} updateSettingsOrThrow={updateSettings} />
    )
    await waitFor(() =>
      // Why 'all': a saved set spans sites, so the picker must search every connected account.
      expect(mocks.jiraListBoards).toHaveBeenCalledWith({ kind: 'local' }, 'all', undefined)
    )
    expect(container.querySelector('[data-settings-section="tasks-jira-board"]')).not.toBeNull()

    await user.click(screen.getByRole('combobox', { name: 'Add a board' }))
    await user.click(await screen.findByRole('option', { name: 'Payments' }))

    expect(updateSettings).toHaveBeenCalledWith({
      defaultJiraBoards: [{ boardId: '42', siteId: 'site-1', name: 'Payments' }],
      defaultJiraBoard: { boardId: '42', siteId: 'site-1', name: 'Payments' }
    })
  })

  it('appends without disturbing the saved order and keeps the first board as the mirror', async () => {
    const user = userEvent.setup()
    mocks.jiraListBoards.mockResolvedValue([payments, platform])
    const updateSettings = vi.fn().mockResolvedValue(undefined)
    const settings = createGlobalSettingsFixture({
      defaultJiraBoards: [
        { boardId: '42', siteId: 'site-1', name: 'Payments' },
        { boardId: '7', siteId: 'site-1', name: 'Platform' }
      ],
      defaultJiraBoard: { boardId: '42', siteId: 'site-1', name: 'Payments' }
    })

    render(<JiraBoardSettings settings={settings} updateSettingsOrThrow={updateSettings} />)

    // Why: both boards are already saved, so the picker must not offer them again.
    expect(screen.queryByRole('option', { name: 'Payments' })).toBeNull()
    await user.click(screen.getByRole('combobox', { name: 'Add a board' }))
    expect(await screen.findByText('No other boards match this search.')).not.toBeNull()
  })

  it('removes one board and keeps the rest in order', async () => {
    const user = userEvent.setup()
    mocks.jiraListBoards.mockResolvedValue([])
    const updateSettings = vi.fn().mockResolvedValue(undefined)
    const settings = createGlobalSettingsFixture({
      defaultJiraBoards: [
        { boardId: '42', siteId: 'site-1', name: 'Payments' },
        { boardId: '7', siteId: 'site-1', name: 'Platform' }
      ],
      defaultJiraBoard: { boardId: '42', siteId: 'site-1', name: 'Payments' }
    })

    render(<JiraBoardSettings settings={settings} updateSettingsOrThrow={updateSettings} />)

    await user.click(screen.getByRole('button', { name: 'Remove Payments' }))

    expect(updateSettings).toHaveBeenCalledWith({
      defaultJiraBoards: [{ boardId: '7', siteId: 'site-1', name: 'Platform' }],
      defaultJiraBoard: { boardId: '7', siteId: 'site-1', name: 'Platform' }
    })
  })

  it('returns to offering every board when the last saved one is removed', async () => {
    const user = userEvent.setup()
    mocks.jiraListBoards.mockResolvedValue([])
    const updateSettings = vi.fn().mockResolvedValue(undefined)
    const settings = createGlobalSettingsFixture({
      defaultJiraBoards: [{ boardId: '42', siteId: 'site-1', name: 'Payments' }],
      defaultJiraBoard: { boardId: '42', siteId: 'site-1', name: 'Payments' }
    })

    render(<JiraBoardSettings settings={settings} updateSettingsOrThrow={updateSettings} />)

    await user.click(screen.getByRole('button', { name: 'Remove Payments' }))

    expect(updateSettings).toHaveBeenCalledWith({
      defaultJiraBoards: null,
      defaultJiraBoard: null
    })
  })

  it('does not undo a removal when two edits land before the store echoes the first', async () => {
    const user = userEvent.setup()
    mocks.jiraListBoards.mockResolvedValue([])
    const updateSettings = vi.fn().mockResolvedValue(undefined)
    const settings = createGlobalSettingsFixture({
      defaultJiraBoards: [
        { boardId: '42', siteId: 'site-1', name: 'Payments' },
        { boardId: '7', siteId: 'site-1', name: 'Platform' }
      ],
      defaultJiraBoard: { boardId: '42', siteId: 'site-1', name: 'Payments' }
    })

    render(<JiraBoardSettings settings={settings} updateSettingsOrThrow={updateSettings} />)

    await user.click(screen.getByRole('button', { name: 'Remove Payments' }))
    await user.click(screen.getByRole('button', { name: 'Remove Platform' }))

    // Why: computed from the original prop, the second write would be [Payments] — a resurrection.
    expect(updateSettings).toHaveBeenLastCalledWith({
      defaultJiraBoards: null,
      defaultJiraBoard: null
    })
  })

  it('reorders the saved boards', async () => {
    const user = userEvent.setup()
    mocks.jiraListBoards.mockResolvedValue([])
    const updateSettings = vi.fn().mockResolvedValue(undefined)
    const settings = createGlobalSettingsFixture({
      defaultJiraBoards: [
        { boardId: '42', siteId: 'site-1', name: 'Payments' },
        { boardId: '7', siteId: 'site-1', name: 'Platform' }
      ],
      defaultJiraBoard: { boardId: '42', siteId: 'site-1', name: 'Payments' }
    })

    render(<JiraBoardSettings settings={settings} updateSettingsOrThrow={updateSettings} />)

    await user.click(screen.getByRole('button', { name: 'Move Platform up' }))

    expect(updateSettings).toHaveBeenCalledWith({
      defaultJiraBoards: [
        { boardId: '7', siteId: 'site-1', name: 'Platform' },
        { boardId: '42', siteId: 'site-1', name: 'Payments' }
      ],
      defaultJiraBoard: { boardId: '7', siteId: 'site-1', name: 'Platform' }
    })
  })

  it('shows a renamed board under its live name and stores it on the next write', async () => {
    const user = userEvent.setup()
    mocks.jiraListBoards.mockResolvedValue([payments])
    const updateSettings = vi.fn().mockResolvedValue(undefined)
    const settings = createGlobalSettingsFixture({
      defaultJiraBoards: [
        { boardId: '42', siteId: 'site-1', name: 'Old name' },
        { boardId: '7', siteId: 'site-1', name: 'Platform' }
      ],
      defaultJiraBoard: { boardId: '42', siteId: 'site-1', name: 'Old name' }
    })

    render(<JiraBoardSettings settings={settings} updateSettingsOrThrow={updateSettings} />)

    // Why: a rename resolves by id, so it must not read as a board that vanished.
    expect(await screen.findByText('Payments')).not.toBeNull()
    await user.click(screen.getByRole('button', { name: 'Move Platform up' }))

    expect(updateSettings).toHaveBeenCalledWith({
      defaultJiraBoards: [
        { boardId: '7', siteId: 'site-1', name: 'Platform' },
        { boardId: '42', siteId: 'site-1', name: 'Payments' }
      ],
      defaultJiraBoard: { boardId: '7', siteId: 'site-1', name: 'Platform' }
    })
  })

  it('shows a legacy single board as a saved board', async () => {
    mocks.jiraListBoards.mockResolvedValue([])
    const settings = createGlobalSettingsFixture({
      defaultJiraBoard: { boardId: '37169', siteId: 'site-1', name: 'Ps Nebulite Scrum Board' }
    })

    render(<JiraBoardSettings settings={settings} updateSettingsOrThrow={vi.fn()} />)

    expect(await screen.findByText('Ps Nebulite Scrum Board')).not.toBeNull()
    expect(screen.getByRole('button', { name: 'Remove Ps Nebulite Scrum Board' })).not.toBeNull()
  })

  it('offers retry when the board list read fails', async () => {
    mocks.jiraListBoards.mockRejectedValue(new Error('Jira board list request timed out.'))
    const settings = createGlobalSettingsFixture({ defaultJiraBoard: null })

    render(<JiraBoardSettings settings={settings} updateSettingsOrThrow={vi.fn()} />)

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('Jira board list request timed out.')
    expect(screen.getByRole('button', { name: 'Retry' })).not.toBeNull()
  })

  it('reports a board write that did not persist', async () => {
    const user = userEvent.setup()
    mocks.jiraListBoards.mockResolvedValue([payments])
    const updateSettings = vi.fn().mockRejectedValue(new Error('settings write failed'))
    const settings = createGlobalSettingsFixture({ defaultJiraBoard: null })

    render(<JiraBoardSettings settings={settings} updateSettingsOrThrow={updateSettings} />)

    await user.click(screen.getByRole('combobox', { name: 'Add a board' }))
    await user.click(await screen.findByRole('option', { name: 'Payments' }))

    await waitFor(() => expect(mocks.saveError).toHaveBeenCalledWith('Could not save. Try again.'))
  })
})
