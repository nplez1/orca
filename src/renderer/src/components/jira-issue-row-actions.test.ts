// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'
import { ArrowRight, ExternalLink, FolderOpen } from 'lucide-react'
import type { JiraIssue } from '../../../shared/jira/jira-types'
import {
  buildJiraIssueRowWorkspaceAction,
  getJiraIssueRowActions,
  type JiraIssueRowWorkspaceAction
} from './jira-issue-row-actions'
import { getJiraIssueWorkspaceActions } from './jira-issue-workspace-actions'

vi.mock('@/lib/jira-issue-key-casing', () => ({
  getJiraIssueKeyCasingSeedOptions: () => ({})
}))

const issue: JiraIssue = {
  id: '1',
  key: 'APP-1',
  title: 'Fix login',
  url: 'https://acme.atlassian.net/browse/APP-1',
  project: { id: '1', key: 'APP', name: 'App' },
  issueType: { id: '1', name: 'Bug' },
  status: { id: '1', name: 'Open', categoryKey: 'new', categoryName: 'Open' },
  labels: [],
  createdAt: '2026-10-01',
  updatedAt: '2026-10-01'
}

const workspace: JiraIssueRowWorkspaceAction = {
  label: 'Start workspace',
  icon: ArrowRight,
  onSelect: () => undefined
}

describe('getJiraIssueRowActions', () => {
  it('renders the detail sheet list unchanged, under the row action', () => {
    const actions = getJiraIssueRowActions(issue, workspace)
    const shared = getJiraIssueWorkspaceActions(issue)
    expect(actions.map((action) => action.key)).toEqual([
      'workspace',
      ...shared.map((action) => action.key)
    ])
    expect(actions.slice(1).map((action) => action.label)).toEqual(
      shared.map((action) => action.label)
    )
    expect(actions.find((action) => action.key === 'open-in-jira')?.icon).toBe(ExternalLink)
  })

  it('separates the row action from the shared list exactly once', () => {
    expect(
      getJiraIssueRowActions(issue, workspace).filter((action) => action.separatorBefore)
    ).toHaveLength(1)
    expect(
      getJiraIssueRowActions(issue, workspace).find((action) => action.separatorBefore)?.key
    ).toBe('open-in-jira')
    expect(getJiraIssueRowActions(issue, null).some((action) => action.separatorBefore)).toBe(false)
  })
})

describe('buildJiraIssueRowWorkspaceAction', () => {
  const onOpenOrStartWorkspace = vi.fn()
  const onStartWorkspace = vi.fn()

  it('shows the attached workspace when a handler can open one', () => {
    const action = buildJiraIssueRowWorkspaceAction({
      issue,
      linked: true,
      onOpenOrStartWorkspace,
      onStartWorkspace
    })
    expect(action).toMatchObject({ label: 'Show workspace', icon: FolderOpen })
    action?.onSelect()
    expect(onOpenOrStartWorkspace).toHaveBeenCalledWith(issue)
  })

  it('starts a new workspace when the issue is linked but only the start handler is wired', () => {
    const action = buildJiraIssueRowWorkspaceAction({
      issue,
      linked: true,
      onStartWorkspace
    })
    expect(action).toMatchObject({ label: 'Start workspace', icon: ArrowRight })
    action?.onSelect()
    expect(onStartWorkspace).toHaveBeenCalledWith(issue)
  })

  it('offers no workspace item when the surface has no handler', () => {
    expect(buildJiraIssueRowWorkspaceAction({ issue, linked: true })).toBeNull()
  })
})
