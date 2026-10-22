// @vitest-environment happy-dom
import type { ComponentProps, ReactNode } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { JiraConnectionStatus, JiraIssue, JiraTransition } from '../../../shared/jira-types'
import { taskSourceRuntimeTarget } from '@/lib/task-source-runtime-target'
import { getJiraRuntimeTarget, type RuntimeJiraSettings } from '@/runtime/runtime-jira-target'
import type { AppState } from '@/store/types'
import type { TaskSourceContext } from '../../../shared/task-source-context'
import type { JiraIssueMetadataBar } from './jira-issue-workspace-chrome'
import JiraIssueWorkspace from './JiraIssueWorkspace'

const mocks = vi.hoisted(() => ({
  update: vi.fn(),
  transitions: vi.fn(),
  readJiraStatus: vi.fn(async (): Promise<JiraConnectionStatus> => ({
    connected: false,
    viewer: null
  })),
  settings: { activeRuntimeEnvironmentId: 'environment-a' }
}))
type TransitionStoreBoundary = Pick<
  AppState,
  | 'jiraStatus'
  | 'jiraStatusContextKey'
  | 'jiraConnectionRevisions'
  | 'readJiraStatus'
  | 'patchJiraIssue'
> & { settings: { activeRuntimeEnvironmentId: string } }
vi.mock('@/store', () => ({
  useAppStore: (selector: (state: TransitionStoreBoundary) => unknown) =>
    selector({
      settings: mocks.settings,
      jiraStatus: { connected: false, viewer: null },
      jiraStatusContextKey: null,
      jiraConnectionRevisions: {},
      readJiraStatus: mocks.readJiraStatus,
      patchJiraIssue: () => {}
    })
}))
vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string, values?: Record<string, string>) =>
    fallback.replace(/{{(\w+)}}/g, (_match, key) => values?.[key] ?? '')
}))
vi.mock('@/runtime/runtime-jira-client', () => ({
  jiraGetIssueForTarget: async () => null,
  jiraGetIssue: async () => null,
  jiraIssueCommentsForTarget: async () => [],
  jiraIssueComments: async () => [],
  jiraListTransitionsForTarget: mocks.transitions,
  jiraListTransitions: (settings: RuntimeJiraSettings, key: string, siteId?: string | null) =>
    mocks.transitions(getJiraRuntimeTarget(settings), key, siteId),
  jiraListPrioritiesForTarget: async () => [],
  jiraListPriorities: async () => [],
  jiraListAssignableUsersForTarget: async () => [],
  jiraListAssignableUsers: async () => [],
  jiraListEditFields: async () => [],
  jiraUpdateIssueForTarget: mocks.update,
  jiraUpdateIssue: (
    settings: RuntimeJiraSettings,
    key: string,
    updates: unknown,
    siteId?: string | null
  ) => mocks.update(getJiraRuntimeTarget(settings), key, updates, siteId),
  jiraAddIssueCommentForTarget: async () => ({ ok: true }),
  jiraAddIssueComment: async () => ({ ok: true })
}))
vi.mock('@/components/ui/sheet', () => {
  const Content = ({ children }: { children: ReactNode }) => <div>{children}</div>
  return { Sheet: Content, SheetContent: Content, SheetTitle: Content, SheetDescription: Content }
})
vi.mock('./jira-issue-workspace-chrome', async (importOriginal) => {
  const actual = await importOriginal<{ JiraIssueMetadataBar: typeof JiraIssueMetadataBar }>()
  return {
    JiraIssueWorkspaceHeader: () => null,
    JiraIssueMetadataBar: (props: ComponentProps<typeof JiraIssueMetadataBar>) => (
      <actual.JiraIssueMetadataBar {...props} />
    )
  }
})
vi.mock('./jira-issue-workspace-content', () => ({
  JiraIssueWorkspaceContent: () => null,
  JiraIssueCommentComposer: () => null
}))
const source: TaskSourceContext = {
  kind: 'task-source',
  provider: 'jira',
  projectId: 'project-a',
  hostId: 'runtime:environment-a',
  accountLabel: 'Account A',
  providerIdentity: { provider: 'jira', siteId: 'site-a', projectKey: 'APP' }
}
const issue: JiraIssue = {
  id: '1',
  key: 'APP-1',
  siteId: 'site-a',
  title: 'Fix login',
  url: 'https://example.atlassian.net/browse/APP-1',
  project: { id: '1', key: 'APP', name: 'App' },
  issueType: { id: '1', name: 'Bug' },
  status: { id: 'open', name: 'Open', categoryKey: 'new', categoryName: 'To Do' },
  labels: [],
  createdAt: '',
  updatedAt: ''
}
function transition(id: string): JiraTransition {
  return {
    id,
    name: 'Close',
    to: { ...issue.status, id: 'done', name: 'Done' },
    fields: [{ key: 'comment', name: 'Comment', required: true }]
  }
}
async function waitForTransitions(): Promise<void> {
  await waitFor(() =>
    expect(
      screen
        .getByRole('button', { name: 'Change status: Open' })
        .querySelector('.lucide-chevron-down')
    ).not.toBeNull()
  )
}
async function openForm(): Promise<void> {
  await waitForTransitions()
  fireEvent.click(screen.getByRole('button', { name: 'Change status: Open' }))
  fireEvent.click(await screen.findByRole('button', { name: 'Close' }))
  await screen.findByLabelText('Comment')
}
function workspace(context: TaskSourceContext) {
  return (
    <JiraIssueWorkspace issue={issue} sourceContext={context} onUse={() => {}} onClose={() => {}} />
  )
}
afterEach(cleanup)
beforeEach(() => {
  vi.clearAllMocks()
  mocks.settings = { activeRuntimeEnvironmentId: 'environment-a' }
  mocks.transitions.mockResolvedValue([transition('old')])
  mocks.update.mockResolvedValue({ ok: true })
})
describe('Jira transition form source ownership', () => {
  it.each([
    { label: 'host', next: { ...source, hostId: 'runtime:environment-b' } },
    { label: 'project', next: { ...source, projectId: 'project-b' } },
    { label: 'account', next: { ...source, accountLabel: 'Account B' } },
    {
      label: 'provider identity',
      next: {
        ...source,
        providerIdentity: { provider: 'jira', siteId: 'site-b', projectKey: 'APP' }
      }
    }
  ] satisfies { label: string; next: TaskSourceContext }[])(
    'drops an old required-field form when the $label changes for the same site and key',
    async ({ next }) => {
      const view = render(workspace(source))
      await openForm()
      fireEvent.change(screen.getByLabelText('Comment'), { target: { value: 'Old source draft' } })
      mocks.transitions.mockResolvedValue([transition('new')])
      view.rerender(workspace(next))
      await waitForTransitions()
      expect(screen.queryByLabelText('Comment')).toBeNull()
      expect(mocks.update).not.toHaveBeenCalled()
      await openForm()
      fireEvent.change(screen.getByLabelText('Comment'), {
        target: { value: 'New source comment' }
      })
      fireEvent.click(screen.getByRole('button', { name: 'Change status' }))
      await waitFor(() =>
        expect(mocks.update).toHaveBeenCalledWith(
          taskSourceRuntimeTarget(next),
          issue.key,
          { transitionId: 'new', transitionComment: 'New source comment' },
          'site-a'
        )
      )
    }
  )
  it('keeps transition reads and required-field submission on the issue owner after settings change', async () => {
    const view = render(workspace(source))
    await openForm()
    mocks.settings = { activeRuntimeEnvironmentId: 'unrelated-default' }
    view.rerender(workspace(source))
    await waitForTransitions()
    await screen.findByLabelText('Comment')
    fireEvent.change(screen.getByLabelText('Comment'), { target: { value: 'Owned comment' } })
    fireEvent.click(screen.getByRole('button', { name: 'Change status' }))
    await waitFor(() =>
      expect(mocks.update).toHaveBeenCalledWith(
        { kind: 'environment', environmentId: 'environment-a' },
        issue.key,
        { transitionId: 'old', transitionComment: 'Owned comment' },
        'site-a'
      )
    )
    expect(
      mocks.transitions.mock.calls.every(([owner]) => owner.environmentId === 'environment-a')
    ).toBe(true)
  })
  it('ignores a transition response from the previous execution host', async () => {
    let finishOldRead = (_transitions: JiraTransition[]): void => {}
    mocks.transitions.mockReturnValueOnce(
      new Promise<JiraTransition[]>((resolve) => {
        finishOldRead = resolve
      })
    )
    const view = render(workspace(source))
    await waitFor(() => expect(mocks.transitions).toHaveBeenCalledTimes(1))
    mocks.transitions.mockResolvedValue([transition('new-owner')])
    view.rerender(workspace({ ...source, hostId: 'runtime:environment-b' }))
    await waitForTransitions()
    await act(async () => finishOldRead([transition('old-owner')]))
    await openForm()
    fireEvent.change(screen.getByLabelText('Comment'), { target: { value: 'New owner comment' } })
    fireEvent.click(screen.getByRole('button', { name: 'Change status' }))
    await waitFor(() =>
      expect(mocks.update).toHaveBeenCalledWith(
        { kind: 'environment', environmentId: 'environment-b' },
        issue.key,
        { transitionId: 'new-owner', transitionComment: 'New owner comment' },
        'site-a'
      )
    )
  })
  it('drops a half-filled form when the source changes execution host', async () => {
    const view = render(workspace(source))
    await openForm()
    view.rerender(workspace({ ...source, hostId: 'runtime:environment-b' }))
    await waitForTransitions()
    expect(screen.queryByLabelText('Comment')).toBeNull()
    expect(mocks.update).not.toHaveBeenCalled()
  })

  it("shows Jira's field-level refusal against the control that failed, end to end", async () => {
    // Why through the real workspace: the mutation hook used to flatten the result to
    // `{ ok, error }`, so a field error reached this control as undefined.
    mocks.transitions.mockResolvedValue([
      {
        id: 'with-field',
        name: 'Close',
        to: { ...issue.status, id: 'done', name: 'Done' },
        fields: [
          {
            key: 'customfield_42',
            name: 'Release approval',
            required: true,
            schema: { type: 'string' }
          }
        ]
      }
    ])
    mocks.update.mockResolvedValue({
      ok: false,
      error: 'Jira rejected the update.',
      fieldErrors: { customfield_42: 'Release approval must be Approved.' }
    })
    render(workspace(source))
    await waitForTransitions()
    fireEvent.click(screen.getByRole('button', { name: 'Change status: Open' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Close' }))
    const input = await screen.findByPlaceholderText('Enter Release approval')
    fireEvent.change(input, { target: { value: 'pending' } })
    const form = input.closest('form')
    if (!form) {
      throw new Error('Expected the transition form')
    }
    fireEvent.submit(form)
    // Why waitFor + getBy rather than findBy: a DOM query that times out here fails in
    // this file's bun pool with a masked `Test Run Error`, so the assertion is kept
    // synchronous inside the retry.
    await waitFor(() => expect(screen.getByText('Release approval must be Approved.')).toBeTruthy())
    expect(screen.getByPlaceholderText('Enter Release approval')).toBeTruthy()
  })

  it('reopens a one-click transition as a form when Jira refuses it by field', async () => {
    // A skipped, already-filled field can still be refused (a stale value, or a
    // validator demanding it be set), and the user needs a control to act on.
    mocks.transitions.mockResolvedValue([
      {
        id: 'filled',
        name: 'Close',
        to: { ...issue.status, id: 'done', name: 'Done' },
        fields: [
          {
            key: 'components',
            name: 'Component/s',
            required: true,
            hasCurrentValue: true,
            currentValue: 'Web',
            schema: { type: 'array', items: 'string' }
          }
        ]
      }
    ])
    mocks.update.mockResolvedValue({
      ok: false,
      error: 'Jira rejected the update.',
      fieldErrors: { components: 'Component/s is required.' }
    })
    render(workspace(source))
    await waitForTransitions()
    fireEvent.click(screen.getByRole('button', { name: 'Change status: Open' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Close' }))
    await waitFor(() =>
      expect(mocks.update).toHaveBeenCalledWith(
        taskSourceRuntimeTarget(source),
        issue.key,
        { transitionId: 'filled' },
        'site-a'
      )
    )
    await waitFor(() => expect(screen.getByText('Component/s is required.')).toBeTruthy())
    // Why the text-list placeholder: Component/s is `array/items: string`, which the
    // control map renders as a comma-separated list.
    const input = screen.getByPlaceholderText('Comma-separated values')
    // Why the resubmit matters: the reopened form must be able to send the very value
    // it shows, or the only way through is picking a different one.
    expect(input instanceof HTMLInputElement ? input.value : null).toBe('Web')
    const form = input.closest('form')
    if (!form) {
      throw new Error('Expected the transition form')
    }
    mocks.update.mockResolvedValue({ ok: true })
    fireEvent.submit(form)
    await waitFor(() =>
      expect(mocks.update).toHaveBeenLastCalledWith(
        taskSourceRuntimeTarget(source),
        issue.key,
        { transitionId: 'filled', transitionFields: { components: ['Web'] } },
        'site-a'
      )
    )
  })

  it('keeps the reason Jira gave when it names a field this form does not render', async () => {
    // Why: a key outside the transition's own fields opens no control, so nothing else
    // on screen can carry the sentence Jira sent.
    mocks.transitions.mockResolvedValue([
      {
        id: 'with-field',
        name: 'Close',
        to: { ...issue.status, id: 'done', name: 'Done' },
        fields: [
          {
            key: 'customfield_42',
            name: 'Release approval',
            required: true,
            schema: { type: 'string' }
          }
        ]
      }
    ])
    mocks.update.mockResolvedValue({
      ok: false,
      error: 'You do not have permission to set Close reason.',
      fieldErrors: { customfield_99: 'You do not have permission to set Close reason.' }
    })
    render(workspace(source))
    await waitForTransitions()
    fireEvent.click(screen.getByRole('button', { name: 'Change status: Open' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Close' }))
    const input = await screen.findByPlaceholderText('Enter Release approval')
    fireEvent.change(input, { target: { value: 'approved' } })
    const form = input.closest('form')
    if (!form) {
      throw new Error('Expected the transition form')
    }
    fireEvent.submit(form)
    await waitFor(() =>
      expect(screen.getByText('You do not have permission to set Close reason.')).toBeTruthy()
    )
  })

  it("shows Jira's workflow message beside a field error rather than instead of it", async () => {
    // Why: readJiraErrorDetail joins both into `message`, and a field-level display used
    // to swallow the workflow half entirely.
    mocks.transitions.mockResolvedValue([
      {
        id: 'with-field',
        name: 'Close',
        to: { ...issue.status, id: 'done', name: 'Done' },
        fields: [
          {
            key: 'customfield_42',
            name: 'Release approval',
            required: true,
            schema: { type: 'string' }
          }
        ]
      }
    ])
    mocks.update.mockResolvedValue({
      ok: false,
      error: 'Approval task not complete; Release approval must be Approved.',
      errorMessages: ['Approval task not complete'],
      fieldErrors: { customfield_42: 'Release approval must be Approved.' }
    })
    render(workspace(source))
    await waitForTransitions()
    fireEvent.click(screen.getByRole('button', { name: 'Change status: Open' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Close' }))
    const input = await screen.findByPlaceholderText('Enter Release approval')
    fireEvent.change(input, { target: { value: 'pending' } })
    const form = input.closest('form')
    if (!form) {
      throw new Error('Expected the transition form')
    }
    fireEvent.submit(form)
    await waitFor(() => expect(screen.getByText('Release approval must be Approved.')).toBeTruthy())
    expect(screen.getByText('Approval task not complete')).toBeTruthy()
  })

  it('keeps a field a rejection brought back while the next attempt is in flight', async () => {
    // Why: clearing the messages at submit time must not un-ask for the field, or the
    // value the user just typed disappears and the next submit leaves it out.
    mocks.transitions.mockResolvedValue([
      {
        id: 'with-field',
        name: 'Close',
        to: { ...issue.status, id: 'done', name: 'Done' },
        fields: [
          {
            key: 'customfield_42',
            name: 'Release approval',
            required: true,
            schema: { type: 'string' }
          }
        ]
      }
    ])
    mocks.update.mockResolvedValueOnce({
      ok: false,
      error: 'Jira rejected the update.',
      fieldErrors: { customfield_42: 'Release approval must be Approved.' }
    })
    render(workspace(source))
    await waitForTransitions()
    fireEvent.click(screen.getByRole('button', { name: 'Change status: Open' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Close' }))
    const input = await screen.findByPlaceholderText('Enter Release approval')
    fireEvent.change(input, { target: { value: 'approved' } })
    const form = input.closest('form')
    if (!form) {
      throw new Error('Expected the transition form')
    }
    fireEvent.submit(form)
    await waitFor(() => expect(screen.getByText('Release approval must be Approved.')).toBeTruthy())
    mocks.update.mockResolvedValueOnce({ ok: false, error: 'Workflow step rejected.' })
    fireEvent.submit(form)
    await waitFor(() => expect(screen.getByText('Workflow step rejected.')).toBeTruthy())
    expect(screen.getByPlaceholderText('Enter Release approval')).toBeTruthy()
  })
})
