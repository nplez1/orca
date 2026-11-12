// @vitest-environment happy-dom
import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WorkspaceStatusDefinition, Worktree } from '../../../../../../shared/worktree/types'
import { TooltipProvider } from '@/components/ui/tooltip'
import { makeWorktree } from '@/store/slices/worktrees/worktree.test-fixture'
import WorkspaceKanbanStatusLane from './WorkspaceKanbanStatusLane'

vi.mock('./WorkspaceKanbanLaneCardList', () => ({
  default: ({ items }: { items: readonly Worktree[] }) => (
    <div data-testid="cards">{items.map((worktree) => worktree.id).join(',')}</div>
  )
}))

const STATUS: WorkspaceStatusDefinition = { id: 'in-progress', label: 'In progress' }
const EMPTY_REPO_MAP = new Map()
const SHOW_HIDDEN_LABEL = 'Show workspaces hidden by filters'

function renderLane(overrides: {
  items?: readonly Worktree[]
  totalCount?: number
  hiddenCount?: number
  hasQuery?: boolean
  onShowHidden?: (statusId: string) => void
}): ReturnType<typeof render> {
  return render(
    <TooltipProvider>
      <WorkspaceKanbanStatusLane
        status={STATUS}
        items={overrides.items ?? []}
        totalCount={overrides.totalCount ?? overrides.items?.length ?? 0}
        hiddenCount={overrides.hiddenCount}
        hasQuery={overrides.hasQuery}
        repoMap={EMPTY_REPO_MAP}
        activeWorktreeIdentity={null}
        columnWidth={308}
        isResizingColumn={false}
        isDragTarget={false}
        renderCards
        selectedWorktreeIds={new Set()}
        selectedWorktrees={[]}
        onDragOver={() => {}}
        onDragLeave={() => {}}
        onDrop={() => {}}
        onActivate={() => {}}
        onSelectionGesture={() => false}
        onContextMenuSelect={() => []}
        onCreateWorktree={() => {}}
        onShowHidden={overrides.onShowHidden ?? (() => {})}
        onColumnResizeStart={() => {}}
        onColumnResizeKeyDown={() => {}}
      />
    </TooltipProvider>
  )
}

afterEach(cleanup)

describe('WorkspaceKanbanStatusLane', () => {
  it('reads Empty only when no workspace has the status', () => {
    const rendered = renderLane({})

    expect(rendered.getByText('Empty')).toBeTruthy()
    expect(rendered.queryByText(/hidden by filters/)).toBeNull()
    expect(rendered.queryByRole('button', { name: SHOW_HIDDEN_LABEL })).toBeNull()
  })
  it('reports the members the sidebar filters hide instead of reading Empty', () => {
    const rendered = renderLane({ hiddenCount: 3 })

    expect(rendered.getByText('3 hidden by filters')).toBeTruthy()
    expect(rendered.queryByText('Empty')).toBeNull()
  })

  it('offers Show for the hidden members', () => {
    const onShowHidden = vi.fn()
    const rendered = renderLane({ hiddenCount: 3, onShowHidden })

    fireEvent.click(rendered.getByRole('button', { name: SHOW_HIDDEN_LABEL }))

    expect(onShowHidden).toHaveBeenCalledWith('in-progress')
  })

  it('keeps No matches for a query that filters out visible cards', () => {
    const rendered = renderLane({ items: [], totalCount: 2, hasQuery: true })

    expect(rendered.getByText('No matches')).toBeTruthy()
    expect(rendered.queryByText('Empty')).toBeNull()
  })

  it('counts hidden members in the badge of a lane that still shows cards', () => {
    const rendered = renderLane({
      items: [makeWorktree({ id: 'shown', repoId: 'repo' })],
      totalCount: 1,
      hiddenCount: 2
    })

    expect(rendered.getByText('1 / 3')).toBeTruthy()
    expect(rendered.getByTestId('cards').textContent).toBe('shown')
    expect(rendered.queryByText('Empty')).toBeNull()
  })

  it('keeps the search badge counting only what the query could match', () => {
    const rendered = renderLane({
      items: [makeWorktree({ id: 'matched', repoId: 'repo' })],
      totalCount: 3,
      hiddenCount: 7,
      hasQuery: true
    })

    expect(rendered.getByText('1 / 3')).toBeTruthy()
    expect(rendered.getByText('7 hidden by filters')).toBeTruthy()
  })
})
