import { renderToStaticMarkup } from 'react-dom/server'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { HostedReviewInfo } from '../../../../shared/hosted-review'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type { Repo } from '../../../../shared/repo-types'
import type { WorktreeCardProperty } from '../../../../shared/ui-chrome-types'
import type { Worktree } from '../../../../shared/worktree/types'

let worktreeCardProperties: WorktreeCardProperty[] = ['status', 'pr']
let hostedReviewCache: Record<string, unknown> = {}
let settings: Partial<GlobalSettings> | null = null

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: unknown) => unknown) =>
    selector({
      deleteStateByWorktreeId: {},
      fetchHostedReviewForBranch: vi.fn(),
      fetchIssue: vi.fn(),
      fetchLinearIssue: vi.fn(),
      gitConflictOperationByWorktree: {},
      hostedReviewCache,
      issueCache: {},
      linearIssueCache: {},
      openModal: vi.fn(),
      prCache: {},
      projectGroups: [],
      remoteBranchConflictByWorktreeId: {},
      settings,
      sshConnectionStates: new Map(),
      sshTargetLabels: new Map(),
      updateWorktreeMeta: vi.fn(),
      workspacePortScan: null,
      worktreeCardProperties
    })
}))

vi.mock('@/lib/worktree-activation', () => ({
  activateAndRevealWorktree: vi.fn()
}))

vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>
}))

vi.mock('./use-worktree-activity-status', () => ({
  useWorktreeActivityStatus: () => 'active'
}))

vi.mock('./use-worktree-sleep-state', () => ({
  useIsSleepingWorktree: () => false
}))

vi.mock('./CacheTimer', () => ({
  default: () => null,
  usePromptCacheCountdownStartedAt: () => null
}))

vi.mock('./WorktreeCardAgents', () => ({
  default: () => null
}))

vi.mock('./WorktreeContextMenu', () => ({
  default: ({ children }: { children: ReactNode }) => <>{children}</>,
  CLOSE_ALL_CONTEXT_MENUS_EVENT: 'orca:test-close-context-menus',
  WORKTREE_NATIVE_CONTEXT_MENU_ATTR: 'data-worktree-native-context-menu',
  WORKTREE_CONTEXT_MENU_SCOPE_ATTR: 'data-orca-context-menu-scope'
}))

function makeRepo(): Repo {
  return {
    id: 'repo-1',
    path: '/repo',
    displayName: 'orca',
    badgeColor: '#999999',
    addedAt: 1
  }
}

function makeWorktree(overrides: Partial<Worktree> = {}): Worktree {
  return {
    id: 'repo-1::/repo/worktrees/pr-456',
    repoId: 'repo-1',
    path: '/repo/worktrees/pr-456',
    displayName: 'Fix stale GH PR',
    branch: 'feature/local-branch',
    head: 'abc123',
    isBare: false,
    isMainWorktree: false,
    comment: '',
    linkedIssue: null,
    linkedPR: 456,
    linkedLinearIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 1,
    ...overrides
  }
}

function makeHostedReview(overrides: Partial<HostedReviewInfo> = {}): HostedReviewInfo {
  return {
    provider: 'github',
    number: 456,
    title: 'Fix stale GH PR',
    state: 'open',
    url: 'https://github.com/acme/orca/pull/456',
    status: 'success',
    updatedAt: '2026-05-17T00:00:00.000Z',
    mergeable: 'MERGEABLE',
    ...overrides
  }
}

describe('WorktreeCard merge readiness marker', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    worktreeCardProperties = ['status', 'pr']
    hostedReviewCache = {
      'local::repo-1::feature/local-branch': {
        data: makeHostedReview({ mergeStateStatus: 'BLOCKED' }),
        fetchedAt: Date.now()
      }
    }
    settings = null
  })

  // Why both styles: the review glyph moves between the experimental status lane and the
  // metadata row the default card uses, and the marker is only honest if it follows the glyph.
  it('marks the card review glyph blocked in either card style', async () => {
    const { default: WorktreeCard } = await import('./WorktreeCard')
    const renderCard = (nextSettings: Partial<GlobalSettings>): string => {
      settings = nextSettings
      return renderToStaticMarkup(
        <WorktreeCard worktree={makeWorktree()} repo={makeRepo()} isActive={false} />
      )
    }

    const defaultStyleMarkup = renderCard({ experimentalNewWorktreeCardStyle: false })
    const newStyleMarkup = renderCard({ experimentalNewWorktreeCardStyle: true })

    expect(defaultStyleMarkup).toContain('data-review-merge-marker="blocked"')
    expect(newStyleMarkup).toContain('data-review-merge-marker="blocked"')
  }, 20_000)

  // Why: green checks are not a mergeable PR, which is the whole reason the marker exists.
  it('keeps green checks but drops the marker once the merge box is open', async () => {
    settings = { experimentalNewWorktreeCardStyle: false }
    hostedReviewCache = {
      'local::repo-1::feature/local-branch': {
        data: makeHostedReview({ mergeStateStatus: 'CLEAN' }),
        fetchedAt: Date.now()
      }
    }
    const { default: WorktreeCard } = await import('./WorktreeCard')

    const markup = renderToStaticMarkup(
      <WorktreeCard worktree={makeWorktree()} repo={makeRepo()} isActive={false} />
    )

    expect(markup).toContain('text-emerald-500/80')
    expect(markup).not.toContain('data-review-merge-marker')
    expect(markup).toContain('Linked PR #456 · Ready to merge')
  }, 20_000)
})
