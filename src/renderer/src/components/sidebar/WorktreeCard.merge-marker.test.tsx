import type * as StoreModule from '@/store'
import { renderToStaticMarkup } from 'react-dom/server'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { HostedReviewInfo } from '../../../../shared/source-control/hosted-review/hosted-review-contracts'
import type { GlobalSettings } from '../../../../shared/settings/global-settings-types'
import type { Repo } from '../../../../shared/repository/repo-types'
import type { WorktreeCardProperty } from '../../../../shared/ui-chrome/ui-chrome-types'
import type { Worktree } from '../../../../shared/worktree/types'
import WorktreeCard from './workspace-card/surface/WorktreeCard'

let worktreeCardProperties: WorktreeCardProperty[] = ['status', 'pr']
let hostedReviewCache: Record<string, unknown> = {}
let settings: Partial<GlobalSettings> | null = null

// Why the card is imported statically: its module graph is this file's whole cost (17.5s cold on the
// nightly runner, milliseconds of render), and inside a test body that cost is charged to that test's
// timeout — which is how run 45942815750 reddened, then resumed mid-way through the next test.

vi.mock('@/store', async () => {
  const { useAppStore: realStore } = await vi.importActual<typeof StoreModule>('@/store')
  // Why the real initial state: the card reads whatever the store carries, and a hand-kept
  // subset goes stale silently. Only the fields each test mutates are overridden here.
  // Why buildState stays lazy: the card's static import loads before the `let`s above initialise.
  const buildState = () => ({
    ...realStore.getInitialState(),
    fetchHostedReviewForBranch: vi.fn(),
    fetchIssue: vi.fn(),
    fetchLinearIssue: vi.fn(),
    hostedReviewCache,
    openModal: vi.fn(),
    settings,
    updateWorktreeMeta: vi.fn(),
    worktreeCardProperties
  })
  return {
    // Why the full store surface: the card's agent rows read the view through `useStore`.
    useAppStore: Object.assign((selector: (state: unknown) => unknown) => selector(buildState()), {
      getInitialState: buildState,
      getState: buildState,
      subscribe: () => () => {}
    })
  }
})

vi.mock('@/lib/workspace/activation/worktree-activation.ts', () => ({
  activateAndRevealWorktree: vi.fn()
}))

vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>
}))

vi.mock('./workspace-card/activity/use-worktree-activity-status.ts', () => ({
  useWorktreeActivityStatus: () => 'active'
}))

vi.mock('./workspace-actions/sleep/use-worktree-sleep-state.ts', () => ({
  useIsSleepingWorktree: () => false,
  // The status slot reads the selector through one shallow subscription, not the hook.
  selectIsSleepingWorktree: () => false
}))

vi.mock('./workspace-card/activity/CacheTimer.tsx', () => ({
  default: () => null,
  usePromptCacheCountdownStartedAt: () => null
}))

vi.mock('./workspace-card/activity/WorktreeCardAgents.tsx', () => ({
  default: () => null
}))

vi.mock('./workspace-actions/context-menu/WorktreeContextMenu.tsx', () => ({
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
  it('marks the card review glyph blocked in either card style', () => {
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
  })

  // Why: green checks are not a mergeable PR, which is the whole reason the marker exists.
  it('keeps green checks but drops the marker once the merge box is open', () => {
    settings = { experimentalNewWorktreeCardStyle: false }
    hostedReviewCache = {
      'local::repo-1::feature/local-branch': {
        data: makeHostedReview({ mergeStateStatus: 'CLEAN' }),
        fetchedAt: Date.now()
      }
    }

    const markup = renderToStaticMarkup(
      <WorktreeCard worktree={makeWorktree()} repo={makeRepo()} isActive={false} />
    )

    expect(markup).toContain('text-emerald-500/80')
    expect(markup).not.toContain('data-review-merge-marker')
    expect(markup).toContain('Linked PR #456 · Ready to merge')
  })
})
