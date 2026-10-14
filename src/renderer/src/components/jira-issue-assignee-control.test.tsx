// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { JiraIssue, JiraUser } from '../../../shared/jira-types'
import type { RuntimeJiraSettings } from '@/runtime/runtime-jira-target'
import { JiraIssueAssigneeControl } from './jira-issue-assignee-control'

const search = vi.hoisted(() => vi.fn())
vi.mock('@/runtime/runtime-jira-client', () => ({ jiraListAssignableUsers: search }))

const SETTINGS: RuntimeJiraSettings = { kind: 'default-scope', settings: null }

function user(accountId: string, displayName: string): JiraUser {
  return { accountId, displayName }
}

const ADA = user('u-ada', 'Ada Lovelace')
const GRACE = user('u-grace', 'Grace Hopper')
const ALAN = user('u-alan', 'Alan Turing')
const BOB = user('u-bob', 'Bob Kahn')
const ZED = user('u-zed', 'Zed Shaw')

const PEOPLE = new Set([
  ADA.displayName,
  GRACE.displayName,
  ALAN.displayName,
  BOB.displayName,
  ZED.displayName
])

const ISSUE: JiraIssue = {
  id: '1001',
  key: 'ABC-1',
  siteId: 'site-1',
  title: 'Payments issue',
  url: 'https://example.atlassian.net/browse/ABC-1',
  project: { id: 'project-1', key: 'ABC', name: 'Payments' },
  issueType: { id: 'story', name: 'Story' },
  status: { id: '1', name: 'To Do', categoryKey: 'new', categoryName: 'To Do' },
  labels: [],
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-02T00:00:00.000Z'
}

/** The person rows on screen, in the order the popover rendered them. */
function shownPeople(): string[] {
  return screen
    .getAllByRole('button')
    .map((button) => button.textContent ?? '')
    .filter((label) => PEOPLE.has(label))
}

function renderControl({
  users = [GRACE, ALAN],
  selfUser = ADA
}: { users?: JiraUser[]; selfUser?: JiraUser | null } = {}): ReturnType<typeof vi.fn> {
  const mutateIssue = vi.fn()
  render(
    <JiraIssueAssigneeControl
      displayed={ISSUE}
      users={users}
      selfUser={selfUser}
      providerSettings={SETTINGS}
      pending={false}
      mutateIssue={mutateIssue}
    />
  )
  return mutateIssue
}

function openAndType(value: string): void {
  fireEvent.click(screen.getByRole('button', { name: '+ Assignee' }))
  fireEvent.change(screen.getByPlaceholderText('Search users'), { target: { value } })
}

afterEach(() => {
  cleanup()
  search.mockReset()
})

describe('JiraIssueAssigneeControl', () => {
  it('pins the current user and the project roster without a second lookup', async () => {
    renderControl()
    fireEvent.click(screen.getByRole('button', { name: '+ Assignee' }))
    expect(shownPeople()).toEqual([ADA.displayName, GRACE.displayName, ALAN.displayName])

    // Why the wait: the lookup is debounced, so asserting now would pass even if an
    // empty query did schedule a request. Outlast the debounce before asserting.
    await new Promise((resolve) => setTimeout(resolve, 400))
    expect(search).not.toHaveBeenCalled()
    expect(shownPeople()).toEqual([ADA.displayName, GRACE.displayName, ALAN.displayName])
  })

  it('finds someone outside the loaded roster once a query is typed', async () => {
    search.mockResolvedValue([BOB])
    renderControl()
    openAndType('bob')

    await waitFor(() => expect(search).toHaveBeenCalledWith(SETTINGS, 'ABC-1', 'bob', 'site-1'))
    await waitFor(() => expect(shownPeople()).toEqual([BOB.displayName]))
  })

  it('keeps a matching teammate above the other matches', async () => {
    search.mockResolvedValue([ZED, GRACE])
    renderControl({ users: [GRACE] })
    openAndType('h')

    await waitFor(() => expect(shownPeople()).toEqual([GRACE.displayName, ZED.displayName]))
  })

  it("does not show the previous query's matches under the next query", async () => {
    search.mockResolvedValueOnce([BOB])
    renderControl()
    openAndType('bob')
    await waitFor(() => expect(shownPeople()).toEqual([BOB.displayName]))

    search.mockImplementationOnce(() => new Promise<JiraUser[]>(() => {}))
    fireEvent.change(screen.getByPlaceholderText('Search users'), { target: { value: 'g' } })

    await waitFor(() => expect(search).toHaveBeenLastCalledWith(SETTINGS, 'ABC-1', 'g', 'site-1'))
    expect(shownPeople()).not.toContain(BOB.displayName)
    expect(screen.getByText('Searching…')).toBeTruthy()
  })

  it('assigns the picked user and closes', async () => {
    search.mockResolvedValue([BOB])
    const mutateIssue = renderControl()
    openAndType('bob')
    fireEvent.click(await screen.findByRole('button', { name: BOB.displayName }))

    expect(mutateIssue).toHaveBeenCalledWith(
      'assignee',
      { assigneeAccountId: BOB.accountId },
      { assignee: BOB }
    )
    await waitFor(() => expect(screen.queryByPlaceholderText('Search users')).toBeNull())
  })

  it('clears the assignee', () => {
    const mutateIssue = renderControl()
    fireEvent.click(screen.getByRole('button', { name: '+ Assignee' }))
    fireEvent.click(screen.getByRole('button', { name: 'Unassigned' }))

    expect(mutateIssue).toHaveBeenCalledWith(
      'assignee',
      { assigneeAccountId: null },
      {
        assignee: undefined
      }
    )
  })

  it('says when the query matched nobody', async () => {
    search.mockResolvedValue([])
    renderControl()
    openAndType('zzz')

    await screen.findByText('No users found')
  })

  it('pins the roster alone when the viewer is not resolvable', () => {
    renderControl({ selfUser: null })
    fireEvent.click(screen.getByRole('button', { name: '+ Assignee' }))

    expect(shownPeople()).toEqual([GRACE.displayName, ALAN.displayName])
  })
})
