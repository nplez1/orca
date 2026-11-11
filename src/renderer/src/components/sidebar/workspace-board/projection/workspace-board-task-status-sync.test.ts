import { describe, expect, it, vi } from 'vitest'
import type { LinearIssue } from '../../../../../../shared/linear/issue-types'
import type { LinearWorkflowState } from '../../../../../../shared/linear/workspace-types'
import type { WorkspaceStatusDefinition, Worktree } from '../../../../../../shared/worktree/types'
import type { LinearMutationResult } from '@/runtime/linear/runtime-linear-client'
import type { JiraIssue, JiraTransition } from '../../../../../../shared/jira/jira-types'
import type { TaskSourceContext } from '../../../../../../shared/work-items/task-source-context'
import { makeWorktree } from '@/store/slices/worktrees/worktree.test-fixture'
import { syncWorkspaceBoardTaskStatuses } from './workspace-board-task-status-sync'

function issue(overrides: Partial<LinearIssue> = {}): LinearIssue {
  return {
    id: 'issue-1',
    identifier: 'ORC-1',
    title: 'Sync the board',
    description: '',
    url: 'https://linear.app/orca/issue/ORC-1/sync-the-board',
    state: { name: 'Todo', type: 'unstarted', color: '#999' },
    team: { id: 'team-1', name: 'Orca', key: 'ORC' },
    labels: [],
    labelIds: [],
    priority: 0,
    updatedAt: '2026-06-15T00:00:00.000Z',
    ...overrides
  }
}

function state(overrides: Partial<LinearWorkflowState> = {}): LinearWorkflowState {
  return {
    id: 'state-review',
    name: 'In review',
    type: 'started',
    color: '#111',
    position: 1,
    ...overrides
  }
}

function worktree(overrides: Partial<Worktree> = {}): Worktree {
  return {
    id: 'repo::/worktree',
    linkedLinearIssue: 'ORC-1',
    linkedLinearIssueWorkspaceId: 'workspace-1',
    ...overrides
  } as Worktree
}

function targetStatus(
  overrides: Partial<WorkspaceStatusDefinition> = {}
): WorkspaceStatusDefinition {
  return { id: 'in-review', label: 'In review', ...overrides }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve
    reject = promiseReject
  })
  return { promise, resolve, reject }
}

async function flushMicrotasks(count = 5): Promise<void> {
  for (let i = 0; i < count; i += 1) {
    await Promise.resolve()
  }
}

function setup(overrides: Partial<Worktree> = {}) {
  const target = targetStatus()
  const item = worktree(overrides)
  const getIssue = vi.fn().mockResolvedValue(issue())
  const teamStates = vi.fn().mockResolvedValue([state()])
  const updateIssue = vi.fn<() => Promise<LinearMutationResult>>().mockResolvedValue({ ok: true })

  return {
    item,
    target,
    getIssue,
    teamStates,
    updateIssue,
    run: () =>
      syncWorkspaceBoardTaskStatuses({
        worktreeKeys: [item.id],
        targetStatus: target,
        worktreesByKey: new Map([[item.id, item]]),
        settings: { kind: 'environment', environmentId: 'runtime-1' },
        getLatestWorkspaceStatus: () => target.id,
        deps: { getIssue, teamStates, updateIssue }
      })
  }
}

describe('syncWorkspaceBoardTaskStatuses', () => {
  it('skips missing or ambiguous workflow state matches', async () => {
    const missing = setup()
    missing.teamStates.mockResolvedValueOnce([state({ name: 'Done' })])

    await expect(missing.run()).resolves.toMatchObject({
      updated: 0,
      skipped: 1,
      failed: 0,
      messages: [{ kind: 'missing-workflow-state', statusLabel: 'In review' }]
    })
    expect(missing.updateIssue).not.toHaveBeenCalled()

    const ambiguous = setup()
    ambiguous.teamStates.mockResolvedValueOnce([
      state({ id: 'state-1', name: 'In review' }),
      state({ id: 'state-2', name: ' in REVIEW ' })
    ])

    await expect(ambiguous.run()).resolves.toMatchObject({
      updated: 0,
      skipped: 1,
      failed: 0,
      messages: [{ kind: 'ambiguous-workflow-state', statusLabel: 'In review' }]
    })
    expect(ambiguous.updateIssue).not.toHaveBeenCalled()
  })

  it('serializes repeated moves for the same worktree so the latest status wins', async () => {
    const item = worktree()
    const firstUpdate = deferred<LinearMutationResult>()
    const getIssue = vi.fn().mockResolvedValue(issue())
    const teamStates = vi
      .fn()
      .mockResolvedValueOnce([state()])
      .mockResolvedValueOnce([state({ id: 'state-done', name: 'Done', type: 'completed' })])
    const updateIssue = vi
      .fn<() => Promise<LinearMutationResult>>()
      .mockReturnValueOnce(firstUpdate.promise)
      .mockResolvedValueOnce({ ok: true })

    const firstSync = syncWorkspaceBoardTaskStatuses({
      worktreeKeys: [item.id],
      targetStatus: targetStatus(),
      worktreesByKey: new Map([[item.id, item]]),
      settings: { kind: 'local' },
      getLatestWorkspaceStatus: () => 'in-review',
      deps: { getIssue, teamStates, updateIssue }
    })
    await flushMicrotasks()
    expect(updateIssue).toHaveBeenCalledTimes(1)

    const secondSync = syncWorkspaceBoardTaskStatuses({
      worktreeKeys: [item.id],
      targetStatus: targetStatus({ id: 'done', label: 'Done' }),
      worktreesByKey: new Map([[item.id, item]]),
      settings: { kind: 'local' },
      getLatestWorkspaceStatus: () => 'done',
      deps: { getIssue, teamStates, updateIssue }
    })
    await flushMicrotasks()
    expect(updateIssue).toHaveBeenCalledTimes(1)

    firstUpdate.resolve({ ok: true })
    await firstSync
    await secondSync

    expect(updateIssue).toHaveBeenNthCalledWith(
      1,
      { kind: 'local' },
      'issue-1',
      { stateId: 'state-review' },
      'workspace-1'
    )
    expect(updateIssue).toHaveBeenNthCalledWith(
      2,
      { kind: 'local' },
      'issue-1',
      { stateId: 'state-done' },
      'workspace-1'
    )
  })
})

const JIRA_SOURCE: TaskSourceContext = {
  kind: 'task-source',
  provider: 'jira',
  projectId: 'ABC',
  hostId: 'local',
  providerIdentity: {
    provider: 'jira',
    siteId: 'site-b',
    siteUrl: 'https://acme.atlassian.net',
    projectKey: 'ABC'
  }
}

/** A workspace created from a Jira task: the link carries the site it was attached from. */
function jiraWorktree(overrides: Partial<Worktree> = {}): Worktree {
  return makeWorktree({
    id: 'repo::/jira',
    repoId: 'repo',
    linkedWorkItem: {
      provider: 'jira',
      type: 'issue',
      number: 0,
      title: 'Sync the board',
      url: 'https://acme.atlassian.net/browse/ABC-1',
      jiraIdentifier: 'ABC-1'
    },
    linkedTaskSourceContext: JIRA_SOURCE,
    ...overrides
  })
}

function jiraIssue(overrides: Partial<JiraIssue> = {}): JiraIssue {
  return {
    id: '10001',
    key: 'ABC-1',
    siteId: 'site-b',
    title: 'Sync the board',
    url: 'https://acme.atlassian.net/browse/ABC-1',
    project: { id: '10', key: 'ABC', name: 'ABC' },
    issueType: { id: '1', name: 'Task' },
    status: { id: '1', name: 'To Do', categoryKey: 'new', categoryName: 'To Do' },
    labels: [],
    updatedAt: '2026-06-15T00:00:00.000Z',
    createdAt: '2026-06-15T00:00:00.000Z',
    ...overrides
  }
}

function jiraTransition(
  id: string,
  toId: string,
  toName: string,
  overrides: Partial<JiraTransition> = {}
): JiraTransition {
  return {
    id,
    name: `Move to ${toName}`,
    to: { id: toId, name: toName, categoryKey: 'indeterminate', categoryName: 'In progress' },
    ...overrides
  }
}

function setupJira(item: Worktree, targetLabel = 'In review') {
  const target = targetStatus({ id: 'in-review', label: targetLabel })
  const getIssue = vi.fn().mockResolvedValue(jiraIssue())
  const listTransitions = vi.fn().mockResolvedValue([jiraTransition('t-2', '3', 'In review')])
  const updateIssue = vi.fn().mockResolvedValue({ ok: true })
  const loadStatusOrder = vi.fn().mockResolvedValue({ statusIdsByColumn: [] })
  return {
    target,
    getIssue,
    listTransitions,
    updateIssue,
    loadStatusOrder,
    run: () =>
      syncWorkspaceBoardTaskStatuses({
        worktreeKeys: [item.id],
        targetStatus: target,
        worktreesByKey: new Map([[item.id, item]]),
        settings: { kind: 'local' },
        getLatestWorkspaceStatus: () => target.id,
        jiraDeps: { getIssue, listTransitions, updateIssue, loadStatusOrder }
      })
  }
}

describe('syncWorkspaceBoardTaskStatuses with a Jira link', () => {
  it('transitions by status name on the site the link was attached from', async () => {
    const setup = setupJira(jiraWorktree())

    await expect(setup.run()).resolves.toMatchObject({ updated: 1, skipped: 0, failed: 0 })
    // Why the site is asserted on the reads too: it has to come from the link, not the selected site.
    expect(setup.getIssue).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'jira',
        providerIdentity: expect.objectContaining({ siteId: 'site-b' })
      }),
      'ABC-1',
      'site-b'
    )
    expect(setup.listTransitions).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'jira' }),
      'ABC-1',
      'site-b'
    )
    expect(setup.updateIssue).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'jira',
        providerIdentity: expect.objectContaining({ siteId: 'site-b' })
      }),
      'ABC-1',
      { transitionId: 't-2' },
      'site-b'
    )
    expect(setup.loadStatusOrder).not.toHaveBeenCalled()
  })

  it('falls back to the board column of the same name', async () => {
    const setup = setupJira(jiraWorktree())
    setup.listTransitions.mockResolvedValue([
      jiraTransition('t-5', '3', 'Review needed'),
      jiraTransition('t-6', '9', 'Wont do')
    ])
    setup.loadStatusOrder.mockResolvedValue({
      statusIdsByColumn: [['1'], ['3']],
      columns: [
        { name: 'To Do', statusIds: ['1'] },
        { name: 'In review', statusIds: ['3'] }
      ]
    })

    await expect(setup.run()).resolves.toMatchObject({ updated: 1, skipped: 0, failed: 0 })
    expect(setup.updateIssue).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'jira' }),
      'ABC-1',
      { transitionId: 't-5' },
      'site-b'
    )
  })

  it('reports a transition that needs screen fields instead of submitting it', async () => {
    const setup = setupJira(jiraWorktree())
    setup.listTransitions.mockResolvedValue([
      jiraTransition('t-2', '3', 'In review', {
        fields: [{ key: 'customfield_1', name: 'Team', required: true }]
      })
    ])

    await expect(setup.run()).resolves.toMatchObject({
      updated: 0,
      skipped: 1,
      failed: 0,
      messages: [
        { kind: 'jira-transition-needs-fields', issueKey: 'ABC-1', statusLabel: 'In review' }
      ]
    })
    expect(setup.updateIssue).not.toHaveBeenCalled()
  })

  it('leaves Jira alone when the workspace also has a Linear slot', async () => {
    const item = jiraWorktree({ linkedLinearIssue: 'ORC-1' })
    const setup = setupJira(item)
    const linear = {
      getIssue: vi.fn().mockResolvedValue(issue()),
      teamStates: vi.fn().mockResolvedValue([state()]),
      updateIssue: vi.fn().mockResolvedValue({ ok: true })
    }

    await expect(
      syncWorkspaceBoardTaskStatuses({
        worktreeKeys: [item.id],
        targetStatus: setup.target,
        worktreesByKey: new Map([[item.id, item]]),
        settings: { kind: 'local' },
        getLatestWorkspaceStatus: () => setup.target.id,
        deps: linear,
        jiraDeps: {
          getIssue: setup.getIssue,
          listTransitions: setup.listTransitions,
          updateIssue: setup.updateIssue,
          loadStatusOrder: setup.loadStatusOrder
        }
      })
    ).resolves.toMatchObject({ updated: 1 })
    expect(linear.updateIssue).toHaveBeenCalledTimes(1)
    expect(setup.getIssue).not.toHaveBeenCalled()
    expect(setup.updateIssue).not.toHaveBeenCalled()
  })
})
