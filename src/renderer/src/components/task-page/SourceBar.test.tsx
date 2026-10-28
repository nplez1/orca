// @vitest-environment happy-dom

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { JiraSite } from '../../../../shared/jira/jira-types'
import type { SourceOption } from './task-page-localized-options'
import type { TaskPageComposerActionsModel } from './use-task-page-composer-actions'
import { TaskPageSourceBar } from './SourceBar'

const openSettingsPage = vi.fn()
const openSettingsTarget = vi.fn()

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: unknown) => unknown) =>
    selector({ openSettingsPage, openSettingsTarget })
}))

function SourceIcon(): React.JSX.Element {
  return <svg aria-hidden />
}

const sourceOptions: SourceOption[] = [
  { id: 'github', label: 'GitHub', Icon: SourceIcon },
  { id: 'jira', label: 'Jira', Icon: SourceIcon },
  { id: 'linear', label: 'Linear', Icon: SourceIcon }
]

function jiraSite(id: string): JiraSite {
  return {
    id,
    siteUrl: `https://${id}.atlassian.net`,
    email: 'tasks@example.com',
    displayName: `Site ${id}`,
    accountId: `account-${id}`
  }
}

function model(overrides: Partial<TaskPageComposerActionsModel>): TaskPageComposerActionsModel {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: This fixture supplies every field read by the source bar.
  return {
    settings: { defaultJiraBoard: null },
    jiraBoardViewMode: 'board',
    openTaskPage: vi.fn(),
    closeTaskPage: vi.fn(),
    updateSettings: vi.fn().mockResolvedValue(undefined),
    selectJiraSite: vi.fn().mockResolvedValue(undefined),
    linearConnected: false,
    jiraConnected: true,
    linearWorkspaces: [],
    selectedLinearWorkspaceId: null,
    jiraSites: [],
    selectedJiraSiteId: null,
    visibleSourceOptions: sourceOptions,
    taskSource: 'github',
    taskSourceAvailabilityNoticeByProvider: {},
    taskSourceContextSummary: { title: '', label: '' },
    githubMode: 'issues',
    accountBackedTaskSourceHostId: 'local',
    hostRegistryById: new Map(),
    hostLabelById: new Map(),
    taskSourceManuallyChangedRef: { current: false },
    setSelectedJiraIssueKey: vi.fn(),
    setSelectedJiraIssueFallback: vi.fn(),
    setJiraIssues: vi.fn(),
    setJiraLoading: vi.fn(),
    setJiraError: vi.fn(),
    defaultLinearTeamSelection: null,
    linearTeamSelection: [],
    linearTeamOptions: [],
    selectedLinearTeamForExternalLink: null,
    setLinearConnectOpen: vi.fn(),
    handleLinearWorkspaceChange: vi.fn(),
    handleLinearTeamSelectionChange: vi.fn(),
    handleLinearScopeOpen: vi.fn(),
    ...overrides
  } as unknown as TaskPageComposerActionsModel
}

function renderSourceBar(state: TaskPageComposerActionsModel): void {
  render(
    <TooltipProvider>
      <TaskPageSourceBar model={state} />
    </TooltipProvider>
  )
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('TaskPageSourceBar Jira settings', () => {
  it('keeps the Jira board settings reachable from a non-Jira source', () => {
    renderSourceBar(model({ taskSource: 'github' }))
    expect(screen.getByRole('button', { name: 'Jira task settings' })).toBeDefined()
  })

  it('keeps the Jira board settings reachable from the Jira source', () => {
    renderSourceBar(model({ taskSource: 'jira' }))
    expect(screen.getByRole('button', { name: 'Jira task settings' })).toBeDefined()
  })

  it('keeps the Jira board settings on the Jira source while the connection is down', () => {
    renderSourceBar(model({ taskSource: 'jira', jiraConnected: false }))
    expect(screen.getByRole('button', { name: 'Jira task settings' })).toBeDefined()
  })

  it('drops the settings entry from other sources while Jira is not connected', () => {
    renderSourceBar(model({ taskSource: 'github', jiraConnected: false }))
    expect(screen.queryByRole('button', { name: 'Jira task settings' })).toBeNull()
  })

  it('keeps the Linear scope controls alongside the Jira settings entry', () => {
    renderSourceBar(model({ taskSource: 'linear', linearConnected: true }))
    expect(screen.getByRole('combobox')).toBeDefined()
    expect(screen.getByRole('button', { name: 'Jira task settings' })).toBeDefined()
  })

  it('drops the settings entry when Jira is not one of the visible sources', () => {
    renderSourceBar(
      model({
        taskSource: 'github',
        visibleSourceOptions: sourceOptions.filter((source) => source.id !== 'jira')
      })
    )
    expect(screen.queryByRole('button', { name: 'Jira task settings' })).toBeNull()
  })

  it('shows the Jira site selector only while the Jira source is selected', () => {
    const withSites = { jiraSites: [jiraSite('a'), jiraSite('b')] }
    renderSourceBar(model({ taskSource: 'github', ...withSites }))
    expect(screen.queryByRole('combobox')).toBeNull()
    cleanup()
    renderSourceBar(model({ taskSource: 'jira', ...withSites }))
    expect(screen.getByRole('combobox')).toBeDefined()
  })
})
