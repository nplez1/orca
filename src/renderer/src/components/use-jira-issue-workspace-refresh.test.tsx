// @vitest-environment happy-dom

import React, { act, useRef } from 'react'
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { JiraIssue } from '../../../shared/jira/jira-types'
import type { EditableJiraIssueField } from './jira-issue-workspace-hydration'
import { useJiraIssueWorkspaceRefresh } from './use-jira-issue-workspace-refresh'

const mocks = vi.hoisted(() => ({
  jiraGetIssue: vi.fn(),
  patchJiraIssue: vi.fn()
}))

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: unknown) => unknown) =>
    selector({ settings: null, patchJiraIssue: mocks.patchJiraIssue })
}))

vi.mock('@/runtime/runtime-jira-client', () => ({
  jiraGetIssue: (...args: unknown[]) => mocks.jiraGetIssue(...args)
}))

const settings = { hostId: null } as unknown as Parameters<
  typeof useJiraIssueWorkspaceRefresh
>[0]['providerSettings']

function issue(key: string, title = `Title ${key}`): JiraIssue {
  return {
    id: key,
    key,
    siteId: 'site-1',
    title,
    url: `https://example.atlassian.net/browse/${key}`,
    project: { id: 'project-1', key: 'ABC', name: 'Payments' },
    issueType: { id: 'story', name: 'Story' },
    status: { id: '1', name: 'Ready', categoryKey: 'new', categoryName: 'To Do' },
    labels: [],
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-02T00:00:00.000Z'
  }
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve: (value: T) => void = () => {}
  const promise = new Promise<T>((settle) => {
    resolve = settle
  })
  return { promise, resolve }
}

const NO_EDITED_FIELDS: EditableJiraIssueField[] = []

function Probe({
  current,
  edited = NO_EDITED_FIELDS,
  onRefresh
}: {
  current: JiraIssue
  edited?: EditableJiraIssueField[]
  onRefresh: (refresh: () => Promise<void>) => void
}): React.JSX.Element {
  const editedFieldsRef = useRef(new Set<EditableJiraIssueField>(edited))
  const { refresh } = useJiraIssueWorkspaceRefresh({
    displayed: current,
    providerSettings: settings,
    sourceContext: null,
    editedFieldsRef,
    reloadTransitions: async () => {},
    refreshSignal: 0,
    setFullIssue: (next) => mocks.patchJiraIssue('renderedIssue', next)
  })
  onRefresh(refresh)
  return <div>{current.key}</div>
}

function renderedIssue(): JiraIssue | undefined {
  const call = mocks.patchJiraIssue.mock.calls.find(([scope]) => scope === 'renderedIssue')
  return call?.[1] as JiraIssue | undefined
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('useJiraIssueWorkspaceRefresh', () => {
  it('drops a refresh that settles after the selection moved to another issue', async () => {
    const lateRead = deferred<JiraIssue>()
    mocks.jiraGetIssue.mockImplementation((_settings: unknown, key: string) =>
      key === 'ABC-1' ? lateRead.promise : Promise.resolve(issue('ABC-2'))
    )
    let refresh = async (): Promise<void> => {}
    const { rerender } = render(
      <Probe current={issue('ABC-1')} onRefresh={(next) => (refresh = next)} />
    )

    let inFlight: Promise<void> = Promise.resolve()
    act(() => {
      inFlight = refresh()
    })
    rerender(<Probe current={issue('ABC-2')} onRefresh={(next) => (refresh = next)} />)

    await act(async () => {
      lateRead.resolve(issue('ABC-1', 'Stale title'))
      await inFlight
    })

    expect(renderedIssue()).toBeUndefined()
    expect(mocks.patchJiraIssue).not.toHaveBeenCalled()
  })

  it('keeps an unsaved edit when a refresh lands for the same issue', async () => {
    mocks.jiraGetIssue.mockResolvedValue(issue('ABC-1', 'Server title'))

    let refresh = async (): Promise<void> => {}
    render(
      <Probe
        current={issue('ABC-1', 'Draft title')}
        edited={['title']}
        onRefresh={(next) => (refresh = next)}
      />
    )

    await act(async () => {
      await refresh()
    })

    expect(renderedIssue()).toMatchObject({ key: 'ABC-1', title: 'Draft title' })
  })

  it('applies a read for the issue it was issued for', async () => {
    mocks.jiraGetIssue.mockResolvedValue(issue('ABC-1', 'Server title'))

    let refresh = async (): Promise<void> => {}
    render(<Probe current={issue('ABC-1')} onRefresh={(next) => (refresh = next)} />)

    await act(async () => {
      await refresh()
    })

    expect(renderedIssue()).toMatchObject({ key: 'ABC-1', title: 'Server title' })
    expect(mocks.patchJiraIssue).toHaveBeenCalledWith('ABC-1', expect.anything(), expect.anything())
  })
})
