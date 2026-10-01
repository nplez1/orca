import type { ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { PRInfo } from '../../../../shared/github/pull-request-types'
import type { Repo } from '../../../../shared/repo-types'
import { makeWorktree } from '../../store/slices/worktrees-slice-test-fixtures'
import HostedReviewActions from './HostedReviewActions'
import type { HostedReviewActionInfo } from './use-hosted-review-actions'

type RecordedHookArgs = { adminBypassRequired: boolean }

/** Why not `vi.hoisted`: only the mocked hook's returned function reads this, at render time. */
const recordedHookArgs: { current: RecordedHookArgs | null } = { current: null }

vi.mock('@/store', () => ({ useAppStore: () => false }))
vi.mock('./use-hosted-review-actions', () => ({
  useHostedReviewActions: (args: RecordedHookArgs) => {
    recordedHookArgs.current = args
    return {
      merging: false,
      readying: false,
      stateUpdating: null,
      actionError: null,
      handleMerge: vi.fn(),
      handleAutoMerge: vi.fn(),
      handleMarkReadyForReview: vi.fn(),
      handleCloseReview: vi.fn(),
      handleReopenReview: vi.fn()
    }
  }
}))
vi.mock('@/components/ui/dropdown-menu', () => ({
  DropdownMenu: ({ children }: { children: ReactNode }) => <>{children}</>,
  DropdownMenuTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  DropdownMenuContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuItem: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuSeparator: () => <hr />
}))

const repo: Repo = {
  id: 'repo-1',
  path: '/repo',
  displayName: 'orca',
  badgeColor: '#4c8dff',
  addedAt: 0
}
const worktree = makeWorktree({ id: 'worktree-1', repoId: repo.id })

function makeApprovalGatedPR(viewerCanMergeAsAdmin?: boolean): PRInfo {
  return {
    number: 45,
    title: 'PR',
    state: 'open',
    url: 'https://github.com/stablyai/orca/pull/45',
    checksStatus: 'success',
    updatedAt: '2026-04-01T00:00:00Z',
    mergeable: 'MERGEABLE',
    mergeStateStatus: 'UNSTABLE',
    reviewDecision: 'REVIEW_REQUIRED',
    // Known, not merely not-true: an unknown queue status must not be bypassed.
    mergeQueueRequired: false,
    ...(viewerCanMergeAsAdmin === undefined ? {} : { viewerCanMergeAsAdmin })
  }
}

function renderOpenReview({
  viewerCanMergeAsAdmin,
  autoMergeAllowed = true,
  stack = false
}: {
  viewerCanMergeAsAdmin?: boolean
  autoMergeAllowed?: boolean
  stack?: boolean
}): string {
  const review: HostedReviewActionInfo = {
    provider: 'github',
    number: 45,
    state: 'open',
    status: 'success',
    mergeable: 'MERGEABLE',
    reviewDecision: 'REVIEW_REQUIRED',
    // Optional checks failed, so GitHub reports UNSTABLE rather than a blocked merge box.
    mergeStateStatus: 'UNSTABLE',
    mergeQueueRequired: false,
    autoMergeAllowed
  }
  const githubPR: PRInfo = {
    ...makeApprovalGatedPR(viewerCanMergeAsAdmin),
    ...(stack ? { stack: { number: 90, position: 1, size: 1, baseRefName: 'main' } } : {})
  }
  return renderToStaticMarkup(
    <HostedReviewActions
      review={review}
      githubPR={githubPR}
      repo={repo}
      worktree={worktree}
      onRefreshReview={vi.fn().mockResolvedValue(undefined)}
    />
  )
}

/** The markup of the primary merge button, so `disabled` is read off the right element. */
function primaryMergeButton(markup: string): string {
  const start = markup.indexOf('<button')
  return markup.slice(start, markup.indexOf('</button>', start))
}

const DISABLED_ATTRIBUTE = /\sdisabled="/u

describe('HostedReviewActions admin merge bypass', () => {
  it('enables the merge, and asks the hook to confirm it, when the viewer may waive the review gate', () => {
    const button = primaryMergeButton(renderOpenReview({ viewerCanMergeAsAdmin: true }))

    expect(button).not.toMatch(DISABLED_ATTRIBUTE)
    // The primary action becomes the merge itself, not just the auto-merge it used to offer.
    expect(button).toContain('Squash and merge')
    // Which is why the confirmation the hook owes the user is the bypass one.
    expect(recordedHookArgs.current?.adminBypassRequired).toBe(true)
  })

  it('keeps the merge out of reach when the review gate does gate this viewer', () => {
    for (const viewerCanMergeAsAdmin of [undefined, false]) {
      // Auto-merge disabled, so nothing else can take the primary slot: the merge is simply refused.
      const button = primaryMergeButton(
        renderOpenReview({ viewerCanMergeAsAdmin, autoMergeAllowed: false })
      )

      expect(button).toMatch(DISABLED_ATTRIBUTE)
      expect(button).toContain('Approval required')
      expect(recordedHookArgs.current?.adminBypassRequired).toBe(false)
    }
  })

  it('asks a stacked pull request for a plain merge, not a bypass the host would not perform', () => {
    // Why: a stack merges entry by entry in the main process and never reaches the per-pull-request
    // preflight that carries --admin, so confirming a bypass here would promise one that cannot
    // happen. The stack's own merge affordance stays.
    const button = primaryMergeButton(
      renderOpenReview({ viewerCanMergeAsAdmin: true, stack: true })
    )

    expect(button).toContain('Merge through #45')
    expect(recordedHookArgs.current?.adminBypassRequired).toBe(false)
  })
})
