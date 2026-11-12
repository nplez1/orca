// @vitest-environment happy-dom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { JiraProject } from '../../../../shared/jira/jira-types'
import type { TaskPageResumeRestorationModel } from './use-task-page-resume-restoration'
import { toRuntimeExecutionHostId } from '../../../../shared/execution-host'
import { useTaskPageProviderMetadata } from './use-task-page-provider-metadata'

const transport = vi.hoisted(() => ({ jiraListProjects: vi.fn() }))
const linear = vi.hoisted(() => ({ cached: vi.fn(), list: vi.fn() }))
vi.mock('@/runtime/jira/runtime-jira-client', () => ({
  jiraListProjects: transport.jiraListProjects
}))

const PROJECT: JiraProject = { id: '1', key: 'APP', name: 'App', siteId: 'site-1' }
const OTHER_PROJECT: JiraProject = { id: '2', key: 'OPS', name: 'Ops', siteId: 'site-1' }
const SETTINGS = {}
const jiraContext = {
  kind: 'task-source',
  provider: 'jira',
  projectId: 'project',
  hostId: toRuntimeExecutionHostId('account-owner')
} as const

// Why: the effect deps must keep their identity across renders, or the hook re-reads forever.
function fixture(overrides: Record<string, unknown> = {}): TaskPageResumeRestorationModel {
  const model = {
    settings: SETTINGS,
    getCachedLinearTeams: linear.cached,
    listLinearTeams: linear.list,
    linearConnected: true,
    jiraConnected: true,
    selectedLinearWorkspaceId: 'workspace-1',
    selectedJiraSiteId: 'site-1',
    taskSource: 'jira',
    linearTaskSourceContext: null,
    jiraTaskSourceContext: jiraContext,
    jiraTaskSourceScopeKey: 'jira-scope',
    taskResumeApplied: true,
    ...overrides
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: This isolated hook reads only the listed pipeline fields.
  return model as unknown as TaskPageResumeRestorationModel
}

beforeEach(() => {
  transport.jiraListProjects.mockReset()
  linear.cached.mockReset().mockReturnValue(null)
  linear.list.mockReset().mockResolvedValue([])
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => {
  vi.restoreAllMocks()
  cleanup()
})

describe('TaskPage provider metadata', () => {
  it('reports a failed Jira project read and clears it on retry', async () => {
    transport.jiraListProjects.mockRejectedValueOnce(new Error('offline'))
    const { result } = renderHook(() => useTaskPageProviderMetadata(fixture()))
    await waitFor(() => expect(result.current.jiraProjectsError).toBe(true))
    expect(result.current.availableJiraProjects).toEqual([])

    transport.jiraListProjects.mockResolvedValueOnce([PROJECT])
    await act(async () => result.current.retryJiraProjects())

    await waitFor(() => expect(result.current.jiraProjectsError).toBe(false))
    expect(result.current.availableJiraProjects).toEqual([PROJECT])
  })

  it('keeps the last Jira project list while a retry is in flight', async () => {
    transport.jiraListProjects.mockResolvedValueOnce([PROJECT])
    const { result } = renderHook(() => useTaskPageProviderMetadata(fixture()))
    await waitFor(() => expect(result.current.availableJiraProjects).toEqual([PROJECT]))

    let resolveRetry: (projects: JiraProject[]) => void = () => {}
    transport.jiraListProjects.mockImplementationOnce(
      () =>
        new Promise<JiraProject[]>((resolve) => {
          resolveRetry = resolve
        })
    )
    await act(async () => result.current.retryJiraProjects())

    expect(result.current.availableJiraProjects).toEqual([PROJECT])
    expect(result.current.jiraProjectsLoading).toBe(false)

    await act(async () => resolveRetry([PROJECT, OTHER_PROJECT]))
    expect(result.current.availableJiraProjects).toEqual([PROJECT, OTHER_PROJECT])
  })

  it('drops a failed Jira project read when the site changes', async () => {
    transport.jiraListProjects.mockRejectedValueOnce(new Error('offline'))
    const { result, rerender } = renderHook(
      ({ siteId }: { siteId: string }) =>
        useTaskPageProviderMetadata(fixture({ selectedJiraSiteId: siteId })),
      { initialProps: { siteId: 'site-1' } }
    )
    await waitFor(() => expect(result.current.jiraProjectsError).toBe(true))

    transport.jiraListProjects.mockResolvedValueOnce([OTHER_PROJECT])
    rerender({ siteId: 'site-2' })

    await waitFor(() => expect(result.current.jiraProjectsError).toBe(false))
    expect(result.current.availableJiraProjects).toEqual([OTHER_PROJECT])
  })

  it('reports a failed Linear team read instead of an empty team list', async () => {
    linear.list.mockRejectedValue(new Error('offline'))
    const { result } = renderHook(() =>
      useTaskPageProviderMetadata(fixture({ taskSource: 'linear' }))
    )

    await waitFor(() => expect(result.current.linearTeamsError).toBe(true))
    expect(linear.list).toHaveBeenCalledWith(
      'workspace-1',
      expect.objectContaining({ rejectReadError: true })
    )
  })
})
