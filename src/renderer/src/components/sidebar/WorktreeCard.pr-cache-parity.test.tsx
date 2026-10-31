import { renderToStaticMarkup } from 'react-dom/server'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { HostedReviewInfo } from '../../../../shared/hosted-review'
import type { PRInfo } from '../../../../shared/github/pull-request-types'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type { Repo } from '../../../../shared/repo-types'
import type { WorktreeCardProperty } from '../../../../shared/ui-chrome-types'
import type { Worktree } from '../../../../shared/worktree/types'

const fetchHostedReviewForBranch = vi.fn()
const fetchIssue = vi.fn()
const fetchLinearIssue = vi.fn()
const openModal = vi.fn()
const updateWorktreeMeta = vi.fn()

let worktreeCardProperties: WorktreeCardProperty[] = ['pr']
let hostedReviewCache: Record<string, unknown> = {}
let prCache: Record<string, unknown> = {}
let settings: Partial<GlobalSettings> | null = null

vi.mock('@/store', () => {
  const getState = () => ({
    deleteStateByWorktreeId: {},
    fetchHostedReviewForBranch,
    fetchIssue,
    fetchLinearIssue,
    gitConflictOperationByWorktree: {},
    hostedReviewCache,
    issueCache: {},
    linearIssueCache: {},
    openModal,
    prCache,
    projectGroups: [],
    remoteBranchConflictByWorktreeId: {},
    settings,
    sshConnectionStates: new Map(),
    sshTargetLabels: new Map(),
    updateWorktreeMeta,
    workspacePortScan: null,
    worktreeCardProperties
  })
  return {
    useAppStore: Object.assign((selector: (state: unknown) => unknown) => selector(getState()), {
      getState,
      subscribe: () => () => {}
    })
  }
})

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
    displayName: 'Workspace',
    branch: 'feature/local-branch',
    head: 'abc123',
    isBare: false,
    isMainWorktree: false,
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 1,
    ...overrides
  }
}

function makePRInfo(overrides: Partial<PRInfo> = {}): PRInfo {
  return {
    number: 6340,
    title: 'Fresh merged PR title',
    state: 'merged',
    url: 'https://github.com/acme/orca/pull/6340',
    checksStatus: 'success',
    updatedAt: '2026-05-17T00:00:00.000Z',
    mergeable: 'MERGEABLE',
    headSha: 'abc123',
    ...overrides
  }
}

function makeHostedReviewInfo(overrides: Partial<HostedReviewInfo> = {}): HostedReviewInfo {
  return {
    provider: 'github',
    number: 6340,
    title: 'Stale open review title',
    state: 'open',
    url: 'https://github.com/acme/orca/pull/6340',
    status: 'pending',
    updatedAt: '2026-05-16T00:00:00.000Z',
    mergeable: 'MERGEABLE',
    headSha: 'abc123',
    ...overrides
  }
}

const HOSTED_KEY = 'local::repo-1::feature/local-branch'
const PR_KEY = 'repo-1::feature/local-branch'

const MERGED_TONE = 'text-purple-600/70'
const OPEN_CHECKS_PENDING_TONE = 'text-amber-500/85'
const OPEN_CHECKS_PASSING_TONE = 'text-emerald-500/80'

/** The card's PR glyph carries the state in its icon and tone, not in text. */
function reviewGlyphTone(markup: string): string | null {
  for (const tone of [MERGED_TONE, OPEN_CHECKS_PENDING_TONE, OPEN_CHECKS_PASSING_TONE]) {
    if (markup.includes(tone)) {
      return tone
    }
  }
  return null
}

describe('WorktreeCard review state follows the Checks pane source', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    settings = { compactWorktreeCards: false, experimentalNewWorktreeCardStyle: false }
    worktreeCardProperties = ['pr']
    hostedReviewCache = {}
    prCache = {}
  })

  it('shows the merged PR when the hosted-review cache still says open', async () => {
    // The Checks pane renders the GitHub PR cache for GitHub branches, so a hosted-review entry
    // that still says `open` must not win over the merged PR the pane already shows.
    hostedReviewCache = {
      [HOSTED_KEY]: { data: makeHostedReviewInfo(), fetchedAt: 900 }
    }
    prCache = {
      [PR_KEY]: { data: makePRInfo(), fetchedAt: 100 }
    }
    const { default: WorktreeCard } = await import('./WorktreeCard')

    const markup = renderToStaticMarkup(
      <WorktreeCard worktree={makeWorktree()} repo={makeRepo()} isActive={false} />
    )

    expect(reviewGlyphTone(markup)).toBe(MERGED_TONE)
    expect(markup).toContain('Linked PR #6340')
  })

  it('shows the merged PR when the hosted-review cache has no review for the branch', async () => {
    hostedReviewCache = { [HOSTED_KEY]: { data: null, fetchedAt: 900 } }
    prCache = { [PR_KEY]: { data: makePRInfo(), fetchedAt: 100 } }
    const { default: WorktreeCard } = await import('./WorktreeCard')

    const markup = renderToStaticMarkup(
      <WorktreeCard worktree={makeWorktree()} repo={makeRepo()} isActive={false} />
    )

    expect(reviewGlyphTone(markup)).toBe(MERGED_TONE)
  })

  it('still shows open while both caches agree the review is open', async () => {
    hostedReviewCache = {
      [HOSTED_KEY]: { data: makeHostedReviewInfo(), fetchedAt: 100 }
    }
    prCache = {
      [PR_KEY]: {
        data: makePRInfo({
          state: 'open',
          checksStatus: 'pending',
          url: 'https://github.com/acme/orca/pull/6340'
        }),
        fetchedAt: 900
      }
    }
    const { default: WorktreeCard } = await import('./WorktreeCard')

    const markup = renderToStaticMarkup(
      <WorktreeCard worktree={makeWorktree()} repo={makeRepo()} isActive={false} />
    )

    expect(reviewGlyphTone(markup)).toBe(OPEN_CHECKS_PENDING_TONE)
  })

  it('drops a merged review the worktree head moved past, in both caches', async () => {
    hostedReviewCache = {
      [HOSTED_KEY]: {
        data: makeHostedReviewInfo({ state: 'merged', headSha: 'old-head' }),
        fetchedAt: 900,
        linkedReviewHintKey: 'github:6340',
        branchLookupGitHubPRNumber: 6340
      }
    }
    prCache = {
      [PR_KEY]: { data: makePRInfo({ headSha: 'old-head' }), fetchedAt: 100 }
    }
    const { default: WorktreeCard } = await import('./WorktreeCard')

    const markup = renderToStaticMarkup(
      <WorktreeCard
        worktree={makeWorktree({ head: 'new-head' })}
        repo={makeRepo()}
        isActive={false}
      />
    )

    expect(markup).not.toContain('Linked PR #6340')
    expect(reviewGlyphTone(markup)).toBe(null)
  })
})
