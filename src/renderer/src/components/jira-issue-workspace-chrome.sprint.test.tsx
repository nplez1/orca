// @vitest-environment happy-dom

import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ComponentProps } from 'react'
import type { JiraIssue, JiraSprintAssignment } from '../../../shared/jira/jira-types'
import { JiraIssueMetadataBar } from './jira-issue-workspace-chrome'
import { TooltipProvider } from '@/components/ui/tooltip'
import { defaultScopeHost } from '@/lib/default-creation-host'

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))
vi.mock('@/i18n/relative-time-format', () => ({
  formatUiRelativeTimeFromDate: () => 'now'
}))

function issue(): JiraIssue {
  return {
    id: '1001',
    key: 'ABC-1',
    siteId: 'site-1',
    title: 'Payments issue',
    url: 'https://example.atlassian.net/browse/ABC-1',
    project: { id: 'project-1', key: 'ABC', name: 'Payments' },
    issueType: { id: 'story', name: 'Story' },
    status: { id: '1', name: 'Ready', categoryKey: 'new', categoryName: 'To Do' },
    labels: [],
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-02T00:00:00.000Z'
  }
}

const sprintAssignment: JiraSprintAssignment = {
  sprint: { id: '87', name: 'September sprint', state: 'active' },
  sprints: [
    { id: '87', name: 'September sprint', state: 'active' },
    { id: '88', name: 'October sprint', state: 'future' }
  ]
}

type MutateIssue = ComponentProps<typeof JiraIssueMetadataBar>['mutateIssue']

function renderBar({
  assignment = sprintAssignment,
  mutateIssue = vi.fn<MutateIssue>(async () => ({ ok: true }))
}: {
  assignment?: JiraSprintAssignment | null
  mutateIssue?: MutateIssue
} = {}): MutateIssue {
  render(
    <TooltipProvider>
      <JiraIssueMetadataBar
        displayed={issue()}
        pendingField={null}
        transitions={[]}
        transitionsLoading={false}
        transitionsError={null}
        reloadTransitions={vi.fn()}
        priorities={[]}
        prioritiesError={null}
        users={[]}
        editFields={[]}
        editFieldsLoading={false}
        editFieldsError={null}
        reloadEditFields={vi.fn()}
        selfUser={null}
        providerSettings={defaultScopeHost(null)}
        owner={{ kind: 'local' }}
        runtimeContextKey="local#0"
        sprintAssignment={assignment}
        sprintAssignmentError={null}
        mutateIssue={mutateIssue}
        submitIssueFields={async () => ({ ok: true })}
      />
    </TooltipProvider>
  )
  return mutateIssue
}

afterEach(cleanup)

describe('JiraIssueMetadataBar sprint control', () => {
  it('shows the issue sprint and moves it to another one', async () => {
    const user = userEvent.setup()
    const mutateIssue = renderBar()

    await user.click(screen.getByRole('button', { name: 'September sprint' }))
    await user.click(await screen.findByRole('option', { name: /October sprint/ }))

    expect(mutateIssue).toHaveBeenCalledWith('sprint', { sprintId: '88' })
  })

  it('moves the issue out of its sprint', async () => {
    const user = userEvent.setup()
    const mutateIssue = renderBar()

    await user.click(screen.getByRole('button', { name: 'September sprint' }))
    await user.click(await screen.findByRole('option', { name: /Backlog/ }))

    expect(mutateIssue).toHaveBeenCalledWith('sprint', { sprintId: null })
  })

  it('reads as unassigned for an issue in the backlog', () => {
    renderBar({ assignment: { sprint: null, sprints: sprintAssignment.sprints } })

    expect(screen.getByRole('button', { name: '+ Sprint' })).toBeTruthy()
  })

  // No board in scope, or a host that predates the read: nothing to move into.
  it('renders no sprint control without an assignment', () => {
    renderBar({ assignment: null })

    expect(screen.queryByRole('button', { name: /sprint/i })).toBeNull()
  })
})
