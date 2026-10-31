import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getDefaultWorkspaceSession } from '../../shared/constants'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import type { HostWorktreeTarget } from '../../shared/worktree/host-qualified-identity'
import type { WorktreeMeta } from '../../shared/worktree/meta-types'
import type { TerminalTab } from '../../shared/terminal-tab-types'
import {
  reconcileWorktreeCaseSplits,
  resetWorktreeCaseSplitRefusalsForTests,
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
      // Production drops the removed id's session state, which is why the move is all-or-nothing.
      const dropped: WorkspaceSessionState = {
        ...currentSession,
        tabsByWorktree: Object.fromEntries(
          Object.entries(currentSession.tabsByWorktree).filter(([key]) => key !== target.id)
        ),
        activeWorktreeId:
          currentSession.activeWorktreeId === target.id ? null : currentSession.activeWorktreeId
      }
      currentSession = dropped
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
  beforeEach(() => resetWorktreeCaseSplitRefusalsForTests())

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

  it('keeps the twin record when the survivor already owns its own tab set', async () => {
    const session: WorkspaceSessionState = {
      ...getDefaultWorkspaceSession(),
      activeWorktreeId: SIBLING,
      tabsByWorktree: {
        [SURVIVOR]: [tab('survivor-tab', SURVIVOR)],
        [SIBLING]: [tab('sibling-tab', SIBLING)]
      }
    }
    const harness = createHarness({ [SURVIVOR]: listedRecord, [SIBLING]: createRecord }, session)
    const log = vi.fn()
    const notify = vi.fn()

    await reconcileWorktreeCaseSplits(harness.input(), {
      store: harness.store,
      statIdentity: sharedInode,
      log,
      notifyWorktreeRenamed: notify
    })

    const next = harness.session()
    // Why: the removal drops the twin's session state, so a partial move would delete its tabs.
    expect(next.tabsByWorktree[SURVIVOR]).toEqual([tab('survivor-tab', SURVIVOR)])
    expect(next.tabsByWorktree[SIBLING]).toEqual([tab('sibling-tab', SIBLING)])
    expect(harness.store.removeWorktreeMeta).not.toHaveBeenCalled()
    expect(notify).not.toHaveBeenCalled()
    expect(log).toHaveBeenCalledWith(expect.stringContaining('kept the twin record'))
    // The metadata still lands, which is what the visible row shows.
    expect(harness.store.setWorktreeMeta).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        displayName: 'Fork CI health: attention',
        displayNameIsPinned: true
      })
    )
  })

  it('moves a twin-owned session to the survivor, notifies, then removes the twin', async () => {
    const session: WorkspaceSessionState = {
      ...getDefaultWorkspaceSession(),
      activeWorktreeId: SIBLING,
      tabsByWorktree: { [SIBLING]: [tab('sibling-tab', SIBLING)] },
      activeTabIdByWorktree: { [SIBLING]: 'sibling-tab' }
    }
    const harness = createHarness({ [SURVIVOR]: listedRecord, [SIBLING]: createRecord }, session)
    const notify = vi.fn()

    await reconcileWorktreeCaseSplits(harness.input(), {
      store: harness.store,
      statIdentity: sharedInode,
      notifyWorktreeRenamed: notify
    })

    const next = harness.session()
    expect(next.tabsByWorktree[SURVIVOR]).toEqual([tab('sibling-tab', SURVIVOR)])
    expect(next.tabsByWorktree[SIBLING]).toBeUndefined()
    expect(next.activeWorktreeId).toBe(SURVIVOR)
    expect(notify).toHaveBeenCalledWith(REPO, SIBLING, SURVIVOR)
    expect(harness.store.removeWorktreeMeta).toHaveBeenCalledWith(
      expect.objectContaining({ id: SIBLING })
    )
  })

  it('keeps the twin when there is no way to re-key the renderer', async () => {
    const session: WorkspaceSessionState = {
      ...getDefaultWorkspaceSession(),
      tabsByWorktree: { [SIBLING]: [tab('sibling-tab', SIBLING)] }
    }
    const harness = createHarness({ [SURVIVOR]: listedRecord, [SIBLING]: createRecord }, session)
    const log = vi.fn()

    await reconcileWorktreeCaseSplits(harness.input(), {
      store: harness.store,
      statIdentity: sharedInode,
      log
    })

    expect(harness.session().tabsByWorktree[SIBLING]).toHaveLength(1)
    expect(harness.store.removeWorktreeMeta).not.toHaveBeenCalled()
    expect(log).toHaveBeenCalledWith(expect.stringContaining('no renderer notification'))
  })

  it('stops re-statting a pair it can never prove', async () => {
    const harness = createHarness({ [SURVIVOR]: listedRecord, [SIBLING]: createRecord })
    const statIdentity = vi.fn(async (path: string) => ({
      dev: 1n,
      ino: path === SURVIVOR_PATH ? 1n : 2n
    }))
    const deps = { store: harness.store, statIdentity }

    await reconcileWorktreeCaseSplits(harness.input(), deps)
    await reconcileWorktreeCaseSplits(harness.input(), deps)

    expect(statIdentity).toHaveBeenCalledTimes(2)
    expect(harness.store.removeWorktreeMeta).not.toHaveBeenCalled()
  })
})
