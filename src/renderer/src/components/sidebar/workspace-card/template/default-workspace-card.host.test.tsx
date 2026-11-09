// @vitest-environment happy-dom

/**
 * The live card is drawn by `default-workspace-card.json`, not by the legacy header, so a host
 * affordance that exists only in `surface/worktree-card-header.tsx` never reaches the user: the
 * card silently loses it. These assertions read the surface that actually renders.
 */
import React, { type ReactNode } from 'react'

import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { Repo } from '../../../../../../shared/repo-types'
import type { Worktree } from '../../../../../../shared/worktree/types'
import { DEFAULT_WORKTREE_CARD_PROPERTIES } from '../../../../../../shared/worktree/card-properties'
import type { BranchGroupMember } from '../../../../../../shared/sidebar-list/row-types'
import type { ExecutionHostId } from '../../../../../../shared/execution-host'
import WorktreeCard from '../surface/WorktreeCard'

type Mocks = {
  state: Record<string, unknown>
  cacheStartedAt: number | null
  deleteModifier: boolean
}
const mocks = vi.hoisted((): Mocks => ({ state: {}, cacheStartedAt: null, deleteModifier: false }))

vi.mock('@/store', () => {
  const getState = () => mocks.state
  return {
    useAppStore: Object.assign((selector: (state: unknown) => unknown) => selector(getState()), {
      getState
    })
  }
})
vi.mock('@/components/ui/hover-card', () => ({
  HoverCard: ({ children }: { children: ReactNode }) => <div data-hover-card="">{children}</div>,
  HoverCardContent: ({ children }: { children: ReactNode }) => (
    <div data-hover-card-content="">{children}</div>
  ),
  HoverCardTrigger: ({ children }: { children: ReactNode }) => <>{children}</>
}))
vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: ReactNode }) => (
    <span data-tooltip="">{children}</span>
  ),
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>
}))
vi.mock('../activity/use-worktree-activity-status', () => ({
  useWorktreeActivityStatus: () => 'active'
}))
vi.mock('../../workspace-actions/sleep/use-worktree-sleep-state', () => ({
  useIsSleepingWorktree: () => false
}))
vi.mock('../activity/CacheTimer', () => ({
  default: () => null,
  usePromptCacheCountdownStartedAt: () => mocks.cacheStartedAt
}))
vi.mock('../activity/WorktreeCardAgents', () => ({
  default: () => <div data-worktree-agents="" />
}))
vi.mock('../identity/WorktreeLineageToggle', () => ({
  WorktreeLineageToggle: () => null
}))
vi.mock(
  '../../workspace-actions/deletion/workspace-delete-quick-action',
  async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    useWorkspaceDeleteModifierPressed: () => mocks.deleteModifier
  })
)
// Why: the card's host affordances are the subject; the context menu is not, and it needs the whole store.
vi.mock('../../workspace-actions/context-menu/WorktreeContextMenu', () => ({
  default: ({ children }: { children: ReactNode }) => <>{children}</>
}))

const LOCAL: ExecutionHostId = 'local'
const REMOTE: ExecutionHostId = 'ssh:gpu-vm'
const GROUP_KEY = 'project:p1\u0000feature/host-picker'

const repo: Repo = {
  id: 'repo-1',
  path: '/repo',
  displayName: 'orca',
  badgeColor: '#999999',
  addedAt: 1
}

function makeWorktree(overrides: Partial<Worktree> = {}): Worktree {
  return {
    id: 'repo-1::/repo/worktrees/feature',
    repoId: 'repo-1',
    path: '/repo/worktrees/feature',
    displayName: 'Host picker',
    branch: 'refs/heads/feature/host-picker',
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

const members: BranchGroupMember[] = [
  { worktree: makeWorktree(), repo, hostId: LOCAL, hostLabel: 'Local Mac' },
  {
    worktree: makeWorktree({ id: 'repo-1::/home/alice/feature', hostId: REMOTE }),
    repo,
    hostId: REMOTE,
    hostLabel: 'GPU VM'
  }
]

function stateFor(): Record<string, unknown> {
  return {
    agentActivityDisplayMode: 'full',
    deleteStateByWorktreeId: {},
    gitConflictOperationByWorktree: {},
    hostedReviewCache: {},
    issueCache: {},
    linearIssueCache: {},
    prCache: {},
    repos: [repo],
    projectGroups: [],
    remoteBranchConflictByWorktreeId: {},
    runtimeEnvironments: [],
    settings: { compactWorktreeCards: false },
    sshConnectionStates: new Map(),
    removedSshTargetLabels: new Map(),
    runtimeStatusByEnvironmentId: new Map(),
    sshTargetLabels: new Map(),
    tabsByWorktree: {},
    agentStatusByPaneKey: {},
    retainedAgentsByPaneKey: {},
    workspacePortScan: null,
    worktreeCardProperties: [...DEFAULT_WORKTREE_CARD_PROPERTIES]
  }
}

function renderCard(overrides: Partial<React.ComponentProps<typeof WorktreeCard>> = {}): {
  container: HTMLElement
} {
  const { container } = render(
    <WorktreeCard worktree={makeWorktree()} repo={repo} isActive={false} {...overrides} />
  )
  return { container }
}

function hostSelectLabel(container: HTMLElement): string | null {
  return container.querySelector('[data-branch-host-select]')?.textContent ?? null
}

beforeEach(() => {
  mocks.state = stateFor()
  mocks.cacheStartedAt = null
  mocks.deleteModifier = false
})
afterEach(cleanup)

describe('the live workspace card and its host', () => {
  it('names the host a same-branch card stands in for', () => {
    // A merged row carries no host context label of its own: the card names its host here instead.
    const { container } = renderCard({
      branchGroup: members,
      selectedBranchHostId: REMOTE,
      branchGroupKey: GROUP_KEY
    })

    expect(container.querySelector('[data-branch-host-select]')).not.toBeNull()
    expect(hostSelectLabel(container)).toContain('GPU VM')
  })

  it('offers every host the branch is checked out on', () => {
    const onSelectBranchHost = vi.fn()
    const { container } = renderCard({
      branchGroup: members,
      selectedBranchHostId: LOCAL,
      branchGroupKey: GROUP_KEY,
      onSelectBranchHost
    })

    act(() => {
      container
        .querySelector('[data-branch-host-select]')
        ?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }))
    })

    // Radix portals the menu into the body, outside the card's container.
    const options = [...document.body.querySelectorAll('[role="menuitemradio"]')]
    expect(options.map((option) => option.textContent)).toEqual(['Local Mac', 'GPU VM'])

    act(() => {
      options[1]?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(onSelectBranchHost).toHaveBeenCalledWith(GROUP_KEY, REMOTE)
  })

  it('leaves a single-host card without a host switcher', () => {
    const { container } = renderCard()

    expect(container.querySelector('[data-branch-host-select]')).toBeNull()
  })

  it('still labels a cross-host card that is not a same-branch merge', () => {
    const { container } = renderCard({ hostContextLabel: 'GPU VM' })

    expect(container.textContent).toContain('GPU VM')
  })
})
