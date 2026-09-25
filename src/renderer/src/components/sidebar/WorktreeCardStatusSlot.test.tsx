import { renderToStaticMarkup } from 'react-dom/server'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { WorktreeCardStatusSlot } from './WorktreeCardStatusSlot'
import type { HostedReviewInfo } from '../../../../shared/hosted-review'
import type { WorktreeCardPrDisplay } from './worktree-card-pr-display'

const mocks = vi.hoisted(() => ({
  status: 'active',
  sleeping: false
}))

vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <span data-tooltip-root="">{children}</span>,
  TooltipContent: ({ children }: { children: ReactNode }) => (
    <span data-tooltip-content="">{children}</span>
  ),
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>
}))

vi.mock('./use-worktree-activity-status', () => ({
  useWorktreeActivityStatus: () => mocks.status
}))

vi.mock('./use-worktree-sleep-state', () => ({
  useIsSleepingWorktree: () => mocks.sleeping
}))

describe('WorktreeCardStatusSlot', () => {
  beforeEach(() => {
    mocks.status = 'active'
    mocks.sleeping = false
  })

  const review: WorktreeCardPrDisplay = {
    provider: 'github',
    number: 123,
    title: 'Review me',
    state: 'open',
    status: 'failure'
  }
  const gitlabReview: WorktreeCardPrDisplay = {
    provider: 'gitlab',
    number: 456,
    title: 'Review me',
    state: 'open',
    status: 'pending'
  }

  it('lets the unread bell replace the visual status dot by default', () => {
    const markup = renderToStaticMarkup(
      <WorktreeCardStatusSlot
        worktreeId="wt-1"
        showStatus
        showUnreadAction
        isUnread
        unreadTooltip="Mark as read"
        onPointerDown={vi.fn()}
        onToggleUnread={vi.fn()}
      />
    )

    expect(markup).toContain('aria-label="Mark as read"')
    expect(markup).toContain('Mark as read')
    expect(markup).not.toContain('Active · Mark as read')
    expect(markup).not.toContain('bg-emerald-500')
    expect(markup).toContain('text-amber-500')
  })

  it('overlays an unread badge on the status dot when new card style is on', () => {
    const markup = renderToStaticMarkup(
      <WorktreeCardStatusSlot
        worktreeId="wt-1"
        showStatus
        showUnreadAction
        isUnread
        unreadTooltip="Mark as read"
        onPointerDown={vi.fn()}
        onToggleUnread={vi.fn()}
        newCardStyle
      />
    )

    expect(markup).not.toContain('aria-label="Mark as read"')
    expect(markup).not.toContain('Mark as read')
    expect(markup).toContain('Active · Unread')
    expect(markup).toContain('data-worktree-status-lane-unread=""')
    expect(markup).toContain('data-worktree-unread-alert=""')
    expect(markup).toContain('bg-amber-500')
    expect(markup).toContain('bg-emerald-500')
    expect(markup).not.toContain('lucide-bell')
    expect(markup).not.toContain('text-amber-500')
  })

  it('suppresses the new-card unread badge while unread status is working', () => {
    mocks.status = 'working'
    const markup = renderToStaticMarkup(
      <WorktreeCardStatusSlot
        worktreeId="wt-1"
        showStatus
        showUnreadAction
        isUnread
        unreadTooltip="Mark as read"
        onPointerDown={vi.fn()}
        onToggleUnread={vi.fn()}
        newCardStyle
      />
    )

    expect(markup).toContain('Working · Unread')
    expect(markup).toContain('border-yellow-500')
    expect(markup).not.toContain('data-worktree-status-lane-unread=""')
    expect(markup).not.toContain('data-worktree-unread-alert=""')
    expect(markup).not.toContain('aria-label="Mark as read"')
    expect(markup).not.toContain('lucide-bell')
    expect(markup).not.toContain('text-amber-500')
  })

  it('suppresses the new-card unread badge while unread status is permission', () => {
    mocks.status = 'permission'
    const markup = renderToStaticMarkup(
      <WorktreeCardStatusSlot
        worktreeId="wt-1"
        showStatus
        showUnreadAction
        isUnread
        unreadTooltip="Mark as read"
        onPointerDown={vi.fn()}
        onToggleUnread={vi.fn()}
        newCardStyle
      />
    )

    expect(markup).toContain('Needs permission · Unread')
    expect(markup).toContain('lucide-message-circle-question-mark')
    expect(markup).toContain('text-agent-question')
    expect(markup).not.toContain('data-worktree-status-lane-unread=""')
    expect(markup).not.toContain('data-worktree-unread-alert=""')
    expect(markup).not.toContain('aria-label="Mark as read"')
    expect(markup).not.toContain('lucide-bell')
  })

  it('keeps legacy unread working cards on the unread bell control', () => {
    mocks.status = 'working'
    const markup = renderToStaticMarkup(
      <WorktreeCardStatusSlot
        worktreeId="wt-1"
        showStatus
        showUnreadAction
        isUnread
        unreadTooltip="Mark as read"
        onPointerDown={vi.fn()}
        onToggleUnread={vi.fn()}
      />
    )

    expect(markup).toContain('aria-label="Mark as read"')
    expect(markup).toContain('Mark as read')
    expect(markup).toContain('Working')
    expect(markup).toContain('text-amber-500')
    expect(markup).not.toContain('border-yellow-500')
    expect(markup).not.toContain('data-worktree-unread-alert=""')
  })

  it('shows status in the unread toggle affordance', () => {
    const markup = renderToStaticMarkup(
      <WorktreeCardStatusSlot
        worktreeId="wt-1"
        showStatus
        showUnreadAction
        isUnread={false}
        unreadTooltip="Mark as unread"
        onPointerDown={vi.fn()}
        onToggleUnread={vi.fn()}
      />
    )

    expect(markup).toContain('Active · Mark as unread')
    expect(markup).toContain('bg-emerald-500')
    expect(markup.match(/data-tooltip-root/g)).toHaveLength(1)
  })

  it('keeps the quiet active dot ahead of PR status by default', () => {
    const markup = renderToStaticMarkup(
      <WorktreeCardStatusSlot
        worktreeId="wt-1"
        showStatus
        showUnreadAction={false}
        isUnread={false}
        unreadTooltip="Mark as unread"
        onPointerDown={vi.fn()}
        onToggleUnread={vi.fn()}
        prDisplay={review}
      />
    )

    expect(markup).toContain('Active')
    expect(markup).toContain('bg-emerald-500')
    expect(markup).not.toContain('PR checks: Failed')
  })

  it('uses PR status instead of the quiet active dot when new card style is on', () => {
    const markup = renderToStaticMarkup(
      <WorktreeCardStatusSlot
        worktreeId="wt-1"
        showStatus
        showUnreadAction={false}
        isUnread={false}
        unreadTooltip="Mark as unread"
        onPointerDown={vi.fn()}
        onToggleUnread={vi.fn()}
        prDisplay={review}
        newCardStyle
      />
    )

    expect(markup).toContain('PR checks: Failed')
    expect(markup).toContain('inline-flex size-5 items-center justify-center')
    expect(markup).toContain('size-[13px] translate-x-px')
    expect(markup).toContain('text-rose-500/85')
    expect(markup).not.toContain('bg-emerald-500')
    expect(markup).not.toContain('data-tooltip-root')
  })

  it('uses the unified compact review glyph for GitLab MR status', () => {
    const markup = renderToStaticMarkup(
      <WorktreeCardStatusSlot
        worktreeId="wt-1"
        showStatus
        showUnreadAction={false}
        isUnread={false}
        unreadTooltip="Mark as unread"
        onPointerDown={vi.fn()}
        onToggleUnread={vi.fn()}
        prDisplay={gitlabReview}
        newCardStyle
      />
    )

    expect(markup).toContain('MR checks: Pending')
    expect(markup).toContain('viewBox="0 0 16 16"')
    expect(markup).toContain('size-[13px] translate-x-px')
    expect(markup).toContain('text-amber-500/85')
    expect(markup).not.toContain('lucide-git-merge')
  })

  it('uses PR status instead of the quiet done dot when new card style is on', () => {
    mocks.status = 'done'
    const markup = renderToStaticMarkup(
      <WorktreeCardStatusSlot
        worktreeId="wt-1"
        showStatus
        showUnreadAction={false}
        isUnread={false}
        unreadTooltip="Mark as unread"
        onPointerDown={vi.fn()}
        onToggleUnread={vi.fn()}
        prDisplay={review}
        newCardStyle
      />
    )

    expect(markup).toContain('PR checks: Failed')
    expect(markup).not.toContain('bg-emerald-500')
  })

  it('keeps sleeping distinct from PR status when new card style is on', () => {
    // Why done, not inactive: a slept workspace keeps its retained done rows,
    // so its status still reads 'done' — the exact case from #19624.
    mocks.status = 'done'
    mocks.sleeping = true
    const markup = renderToStaticMarkup(
      <WorktreeCardStatusSlot
        worktreeId="wt-1"
        showStatus
        showUnreadAction={false}
        isUnread={false}
        unreadTooltip="Mark as unread"
        onPointerDown={vi.fn()}
        onToggleUnread={vi.fn()}
        prDisplay={review}
        newCardStyle
      />
    )

    // Why: sleep must stay distinct from awake completion; sleeping never collapses into PR.
    expect(markup).toContain('Sleeping')
    expect(markup).toContain('lucide-moon')
    expect(markup).not.toContain('PR checks: Failed')
    expect(markup).not.toContain('text-rose-500/85')
    expect(markup).not.toContain('bg-neutral-500/40')
  })

  it('keeps sleeping moon distinct from the awake green dot when new card style is on', () => {
    mocks.status = 'done'
    mocks.sleeping = true
    const markup = renderToStaticMarkup(
      <WorktreeCardStatusSlot
        worktreeId="wt-1"
        showStatus
        showUnreadAction={false}
        isUnread={false}
        unreadTooltip="Mark as unread"
        onPointerDown={vi.fn()}
        onToggleUnread={vi.fn()}
        newCardStyle
      />
    )

    expect(markup).toContain('Sleeping')
    expect(markup).toContain('lucide-moon')
    expect(markup).not.toContain('lucide-git-branch')
    expect(markup).not.toContain('bg-emerald-500')
    expect(markup).not.toContain('bg-neutral-500/40')
  })

  it('distinguishes awake branch from sleeping moon when new card style is on', () => {
    mocks.status = 'done'
    const awakeMarkup = renderToStaticMarkup(
      <WorktreeCardStatusSlot
        worktreeId="wt-1"
        showStatus
        showUnreadAction={false}
        isUnread={false}
        unreadTooltip="Mark as unread"
        onPointerDown={vi.fn()}
        onToggleUnread={vi.fn()}
        newCardStyle
        hasBranchIdentity
      />
    )
    expect(awakeMarkup).toContain('Branch')
    expect(awakeMarkup).toContain('lucide-git-branch')
    expect(awakeMarkup).not.toContain('lucide-moon')
    mocks.sleeping = true
    const sleepingMarkup = renderToStaticMarkup(
      <WorktreeCardStatusSlot
        worktreeId="wt-1"
        showStatus
        showUnreadAction={false}
        isUnread={false}
        unreadTooltip="Mark as unread"
        onPointerDown={vi.fn()}
        onToggleUnread={vi.fn()}
        newCardStyle
        hasBranchIdentity
      />
    )
    // Why: sleeping wins over the branch lane, even with an identity present.
    expect(sleepingMarkup).toContain('Sleeping')
    expect(sleepingMarkup).toContain('lucide-moon')
    expect(sleepingMarkup).not.toContain('lucide-git-branch')
  })

  it('shows the green awake dot for quiet done workspaces when new card style is on', () => {
    mocks.status = 'done'
    const markup = renderToStaticMarkup(
      <WorktreeCardStatusSlot
        worktreeId="wt-1"
        showStatus
        showUnreadAction={false}
        isUnread={false}
        unreadTooltip="Mark as unread"
        onPointerDown={vi.fn()}
        onToggleUnread={vi.fn()}
        newCardStyle
      />
    )

    expect(markup).toContain('Done')
    expect(markup).toContain('bg-emerald-500')
    expect(markup).not.toContain('lucide-git-branch')
    expect(markup).not.toContain('lucide-moon')
    expect(markup).toContain('data-tooltip-root')
  })

  it('keeps working activity ahead of PR status in new card style', () => {
    mocks.status = 'working'
    const markup = renderToStaticMarkup(
      <WorktreeCardStatusSlot
        worktreeId="wt-1"
        showStatus
        showUnreadAction={false}
        isUnread={false}
        unreadTooltip="Mark as unread"
        onPointerDown={vi.fn()}
        onToggleUnread={vi.fn()}
        prDisplay={review}
        newCardStyle
      />
    )

    expect(markup).toContain('Working')
    expect(markup).toContain('inline-flex size-5 items-center justify-center')
    expect(markup).toContain('border-yellow-500')
    expect(markup).toContain('data-tooltip-root')
    expect(markup).toContain('data-tooltip-content="">Working')
    expect(markup).not.toContain('PR checks: Failed')
  })

  it('keeps permission activity ahead of PR status in new card style', () => {
    mocks.status = 'permission'
    const markup = renderToStaticMarkup(
      <WorktreeCardStatusSlot
        worktreeId="wt-1"
        showStatus
        showUnreadAction={false}
        isUnread={false}
        unreadTooltip="Mark as unread"
        onPointerDown={vi.fn()}
        onToggleUnread={vi.fn()}
        prDisplay={review}
        newCardStyle
      />
    )

    expect(markup).toContain('Needs permission')
    expect(markup).toContain('lucide-message-circle-question-mark')
    expect(markup).toContain('text-agent-question')
    expect(markup).toContain('data-tooltip-root')
    expect(markup).toContain('data-tooltip-content="">Needs permission')
    expect(markup).not.toContain('PR checks: Failed')
  })

  it('keeps unread ahead of PR status by default', () => {
    const markup = renderToStaticMarkup(
      <WorktreeCardStatusSlot
        worktreeId="wt-1"
        showStatus
        showUnreadAction
        isUnread
        unreadTooltip="Mark as read"
        onPointerDown={vi.fn()}
        onToggleUnread={vi.fn()}
        prDisplay={review}
      />
    )

    expect(markup).toContain('aria-label="Mark as read"')
    expect(markup).toContain('Mark as read')
    expect(markup).not.toContain('Active · Mark as read')
    expect(markup).not.toContain('PR checks: Failed')
    expect(markup).not.toContain('bg-emerald-500')
    expect(markup).toContain('text-amber-500')
  })

  it('overlays an unread badge on PR status when new card style is on', () => {
    const markup = renderToStaticMarkup(
      <WorktreeCardStatusSlot
        worktreeId="wt-1"
        showStatus
        showUnreadAction
        isUnread
        unreadTooltip="Mark as read"
        onPointerDown={vi.fn()}
        onToggleUnread={vi.fn()}
        prDisplay={review}
        newCardStyle
      />
    )

    expect(markup).not.toContain('aria-label="Mark as read"')
    expect(markup).not.toContain('Mark as read')
    expect(markup).toContain('PR checks: Failed · Unread')
    expect(markup).toContain('data-worktree-status-lane-unread=""')
    expect(markup).toContain('data-worktree-unread-alert=""')
    expect(markup).not.toContain('group/unread')
    expect(markup).not.toContain('cursor-pointer')
    expect(markup).toContain('text-rose-500/85')
    expect(markup).toContain('bg-amber-500')
    expect(markup).not.toContain('lucide-bell')
    expect(markup).not.toContain('text-amber-500')
    expect(markup).not.toContain('bg-emerald-500')
    expect(markup).not.toContain('data-tooltip-root')
  })

  it('overlays an unread badge on the sleeping moon in new card style', () => {
    mocks.status = 'done'
    mocks.sleeping = true
    const markup = renderToStaticMarkup(
      <WorktreeCardStatusSlot
        worktreeId="wt-1"
        showStatus
        showUnreadAction
        isUnread
        unreadTooltip="Mark as read"
        onPointerDown={vi.fn()}
        onToggleUnread={vi.fn()}
        newCardStyle
      />
    )

    expect(markup).toContain('Sleeping · Unread')
    expect(markup).toContain('data-worktree-status-lane-unread=""')
    expect(markup).toContain('data-worktree-unread-alert=""')
    expect(markup).not.toContain('Mark as read')
    expect(markup).not.toContain('group/unread')
    expect(markup).not.toContain('cursor-pointer')
    expect(markup).toContain('lucide-moon')
    expect(markup).toContain('bg-amber-500')
    expect(markup).not.toContain('lucide-bell')
    expect(markup).not.toContain('text-amber-500')
    expect(markup).not.toContain('bg-emerald-500')
    expect(markup).not.toContain('data-tooltip-root')
  })

  describe('merge readiness marker', () => {
    // Why a separate channel from the glyph colour: checks and mergeability are different
    // questions, and a green glyph with green checks used to be the only signal a reader got.
    const renderStatedSlot = (prDisplay: WorktreeCardPrDisplay): string =>
      renderToStaticMarkup(
        <WorktreeCardStatusSlot
          worktreeId="wt-1"
          showStatus
          showUnreadAction={false}
          isUnread={false}
          unreadTooltip="Mark as unread"
          onPointerDown={vi.fn()}
          onToggleUnread={vi.fn()}
          prDisplay={prDisplay}
          newCardStyle
        />
      )

    // Why a concrete base rather than spreading the union-typed fixture: spreading a union
    // makes every field optional, which then satisfies neither review shape.
    const reviewBase: HostedReviewInfo = {
      provider: 'github',
      number: 123,
      title: 'Review me',
      state: 'open',
      url: 'https://example.com/pull/123',
      status: 'failure',
      updatedAt: '2026-01-01T00:00:00.000Z',
      mergeable: 'MERGEABLE'
    }
    const prWith = (overrides: Partial<HostedReviewInfo>): WorktreeCardPrDisplay => ({
      ...reviewBase,
      ...overrides
    })

    it('keeps the checks colour and adds a marker, so green checks never imply mergeable', () => {
      const blockers: [WorktreeCardPrDisplay, string, string][] = [
        [
          prWith({ status: 'success', reviewDecision: 'REVIEW_REQUIRED' }),
          'waiting',
          'bg-status-warning'
        ],
        [prWith({ status: 'success', mergeable: 'CONFLICTING' }), 'blocked', 'bg-destructive']
      ]

      for (const [prDisplay, readiness, tone] of blockers) {
        const markup = renderStatedSlot(prDisplay)

        expect(markup).toContain('text-emerald-500/80')
        expect(markup).toContain(`data-review-merge-marker="${readiness}"`)
        expect(markup).toContain(tone)
      }
    })

    it('names the specific blocker in the accessible label', () => {
      const markup = renderStatedSlot(
        prWith({ status: 'success', reviewDecision: 'REVIEW_REQUIRED' })
      )

      expect(markup).toContain('PR checks: Passing · Approval required')
    })

    it('drops the marker and claims readiness once the provider confirms the merge box is open', () => {
      const markup = renderStatedSlot(prWith({ status: 'success', mergeStateStatus: 'CLEAN' }))

      expect(markup).not.toContain('data-review-merge-marker')
      expect(markup).toContain('PR checks: Passing · Ready to merge')
    })

    it('marks a not-yet-computed merge state as undecided, not as ready', () => {
      // Why: GitHub recomputes the merge box after every push. During that window every blocker
      // is unknown, so a dotless green glyph would assert a mergeability nobody confirmed.
      const markup = renderStatedSlot(prWith({ status: 'success', mergeStateStatus: 'UNKNOWN' }))

      expect(markup).toContain('data-review-merge-marker="checking"')
      expect(markup).toContain('bg-muted-foreground/70')
      expect(markup).toContain('PR checks: Passing · Checking')
      expect(markup).not.toContain('Ready to merge')
      expect(markup).not.toContain('bg-status-warning')
    })

    it('stays silent when the provider reports no merge state at all', () => {
      // Why now silent: unlike a recompute, this is the steady state for a provider that cannot
      // answer, so dotting it would flag rows forever rather than for a moment.
      const markup = renderStatedSlot(prWith({ status: 'success', mergeable: 'UNKNOWN' }))

      expect(markup).not.toContain('data-review-merge-marker')
      expect(markup).not.toContain('Ready to merge')
    })

    it('stays silent when CI is the only thing in the way, since the glyph already says so', () => {
      // Why: the marker exists to report what the checks channel cannot. Firing it for a
      // checks-only blocker would dot nearly every in-flight PR and mean nothing more
      // than the colour it sits on.
      const markup = renderStatedSlot(prWith({ status: 'failure', mergeStateStatus: 'CLEAN' }))

      expect(markup).not.toContain('data-review-merge-marker')
      expect(markup).toContain('PR checks: Failed')
      expect(markup).not.toContain('Ready to merge')
    })

    it('does not raise a marker for a review whose state is already settled', () => {
      for (const state of ['merged', 'closed', 'draft'] as const) {
        const markup = renderStatedSlot(
          prWith({
            state,
            status: 'success',
            mergeable: 'CONFLICTING'
          })
        )

        expect(markup).not.toContain('data-review-merge-marker')
      }
    })
  })
})
