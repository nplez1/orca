import { describe, expect, it, vi } from 'vitest'
import { getDefaultWorkspaceSession } from '../../shared/constants'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import type { HostWorktreeTarget } from '../../shared/worktree/host-qualified-identity'
import type { WorktreeMeta } from '../../shared/worktree/meta-types'
import type { TerminalTab } from '../../shared/terminal-tab-types'
import {
  reconcileWorktreeCaseSplits,
  type FileIdentity,
  type WorktreeCaseSplitInput
} from './worktree-case-split-reconciliation'

const REPO = 'repo-1'
const SURVIVOR_PATH = '/x/Orca/w'
const SIBLING_PATH = '/x/orca/w'
const SURVIVOR = `${REPO}::${SURVIVOR_PATH}`
const SIBLING = `${REPO}::${SIBLING_PATH}`
const BRANCH = 'refs/heads/nplez1/fork-ci-health-attention'

function meta(overrides: Partial<WorktreeMeta>): WorktreeMeta {
  return {
    displayName: '',
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0,
    ...overrides
  }
}

function tab(id: string, worktreeId: string): TerminalTab {
  return {
    id,
    ptyId: null,
    worktreeId,
    title: id,
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 1
  }
}

const sharedInode = async (): Promise<FileIdentity> => ({ dev: 1n, ino: 42n })

function createHarness(initial: Record<string, WorktreeMeta>, session?: WorkspaceSessionState) {
  const metaById: Record<string, WorktreeMeta> = structuredClone(initial)
  let currentSession = session ?? getDefaultWorkspaceSession()
  const store = {
    setWorktreeMeta: vi.fn((target: HostWorktreeTarget, updates: Partial<WorktreeMeta>) => {
      metaById[target.id] = { ...metaById[target.id], ...updates }
      return metaById[target.id]
    }),
    removeWorktreeMeta: vi.fn((target: HostWorktreeTarget) => {
      delete metaById[target.id]
    }),
    getWorkspaceSession: () => currentSession,
    setWorkspaceSession: vi.fn((next: WorkspaceSessionState) => {
      currentSession = next
    })
  }
  const input = (listed = [{ path: SURVIVOR_PATH, branch: BRANCH }]): WorktreeCaseSplitInput => ({
    repoId: REPO,
    hostId: 'local',
    listed,
    metaById
  })
  return { store, metaById, input, session: () => currentSession }
}

const createRecord = meta({
  displayName: 'Fork CI health: attention',
  linkedItems: [{ provider: 'github', type: 'issue', number: 7 }],
  linkedIssue: 7,
  createdWithAgent: 'claude',
  createdAt: 100,
  orcaCreatedAt: 100,
  orcaCreationSource: 'desktop',
  baseRef: 'origin/main',
  branchNameWasGenerated: true
})

const listedRecord = meta({
  instanceId: 'survivor-instance',
  displayName: 'fork-ci-health-attention',
  displayNameIsPinned: true,
  sortOrder: 5,
  lastActivityAt: 900,
  isUnread: true,
  workspaceStatus: 'in-progress',
  pendingFirstAgentMessageRename: false,
  firstAgentMessageRenameError: null
})

describe('reconcileWorktreeCaseSplits', () => {
  it('merges a split pair into the listed id, keeping the create fields and links', async () => {
    const harness = createHarness({ [SURVIVOR]: listedRecord, [SIBLING]: createRecord })
    const log = vi.fn()

    const merged = await reconcileWorktreeCaseSplits(harness.input(), {
      store: harness.store,
      statIdentity: sharedInode,
      log
    })

    expect(merged).toEqual([SIBLING])
    expect(harness.metaById[SIBLING]).toBeUndefined()
    expect(harness.metaById[SURVIVOR]).toMatchObject({
      instanceId: 'survivor-instance',
      displayName: 'Fork CI health: attention',
      displayNameIsPinned: true,
      linkedItems: [{ provider: 'github', type: 'issue', number: 7 }],
      linkedIssue: 7,
      createdWithAgent: 'claude',
      createdAt: 100,
      orcaCreationSource: 'desktop',
      baseRef: 'origin/main',
      branchNameWasGenerated: true,
      sortOrder: 5,
      lastActivityAt: 900,
      isUnread: true,
      workspaceStatus: 'in-progress',
      priorWorktreeIds: [SIBLING]
    })
    expect(log).toHaveBeenCalledWith(expect.stringContaining(`merged ${SIBLING} into ${SURVIVOR}`))
  })

  it('keeps a survivor display name that is not the branch slug', async () => {
    const harness = createHarness({
      [SURVIVOR]: { ...listedRecord, displayName: 'Renamed by user' },
      [SIBLING]: createRecord
    })

    await reconcileWorktreeCaseSplits(harness.input(), {
      store: harness.store,
      statIdentity: sharedInode,
      log: vi.fn()
    })

    expect(harness.metaById[SURVIVOR].displayName).toBe('Renamed by user')
    expect(harness.metaById[SURVIVOR].linkedIssue).toBe(7)
  })

  it('refuses when the two spellings are different directories', async () => {
    const harness = createHarness({ [SURVIVOR]: listedRecord, [SIBLING]: createRecord })
    const statIdentity = async (path: string): Promise<FileIdentity> => ({
      dev: 1n,
      ino: path === SURVIVOR_PATH ? 42n : 43n
    })

    const merged = await reconcileWorktreeCaseSplits(harness.input(), {
      store: harness.store,
      statIdentity,
      log: vi.fn()
    })

    expect(merged).toEqual([])
    expect(harness.store.setWorktreeMeta).not.toHaveBeenCalled()
    expect(harness.store.removeWorktreeMeta).not.toHaveBeenCalled()
  })

  it('refuses when git lists both spellings, without touching the filesystem', async () => {
    const harness = createHarness({ [SURVIVOR]: listedRecord, [SIBLING]: createRecord })
    const statIdentity = vi.fn(sharedInode)

    const merged = await reconcileWorktreeCaseSplits(
      harness.input([
        { path: SURVIVOR_PATH, branch: BRANCH },
        { path: SIBLING_PATH, branch: BRANCH }
      ]),
      { store: harness.store, statIdentity, log: vi.fn() }
    )

    expect(merged).toEqual([])
    expect(statIdentity).not.toHaveBeenCalled()
    expect(harness.metaById[SIBLING]).toBeDefined()
  })

  it('finds nothing to merge on a second pass', async () => {
    const harness = createHarness({ [SURVIVOR]: listedRecord, [SIBLING]: createRecord })
    const statIdentity = vi.fn(sharedInode)
    const deps = { store: harness.store, statIdentity, log: vi.fn() }

    await reconcileWorktreeCaseSplits(harness.input(), deps)
    statIdentity.mockClear()
    harness.store.setWorktreeMeta.mockClear()
    const second = await reconcileWorktreeCaseSplits(harness.input(), deps)

    expect(second).toEqual([])
    expect(statIdentity).not.toHaveBeenCalled()
    expect(harness.store.setWorktreeMeta).not.toHaveBeenCalled()
  })

  it('moves the twin tabs only where the survivor has none of its own', async () => {
    const session: WorkspaceSessionState = {
      ...getDefaultWorkspaceSession(),
      activeWorktreeId: SIBLING,
      tabsByWorktree: {
        [SURVIVOR]: [tab('survivor-tab', SURVIVOR)],
        [SIBLING]: [tab('sibling-tab', SIBLING)]
      },
      activeTabIdByWorktree: { [SIBLING]: 'sibling-tab' }
    }
    const harness = createHarness({ [SURVIVOR]: listedRecord, [SIBLING]: createRecord }, session)
    const log = vi.fn()

    await reconcileWorktreeCaseSplits(harness.input(), {
      store: harness.store,
      statIdentity: sharedInode,
      log
    })

    const next = harness.session()
    expect(next.tabsByWorktree[SURVIVOR]).toEqual([tab('survivor-tab', SURVIVOR)])
    expect(next.tabsByWorktree[SIBLING]).toEqual([tab('sibling-tab', SIBLING)])
    expect(next.activeTabIdByWorktree).toEqual({ [SURVIVOR]: 'sibling-tab' })
    expect(next.activeWorktreeId).toBe(SURVIVOR)
    expect(log).toHaveBeenCalledWith(expect.stringContaining('already owns tabsByWorktree'))
  })
})
