// @vitest-environment happy-dom

import type { ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { act, fireEvent, screen, waitFor } from '@testing-library/react'
import { useAppStore } from '@/store'
import type { JiraIssue, JiraSite } from '../../../../shared/jira-types'
import {
  REPO_ID,
  installWorktreeMetaDialogTestLifecycle,
  issueInput,
  makeWorktree,
  openDialog,
  providerChip,
  saveButton,
  updateWorktreeMeta
} from './worktree-meta-dialog.test-harness'

// Why: Radix tooltips need a provider the dialog does not own, and the menu's
// portal needs real layout. Stand-ins keep these tests on provider selection.
vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children?: ReactNode }) => <>{children}</>,
  TooltipContent: () => null,
  TooltipTrigger: ({ children }: { children?: ReactNode }) => <>{children}</>
}))

vi.mock('@/components/ui/dropdown-menu', async () => {
  const React = await import('react')
  const SelectContext = React.createContext<(value: string) => void>(() => {})
  const Passthrough = ({ children }: { children?: ReactNode }) => <>{children}</>
  return {
    DropdownMenu: Passthrough,
    DropdownMenuTrigger: Passthrough,
    DropdownMenuContent: Passthrough,
    DropdownMenuRadioGroup: ({
      value,
      onValueChange,
      children
    }: {
      value: string
      onValueChange: (value: string) => void
      children?: ReactNode
    }) => (
      <SelectContext.Provider value={onValueChange}>
        <div data-selected={value}>{children}</div>
      </SelectContext.Provider>
    ),
    DropdownMenuRadioItem: ({ value, children }: { value: string; children?: ReactNode }) => {
      const onSelect = React.useContext(SelectContext)
      return (
        <button type="button" role="menuitemradio" onClick={() => onSelect(value)}>
          {children}
        </button>
      )
    }
  }
})

installWorktreeMetaDialogTestLifecycle()

type JiraIssueLookup = ReturnType<typeof useAppStore.getState>['lookupJiraIssueSummary']

describe('WorktreeMetaDialog Jira issue link', () => {
  const JIRA_SITE: JiraSite = {
    id: 'site-1',
    siteUrl: 'https://acme.atlassian.net',
    email: 'me@acme.io',
    displayName: 'Acme',
    accountId: 'acc-1'
  }

  function jiraIssue(key: string): JiraIssue {
    return {
      id: '1001',
      key,
      siteId: 'site-1',
      title: 'Fix checkout',
      url: `https://acme.atlassian.net/browse/${key}`,
      project: { id: 'p1', key: key.slice(0, key.lastIndexOf('-')), name: 'Payments' },
      issueType: { id: 'story', name: 'Story' },
      status: {
        id: '2',
        name: 'In Progress',
        categoryKey: 'indeterminate',
        categoryName: 'In Progress'
      },
      labels: [],
      createdAt: '2026-09-01T00:00:00.000Z',
      updatedAt: '2026-09-02T00:00:00.000Z'
    }
  }

  const JIRA_WORK_ITEM = {
    provider: 'jira' as const,
    type: 'issue' as const,
    number: 0,
    title: 'ABC-1 Fix checkout',
    url: 'https://acme.atlassian.net/browse/ABC-1',
    jiraIdentifier: 'ABC-1'
  }

  // Before this the field could not show a Jira link at all: it seeded as an empty
  // GitHub field, which is what made the workspace's own link look missing.
  it('seeds the chip and value from a Jira work item', () => {
    openDialog({ worktree: { linkedWorkItem: JIRA_WORK_ITEM } })

    expect(issueInput().value).toBe('ABC-1')
    expect(providerChip().textContent).toContain('Jira')
  })

  it('writes the workspace link and clears the GitHub slot', async () => {
    const lookup = vi.fn<JiraIssueLookup>()
    lookup.mockResolvedValue(jiraIssue('ABC-9'))
    openDialog({
      worktree: { linkedIssue: 42 },
      jira: { sites: [JIRA_SITE], lookup }
    })

    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Jira' }))
    fireEvent.change(issueInput(), { target: { value: 'ABC-9' } })
    await act(async () => {
      fireEvent.click(saveButton())
    })

    await waitFor(() => expect(updateWorktreeMeta).toHaveBeenCalledTimes(1))
    const updates = updateWorktreeMeta.mock.calls[0]?.[1] ?? {}
    expect(updates.linkedIssue).toBeNull()
    expect(updates.linkedWorkItem).toEqual({
      provider: 'jira',
      type: 'issue',
      number: 0,
      title: 'Fix checkout',
      url: 'https://acme.atlassian.net/browse/ABC-9',
      jiraIdentifier: 'ABC-9'
    })
    expect(updates.linkedTaskSourceContext?.providerIdentity).toEqual({
      provider: 'jira',
      siteId: 'site-1',
      siteUrl: 'https://acme.atlassian.net',
      projectKey: 'ABC'
    })
  })

  // Writing the other providers' slots without the Jira pair would strand the
  // workspace on a link the pane cannot read, so a failed lookup must save nothing.
  it('keeps the dialog open and reports why when the lookup finds nothing', async () => {
    const lookup = vi.fn<JiraIssueLookup>()
    lookup.mockResolvedValue(null)
    openDialog({
      worktree: { linkedIssue: 42 },
      jira: { sites: [JIRA_SITE], lookup }
    })

    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Jira' }))
    fireEvent.change(issueInput(), { target: { value: 'ABC-404' } })
    await act(async () => {
      fireEvent.click(saveButton())
    })

    expect(updateWorktreeMeta).not.toHaveBeenCalled()
    expect(useAppStore.getState().activeModal).toBe('edit-meta')
    expect(screen.getByRole('alert').textContent).toContain('ABC-404')
  })

  it('keeps the operation going when only the stored Jira issue is respelled', async () => {
    const lookup = vi.fn<JiraIssueLookup>()
    lookup.mockResolvedValue(jiraIssue('ABC-1'))
    openDialog({
      worktree: { linkedWorkItem: JIRA_WORK_ITEM },
      jira: { sites: [JIRA_SITE], lookup }
    })

    fireEvent.change(issueInput(), { target: { value: 'https://acme.atlassian.net/browse/abc-1' } })
    await act(async () => {
      fireEvent.click(saveButton())
    })

    await waitFor(() => expect(updateWorktreeMeta).toHaveBeenCalledTimes(1))
    const updates = updateWorktreeMeta.mock.calls[0]?.[1] ?? {}
    // The workspace keeps its own item and site — nothing is re-resolved or lost,
    // and a disconnected Jira cannot block a comment or name edit.
    expect(updates).not.toHaveProperty('linkedWorkItem')
    expect(updates).not.toHaveProperty('linkedTaskSourceContext')
    expect(lookup).not.toHaveBeenCalled()
  })

  // This row has no editor for a change request or a GitLab issue, so replacing
  // one would drop metadata nothing here can restore.
  it.each([
    ['pr', 'only links issues'],
    ['gitlab-issue', 'cannot replace']
  ] as const)(
    'refuses a Jira link over a %s the field does not own',
    async (kind, expectedFragment) => {
      const lookup = vi.fn<JiraIssueLookup>()
      openDialog({
        worktree: {
          linkedPR: kind === 'pr' ? 35 : null,
          linkedWorkItem:
            kind === 'pr'
              ? {
                  provider: 'github',
                  type: 'pr',
                  number: 35,
                  title: 'Add the panel',
                  url: 'https://github.com/o/r/pull/35'
                }
              : {
                  provider: 'gitlab',
                  type: 'issue',
                  number: 7,
                  title: 'GitLab issue',
                  url: 'https://gitlab.com/o/r/issues/7'
                }
        },
        jira: { sites: [JIRA_SITE], lookup }
      })

      fireEvent.click(screen.getByRole('menuitemradio', { name: 'Jira' }))
      fireEvent.change(issueInput(), { target: { value: 'ABC-2' } })
      await act(async () => {
        fireEvent.click(saveButton())
      })

      expect(lookup).not.toHaveBeenCalled()
      expect(updateWorktreeMeta).not.toHaveBeenCalled()
      expect(useAppStore.getState().activeModal).toBe('edit-meta')
      expect(screen.getByRole('alert').textContent).toContain(expectedFragment)
    }
  )

  // A work item the field cannot replace can appear during the lookup. Reporting
  // success would claim a link that was silently dropped.
  it('fails the save when a protected work item appears during the lookup', async () => {
    let settleLookup: (issue: JiraIssue | null) => void = () => {}
    const lookup = vi.fn<JiraIssueLookup>().mockImplementation(
      () =>
        new Promise<JiraIssue | null>((resolve) => {
          settleLookup = resolve
        })
    )
    openDialog({
      worktree: { linkedIssue: 42 },
      jira: { sites: [JIRA_SITE], lookup }
    })

    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Jira' }))
    fireEvent.change(issueInput(), { target: { value: 'ABC-2' } })
    await act(async () => {
      fireEvent.click(saveButton())
    })

    // The workspace picks up a PR link while the lookup is in flight.
    useAppStore.setState({
      worktreesByRepo: {
        [REPO_ID]: [
          makeWorktree({
            linkedWorkItem: {
              provider: 'github',
              type: 'pr',
              number: 35,
              title: 'Add the panel',
              url: 'https://github.com/o/r/pull/35'
            }
          })
        ]
      }
    })

    await act(async () => {
      settleLookup(jiraIssue('ABC-2'))
    })

    expect(updateWorktreeMeta).not.toHaveBeenCalled()
    expect(useAppStore.getState().activeModal).toBe('edit-meta')
    expect(screen.getByRole('alert').textContent).toContain('only links issues')
  })

  // The lookup spans an await, and the Enter handlers stay live while it runs.
  it('writes once when a save is submitted twice during the lookup', async () => {
    let settleLookup: (issue: JiraIssue | null) => void = () => {}
    const lookup = vi.fn<JiraIssueLookup>().mockImplementation(
      () =>
        new Promise<JiraIssue | null>((resolve) => {
          settleLookup = resolve
        })
    )
    openDialog({
      worktree: { linkedIssue: 42 },
      jira: { sites: [JIRA_SITE], lookup }
    })

    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Jira' }))
    fireEvent.change(issueInput(), { target: { value: 'ABC-2' } })
    const comment = screen.getByPlaceholderText('Notes about this worktree...')
    await act(async () => {
      fireEvent.keyDown(comment, { key: 'Enter' })
      fireEvent.keyDown(comment, { key: 'Enter' })
    })

    await act(async () => {
      settleLookup(jiraIssue('ABC-2'))
    })

    await waitFor(() => expect(updateWorktreeMeta).toHaveBeenCalledTimes(1))
    expect(lookup).toHaveBeenCalledTimes(1)
  })

  // An unconfigured provider is a dead end: every save would need a lookup that
  // cannot succeed. GitHub stays because a bare number is a complete link.
  it('does not offer Linear while Linear is disconnected', () => {
    openDialog({ worktree: { linkedIssue: 42 } })

    expect(screen.queryByRole('menuitemradio', { name: 'Linear' })).toBeNull()
    expect(screen.queryByRole('menuitemradio', { name: 'Jira' })).toBeNull()
    expect(screen.getByRole('menuitemradio', { name: 'GitHub' })).toBeTruthy()
  })

  it('offers Jira once it is connected', () => {
    openDialog({
      worktree: { linkedIssue: 42 },
      jira: { sites: [JIRA_SITE], lookup: vi.fn<JiraIssueLookup>() }
    })

    expect(screen.getByRole('menuitemradio', { name: 'Jira' })).toBeTruthy()
  })

  // A disconnected provider with an existing link has to stay reachable, or the
  // user could neither see nor remove the link they already have.
  it('keeps a disconnected provider that holds the current link', () => {
    openDialog({ worktree: { linkedWorkItem: JIRA_WORK_ITEM } })

    expect(screen.getByRole('menuitemradio', { name: 'Jira' })).toBeTruthy()
  })
})
