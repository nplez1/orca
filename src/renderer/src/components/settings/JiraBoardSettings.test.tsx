// @vitest-environment happy-dom

import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createGlobalSettingsFixture } from '../../../../shared/global-settings-test-fixture'
import type { JiraBoard, JiraField } from '../../../../shared/jira-types'
import { JiraBoardSettings } from './JiraBoardSettings'

const mocks = vi.hoisted(() => ({
  checkJiraConnection: vi.fn().mockResolvedValue(undefined),
  jiraListBoards: vi.fn(),
  jiraListCustomFields: vi.fn()
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
  jiraListBoards: (...args: unknown[]) => mocks.jiraListBoards(...args),
  jiraListCustomFields: (...args: unknown[]) => mocks.jiraListCustomFields(...args)
}))

const boards: JiraBoard[] = [
  { id: '42', name: 'Payments', type: 'scrum', siteId: 'site-1', siteName: 'Example Jira' }
]
const fields: JiraField[] = [
  {
    id: 'customfield_10000',
    name: 'Jira Team',
    schemaType: 'team',
    siteId: 'site-1',
    siteName: 'Example Jira'
  },
  {
    id: 'customfield_10001',
    name: 'Delivery Team',
    schemaType: 'option',
    siteId: 'site-1',
    siteName: 'Example Jira'
  },
  {
    id: 'customfield_10002',
    name: 'Team notes',
    schemaType: 'array',
    siteId: 'site-1',
    siteName: 'Example Jira'
  }
]

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('JiraBoardSettings', () => {
  it('loads the configured site boards, then loads custom fields for the selected board', async () => {
    const user = userEvent.setup()
    const updateSettings = vi.fn()
    mocks.jiraListBoards.mockResolvedValue(boards)
    mocks.jiraListCustomFields.mockResolvedValue(fields)
    const settings = createGlobalSettingsFixture({
      defaultJiraBoard: null,
      jiraTeamFieldId: '',
      jiraTeamValue: ''
    })

    const { rerender, container } = render(
      <JiraBoardSettings settings={settings} updateSettings={updateSettings} />
    )
    await waitFor(() =>
      expect(mocks.jiraListBoards).toHaveBeenCalledWith(
        { activeRuntimeEnvironmentId: settings.activeRuntimeEnvironmentId },
        'site-1'
      )
    )
    expect(container.querySelector('[data-settings-section="tasks-jira-board"]')).not.toBeNull()

    await user.click(screen.getByRole('combobox', { name: 'Default board' }))
    await user.click(await screen.findByRole('option', { name: 'Payments' }))
    expect(updateSettings).toHaveBeenCalledWith({
      defaultJiraBoard: { boardId: '42', siteId: 'site-1' },
      jiraTeamFieldId: '',
      jiraTeamValue: ''
    })

    const selectedSettings = createGlobalSettingsFixture({
      defaultJiraBoard: { boardId: '42', siteId: 'site-1' },
      jiraTeamFieldId: '',
      jiraTeamValue: ''
    })
    rerender(<JiraBoardSettings settings={selectedSettings} updateSettings={updateSettings} />)
    await waitFor(() =>
      expect(mocks.jiraListCustomFields).toHaveBeenCalledWith(
        { activeRuntimeEnvironmentId: selectedSettings.activeRuntimeEnvironmentId },
        'site-1'
      )
    )
    await user.click(screen.getByRole('combobox', { name: 'Team field' }))
    await user.click(
      await screen.findByRole('option', { name: 'Delivery Team (customfield_10001)' })
    )
    expect(updateSettings).toHaveBeenLastCalledWith({
      jiraTeamFieldId: 'customfield_10001',
      jiraTeamValue: ''
    })
  })

  it('saves an exact team field value without persisting whitespace', async () => {
    const user = userEvent.setup()
    const updateSettings = vi.fn()
    mocks.jiraListBoards.mockResolvedValue(boards)
    mocks.jiraListCustomFields.mockResolvedValue(fields)
    const settings = createGlobalSettingsFixture({
      defaultJiraBoard: { boardId: '42', siteId: 'site-1' },
      jiraTeamFieldId: 'customfield_10001',
      jiraTeamValue: ''
    })
    render(<JiraBoardSettings settings={settings} updateSettings={updateSettings} />)

    const teamValue = await screen.findByRole('textbox', { name: 'Team value' })
    await user.type(teamValue, ' Payments ')
    await user.keyboard('{Enter}')

    expect(updateSettings).toHaveBeenCalledWith({ jiraTeamValue: 'Payments' })
  })

  it('does not expose array custom fields as a Team filter field', async () => {
    const user = userEvent.setup()
    mocks.jiraListBoards.mockResolvedValue(boards)
    mocks.jiraListCustomFields.mockResolvedValue(fields)
    const settings = createGlobalSettingsFixture({
      defaultJiraBoard: { boardId: '42', siteId: 'site-1' },
      jiraTeamFieldId: '',
      jiraTeamValue: ''
    })
    render(<JiraBoardSettings settings={settings} updateSettings={vi.fn()} />)

    await user.click(await screen.findByRole('combobox', { name: 'Team field' }))

    expect(screen.queryByRole('option', { name: 'Team notes (customfield_10002)' })).toBeNull()
    expect(screen.getByRole('option', { name: 'Delivery Team (customfield_10001)' })).not.toBeNull()
    expect(screen.getByRole('option', { name: 'Jira Team (customfield_10000)' })).not.toBeNull()
  })
})
