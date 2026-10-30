// @vitest-environment happy-dom

import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { JiraIssue, JiraSprint } from '../../../shared/jira/jira-types'
import { buildJiraIssueWorkspaceAttachmentIndex } from '@/lib/jira-issue-workspace-attachment'
import { TooltipProvider } from '@/components/ui/tooltip'
import { TaskPageJiraIssueList } from './task-page-jira-issue-list'

vi.mock('@/i18n/i18n', () => ({
  getIntlLocale: () => 'en-US',
  translate: (_key: string, fallback: string) => fallback
}))

// The row sets its own grid rather than a container, so a child without a track wraps
// onto a second grid row. Nothing else in this suite can see that: jsdom does no layout.
const BREAKPOINTS = [null, 'md', 'lg', 'xl'] as const
type Breakpoint = (typeof BREAKPOINTS)[number]

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

const sprints: JiraSprint[] = [{ id: '87', name: 'September sprint', state: 'active' }]

function trackCount(className: string, breakpoint: Breakpoint): number {
  const border = '(?<![\\w:-])'
  const pattern =
    breakpoint === null
      ? new RegExp(`${border}grid-cols-\\[([^\\]]+)\\]`)
      : new RegExp(`${border}${breakpoint}:grid-cols-\\[([^\\]]+)\\]`)
  const match = pattern.exec(className)
  if (!match) {
    throw new Error(`row declares no grid columns for ${breakpoint ?? 'base'}`)
  }
  return match[1].split('_').length
}

function classNameOf(child: Element): string {
  return typeof child.className === 'string' ? child.className : ''
}

/** Cells the row hides at a breakpoint. `max-md:!hidden` applies below md and
 *  `max-lg:!hidden` below lg, so each is absent from the count above its own width. */
function visibleChildren(row: Element, breakpoint: Breakpoint): number {
  const hiddenUtilities =
    breakpoint === 'lg' || breakpoint === 'xl'
      ? []
      : breakpoint === 'md'
        ? ['max-lg:!hidden']
        : ['max-md:!hidden', 'max-lg:!hidden']
  return [...row.children].filter((child) => {
    const classes = classNameOf(child).split(/\s+/)
    return !hiddenUtilities.some((utility) => classes.includes(utility))
  }).length
}

function assertRowFits(row: Element): void {
  for (const breakpoint of BREAKPOINTS) {
    const label = breakpoint ?? 'base'
    expect(trackCount(classNameOf(row), breakpoint), `${label}: tracks vs visible cells`).toBe(
      visibleChildren(row, breakpoint)
    )
  }
}

function renderList(sprintOptions?: { sprints: JiraSprint[] }): Element {
  const { container } = render(
    <TooltipProvider>
      <TaskPageJiraIssueList
        formatUpdatedAt={() => 'now'}
        getStatusTone={() => ''}
        issues={[issue()]}
        issueWorkspaceAttachmentIndex={buildJiraIssueWorkspaceAttachmentIndex([])}
        onOpenIssue={vi.fn()}
        onOpenOrStartWorkspace={vi.fn()}
        selectedIssue={null}
        showSiteContext={false}
        sprintOptions={
          sprintOptions
            ? {
                sprints: sprintOptions.sprints,
                assigningIssueKey: null,
                onAssignSprint: vi.fn()
              }
            : undefined
        }
        statusOrder={null}
        groupByStatus={false}
      />
    </TooltipProvider>
  )
  const row = container.querySelector('div[role="button"]')
  if (!row) {
    throw new Error('issue row was not rendered')
  }
  return row
}

afterEach(cleanup)

describe('Jira issue row layout', () => {
  it('gives every visible cell a track in the flat issue list', () => {
    assertRowFits(renderList())
  })

  it('gives every visible cell a track once the backlog sprint cell is added', () => {
    assertRowFits(renderList({ sprints }))
  })
})
