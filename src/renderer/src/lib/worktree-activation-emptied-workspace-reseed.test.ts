import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import {
  activateAndRevealFolderWorkspace,
  activateAndRevealWorkspace,
  activateAndRevealWorktree
} from './worktree-activation'
import * as activationGate from './worktree-agent-activation-gate'
import { ensureWorktreeHasInitialTerminal } from './worktree-initial-terminal-seeding'
import { folderWorkspaceKey } from '../../../shared/workspace-scope'
import { toSshExecutionHostId } from '../../../shared/execution-host'
import {
  makeCreatedAgentWorktree as makeWorktree,
  seedEmptyActivatableWorktree
} from '@/lib/worktree-activation-created-agent.test-fixture'
import { makeTerminalTab } from '@/components/worktree-jump-palette-test-fixtures'
import { waitForWorktreeAgentActivationGateForTests } from './worktree-agent-activation-gate'

// Main's answer to the window's layout commands, as a switch-on build sends them.
vi.mock('@/runtime/runtime-rpc-client', async (importOriginal) =>
  (
    await import('@/runtime/layout-apply-test-transport.test-fixture')
  ).runtimeRpcClientWithLayoutApply(await importOriginal())
)

const initialAppStoreState = useAppStore.getState()
// Why: tombstones only count within a TTL of the clock, so the fixtures' closedAt is pinned to it.
const NOW = 1_800_000_000_000

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  useAppStore.setState(initialAppStoreState, true)
})

/** The state a workspace lands in once its last terminal is closed: the row survives as an
 *  explicit empty list rather than disappearing, beside the close's record. */
function seedClosedLastTerminal(worktreeId: string): void {
  useAppStore.setState({
    tabsByWorktree: { [worktreeId]: [] },
    closedTerminalTabTombstonesByTabId: { closed: { closedAt: Date.now(), worktreeId } }
  })
  const { renderableTabCount } = useAppStore.getState().reconcileWorktreeTabModel(worktreeId)
  expect(renderableTabCount).toBe(0)
}

describe('activating a workspace whose last terminal was closed', () => {
  it.each([
    ['Blank Terminal', null, 1],
    ['an agent', 'codex' as const, 0]
  ])('seeds a default shell for %s selection only', (_label, agent, expectedTabCount) => {
    const worktree = makeWorktree()
    seedEmptyActivatableWorktree(worktree)

    const result = activateAndRevealWorktree(worktree.id, {
      agent,
      notifyHostRuntime: false
    })

    expect(result).not.toBe(false)
    expect(result === false ? null : result.primaryTabId === null).toBe(expectedTabCount === 0)
    expect(useAppStore.getState().tabsByWorktree[worktree.id] ?? []).toHaveLength(expectedTabCount)
  })

  // Why: a gate that reports the workspace empty no longer seeds it. The tombstone says the user
  // emptied this workspace, so the answer is the empty-tabs surface, not the shell they closed (#96).
  it.each([true, false])(
    'leaves a gate-reported empty workspace empty when providesInitialSurface=%s',
    async (providesInitialSurface) => {
      const worktree = makeWorktree()
      seedEmptyActivatableWorktree(worktree)
      seedClosedLastTerminal(worktree.id)
      useAppStore.setState({
        sleepingAgentSessionsByPaneKey: {
          'pane-1': { worktreeId: worktree.id }
        } as never
      })
      const gate = vi.spyOn(activationGate, 'gateWorktreeAgentActivation')
      gate.mockResolvedValue('empty')

      activateAndRevealWorktree(worktree.id, {
        providesInitialSurface,
        notifyHostRuntime: false
      })
      await gate.mock.results[0]?.value

      expect(useAppStore.getState().tabsByWorktree[worktree.id]).toEqual([])
    }
  )

  // An empty gate invalidates agent-based suppression; the tombstone survives either way.
  it.each([
    ['an agent selection', { agent: 'codex' as const }],
    [
      'an agent selection whose caller promised its own surface',
      { agent: 'codex' as const, providesInitialSurface: true }
    ]
  ])('leaves a gate-reported empty workspace empty for %s', async (_label, selection) => {
    const worktree = makeWorktree()
    seedEmptyActivatableWorktree(worktree)
    seedClosedLastTerminal(worktree.id)
    useAppStore.setState({
      sleepingAgentSessionsByPaneKey: {
        'pane-1': { worktreeId: worktree.id }
      } as never
    })
    const gate = vi.spyOn(activationGate, 'gateWorktreeAgentActivation')
    gate.mockResolvedValue('empty')

    const result = activateAndRevealWorktree(worktree.id, {
      ...selection,
      notifyHostRuntime: false
    })
    await gate.mock.results[0]?.value

    // The gate owns seeding for this activation, so the synchronous call never returns a tab.
    expect(result === false ? null : result.primaryTabId).toBeNull()
    expect(useAppStore.getState().tabsByWorktree[worktree.id]).toEqual([])
  })

  it('lets the latest caller surface supersede an older callback on the shared gate', async () => {
    const worktree = makeWorktree()
    seedEmptyActivatableWorktree(worktree)
    seedClosedLastTerminal(worktree.id)
    useAppStore.setState({
      sleepingAgentSessionsByPaneKey: {
        'pane-1': { worktreeId: worktree.id }
      } as never
    })
    let resolveGate!: (outcome: activationGate.WorktreeAgentActivationOutcome) => void
    const pendingGate = new Promise<activationGate.WorktreeAgentActivationOutcome>((resolve) => {
      resolveGate = resolve
    })
    vi.spyOn(activationGate, 'gateWorktreeAgentActivation').mockReturnValue(pendingGate)

    activateAndRevealWorktree(worktree.id, { agent: 'codex', notifyHostRuntime: false })
    activateAndRevealWorktree(worktree.id, {
      providesInitialSurface: true,
      notifyHostRuntime: false
    })
    resolveGate('empty')
    await pendingGate

    expect(useAppStore.getState().tabsByWorktree[worktree.id]).toEqual([])
  })

  it('does not double-seed when another surface lands before the gate settles', async () => {
    const worktree = makeWorktree()
    seedEmptyActivatableWorktree(worktree)
    seedClosedLastTerminal(worktree.id)
    useAppStore.setState({
      sleepingAgentSessionsByPaneKey: {
        'pane-1': { worktreeId: worktree.id }
      } as never
    })
    let resolveGate!: (outcome: activationGate.WorktreeAgentActivationOutcome) => void
    const pendingGate = new Promise<activationGate.WorktreeAgentActivationOutcome>((resolve) => {
      resolveGate = resolve
    })
    vi.spyOn(activationGate, 'gateWorktreeAgentActivation').mockReturnValue(pendingGate)

    activateAndRevealWorktree(worktree.id, { agent: 'codex', notifyHostRuntime: false })
    // A host-published tab arrives while the gate is still deciding.
    useAppStore.setState((state) => ({
      tabsByWorktree: {
        ...state.tabsByWorktree,
        [worktree.id]: [makeTerminalTab('host-tab', worktree.id, 'published')]
      }
    }))
    resolveGate('empty')
    await pendingGate

    expect(useAppStore.getState().tabsByWorktree[worktree.id]).toHaveLength(1)
    expect(useAppStore.getState().tabsByWorktree[worktree.id]?.[0]?.id).toBe('host-tab')
  })

  it('stays empty when the workspace is opened from elsewhere', () => {
    const worktree = makeWorktree()
    seedEmptyActivatableWorktree(worktree)
    seedClosedLastTerminal(worktree.id)

    const result = activateAndRevealWorktree(worktree.id, { notifyHostRuntime: false })

    expect(result).not.toBe(false)
    expect(result === false ? null : result.primaryTabId).toBeNull()
    expect(useAppStore.getState().tabsByWorktree[worktree.id]).toEqual([])
  })

  // Why: activation now lands an emptied workspace on its empty-tabs surface instead of seeding a
  // shell the user just closed, including when hydration restored it as the active workspace (#96).
  it('stays empty when the restored active workspace is reopened on the same host', () => {
    const worktree = makeWorktree()
    seedEmptyActivatableWorktree(worktree)
    seedClosedLastTerminal(worktree.id)
    useAppStore.setState({
      activeWorktreeId: worktree.id,
      activeWorkspaceExecutionHostId: 'local',
      activeView: 'terminal'
    })

    activateAndRevealWorktree(worktree.id, {
      executionHostId: 'local',
      notifyHostRuntime: false
    })

    expect(useAppStore.getState().tabsByWorktree[worktree.id]).toEqual([])
  })

  // Why: the carve-out is the tombstone, not the caller — an execution host must not change the
  // outcome, and neither must the absence of one.
  it('stays empty whether or not the caller passes an execution host', () => {
    for (const opts of [{}, { executionHostId: 'local' as const }]) {
      const worktree = makeWorktree()
      seedEmptyActivatableWorktree(worktree)
      seedClosedLastTerminal(worktree.id)
      useAppStore.setState({
        activeWorktreeId: worktree.id,
        activeWorkspaceExecutionHostId: 'local',
        activeView: 'terminal'
      })

      activateAndRevealWorktree(worktree.id, { ...opts, notifyHostRuntime: false })

      expect(useAppStore.getState().tabsByWorktree[worktree.id]).toEqual([])
    }
  })

  // File links/check annotations provide editors; shell seeding would add an unrequested terminal and erase the empty tombstone.
  it('leaves the row empty when the caller opens its own surface', () => {
    const worktree = makeWorktree()
    seedEmptyActivatableWorktree(worktree)
    seedClosedLastTerminal(worktree.id)

    const result = activateAndRevealWorktree(worktree.id, {
      providesInitialSurface: true,
      notifyHostRuntime: false
    })

    expect(result).not.toBe(false)
    expect(result === false ? null : result.primaryTabId).toBeNull()
    expect(useAppStore.getState().tabsByWorktree[worktree.id]).toEqual([])
  })

  it('leaves the row empty for startup hydration, which never opts into re-seeding', () => {
    const worktree = makeWorktree()
    seedEmptyActivatableWorktree(worktree)
    seedClosedLastTerminal(worktree.id)

    const tabId = ensureWorktreeHasInitialTerminal(useAppStore.getState(), worktree.id)

    expect(tabId).toBeNull()
    expect(useAppStore.getState().tabsByWorktree[worktree.id]).toEqual([])
  })

  // Renderable browser tabs short-circuit initial-terminal creation; this covers renderableTabCount, not reseed flags.
  it('does not add a terminal to a workspace that still renders a browser tab', () => {
    const worktree = makeWorktree()
    seedEmptyActivatableWorktree(worktree)
    seedClosedLastTerminal(worktree.id)
    useAppStore.setState({
      browserTabsByWorktree: {
        [worktree.id]: [
          {
            id: 'browser-1',
            worktreeId: worktree.id,
            url: 'https://example.com',
            title: 'example',
            sortOrder: 0,
            createdAt: 1
          }
        ]
      },
      unifiedTabsByWorktree: {
        [worktree.id]: [
          {
            id: 'browser-1',
            entityId: 'browser-1',
            groupId: 'group-1',
            worktreeId: worktree.id,
            contentType: 'browser',
            label: 'example',
            customLabel: null,
            color: null,
            sortOrder: 0,
            createdAt: 1
          }
        ]
      },
      groupsByWorktree: {
        [worktree.id]: [
          {
            id: 'group-1',
            worktreeId: worktree.id,
            activeTabId: 'browser-1',
            tabOrder: ['browser-1']
          }
        ]
      },
      activeGroupIdByWorktree: { [worktree.id]: 'group-1' }
    } as unknown as Partial<ReturnType<typeof useAppStore.getState>>)
    expect(
      useAppStore.getState().reconcileWorktreeTabModel(worktree.id).renderableTabCount
    ).toBeGreaterThan(0)

    activateAndRevealWorktree(worktree.id, { notifyHostRuntime: false })

    expect(useAppStore.getState().tabsByWorktree[worktree.id]).toEqual([])
  })
})

const FOLDER_ID = 'folder-1'
const FOLDER_KEY = folderWorkspaceKey(FOLDER_ID)
const SSH_HOST_ID = toSshExecutionHostId('conn-1')

/** One folder id resolves to a different `FolderWorkspace` per host while both share a single
 *  `tabsByWorktree[FOLDER_KEY]` row. */
function seedEmptiedFolderWorkspaceOnTwoHosts(): void {
  const base = {
    id: FOLDER_ID,
    projectGroupId: 'group-1',
    name: 'notes',
    linkedTask: null,
    comment: '',
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0
  }
  useAppStore.setState({
    folderWorkspaces: [
      { ...base, folderPath: '/local/notes', executionHostId: 'local' },
      // Why: an SSH host, not a runtime one — runtime-owned workspaces return early from
      // `ensureWorktreeHasInitialTerminal` because the host owns terminal creation.
      { ...base, folderPath: '/remote/notes', executionHostId: SSH_HOST_ID, connectionId: 'conn-1' }
    ],
    activeView: 'terminal',
    tabsByWorktree: { [FOLDER_KEY]: [] },
    unifiedTabsByWorktree: {},
    groupsByWorktree: {},
    getFreshFolderWorkspacePathStatus: () => ({ exists: true }),
    markWorktreeVisited: vi.fn(),
    recordWorktreeVisit: vi.fn(),
    revealWorktreeInSidebar: vi.fn()
  } as unknown as Partial<ReturnType<typeof useAppStore.getState>>)
  expect(useAppStore.getState().reconcileWorktreeTabModel(FOLDER_KEY).renderableTabCount).toBe(0)
}

/** The same row after main recorded the close that emptied it — a deliberate emptying, which is
 *  what `isTerminalWorkspaceEmptiedOnPurpose` keys on. */
function recordFolderWorkspaceLastTerminalClosed(): void {
  useAppStore.setState({
    closedTerminalTabTombstonesByTabId: {
      closed: { closedAt: NOW, worktreeId: FOLDER_KEY }
    }
  })
}

describe('activating a folder workspace whose last terminal was closed', () => {
  it.each([
    ['Blank Terminal', null, 1],
    ['an agent', 'codex' as const, 0]
  ])('seeds a default shell for %s selection only', (_label, agent, expectedTabCount) => {
    seedEmptiedFolderWorkspaceOnTwoHosts()

    const result = activateAndRevealFolderWorkspace(FOLDER_ID, {
      agent,
      executionHostId: 'local'
    })

    expect(result).not.toBe(false)
    expect(useAppStore.getState().activeWorktreeId).toBe(FOLDER_KEY)
    expect(useAppStore.getState().tabsByWorktree[FOLDER_KEY]).toHaveLength(expectedTabCount)
  })

  it.each([true, false])(
    'forwards providesInitialSurface=%s through the async activation gate',
    async (providesInitialSurface) => {
      seedEmptiedFolderWorkspaceOnTwoHosts()
      useAppStore.setState({
        sleepingAgentSessionsByPaneKey: {
          'pane-1': { worktreeId: FOLDER_KEY }
        } as never
      })
      const gate = vi.spyOn(activationGate, 'gateWorktreeAgentActivation')
      gate.mockResolvedValue('empty')

      activateAndRevealFolderWorkspace(FOLDER_ID, {
        executionHostId: 'local',
        providesInitialSurface
      })
      await gate.mock.results[0]?.value

      expect(useAppStore.getState().tabsByWorktree[FOLDER_KEY]).toHaveLength(
        providesInitialSurface ? 0 : 1
      )
    }
  )

  it.each(['local', SSH_HOST_ID] as const)(
    'opens a notification on %s without revealing the folder',
    (executionHostId) => {
      seedEmptiedFolderWorkspaceOnTwoHosts()
      useAppStore.setState({ sidebarBody: 'agents' })

      const result = activateAndRevealWorkspace(FOLDER_KEY, {
        executionHostId,
        revealInSidebar: false,
        clearSidebarFilters: false
      })

      expect(result).not.toBe(false)
      expect(useAppStore.getState().activeWorktreeId).toBe(FOLDER_KEY)
      expect(useAppStore.getState().sidebarBody).toBe('agents')
      expect(useAppStore.getState().revealWorktreeInSidebar).not.toHaveBeenCalled()
    }
  )

  // This must use the folder entry point; setActiveWorktree(folderWorkspaceKey(...)) takes the git path.
  it.each([
    ['a local agent selection', { agent: 'codex' as const }, 'local' as const, 1],
    ['an SSH agent selection', { agent: 'codex' as const }, SSH_HOST_ID, 1],
    [
      'an agent selection whose caller promised its own surface',
      { agent: 'codex' as const, providesInitialSurface: true },
      'local' as const,
      0
    ]
  ])(
    're-seeds a gate-reported empty workspace for %s',
    async (_label, selection, executionHostId, expectedTabs) => {
      seedEmptiedFolderWorkspaceOnTwoHosts()
      useAppStore.setState({
        sleepingAgentSessionsByPaneKey: {
          'pane-1': { worktreeId: FOLDER_KEY }
        } as never
      })
      const gate = vi.spyOn(activationGate, 'gateWorktreeAgentActivation')
      gate.mockResolvedValue('empty')

      activateAndRevealFolderWorkspace(FOLDER_ID, { ...selection, executionHostId })
      await gate.mock.results[0]?.value

      expect(useAppStore.getState().activeWorktreeId).toBe(FOLDER_KEY)
      expect(useAppStore.getState().activeWorkspaceExecutionHostId).toBe(executionHostId)
      expect(useAppStore.getState().tabsByWorktree[FOLDER_KEY] ?? []).toHaveLength(expectedTabs)
    }
  )

  it('stays empty when the workspace the user emptied is opened', () => {
    seedEmptiedFolderWorkspaceOnTwoHosts()
    recordFolderWorkspaceLastTerminalClosed()

    const result = activateAndRevealFolderWorkspace(FOLDER_ID, { executionHostId: 'local' })

    expect(result).not.toBe(false)
    expect(useAppStore.getState().tabsByWorktree[FOLDER_KEY] ?? []).toEqual([])
  })

  it('stays empty when the restored active folder workspace is reopened on the same host', () => {
    seedEmptiedFolderWorkspaceOnTwoHosts()
    recordFolderWorkspaceLastTerminalClosed()
    useAppStore.setState({
      activeWorktreeId: FOLDER_KEY,
      activeWorkspaceExecutionHostId: 'local'
    })

    activateAndRevealFolderWorkspace(FOLDER_ID, { executionHostId: 'local' })

    expect(useAppStore.getState().tabsByWorktree[FOLDER_KEY] ?? []).toEqual([])
  })

  // Own-surface opt-out must also cover folders or file-link routing there reseeds shells.
  it('leaves the row empty when the caller opens its own surface', async () => {
    seedEmptiedFolderWorkspaceOnTwoHosts()
    useAppStore.setState({
      workspaceSessionReady: true,
      terminalStartupRestorationReady: true
    })
    vi.stubGlobal('window', {
      api: {
        runtime: {
          // A `session.tabs.list` answer must name the scope it listed, or the gate refuses it and
          // blocks — which would leave the row empty for the wrong reason.
          call: vi.fn(async () => ({
            ok: true,
            result: {
              worktree: FOLDER_KEY,
              publicationEpoch: 'epoch-1',
              snapshotVersion: 1,
              activeGroupId: null,
              activeTabId: null,
              activeTabType: null,
              tabs: []
            }
          }))
        },
        pty: { listSessions: vi.fn(async () => []) }
      }
    })

    const result = activateAndRevealFolderWorkspace(FOLDER_ID, {
      executionHostId: 'local',
      providesInitialSurface: true
    })
    await waitForWorktreeAgentActivationGateForTests(FOLDER_KEY)

    expect(result).not.toBe(false)
    expect(result === false ? null : result.primaryTabId).toBeNull()
    expect(useAppStore.getState().tabsByWorktree[FOLDER_KEY]).toEqual([])
  })

  it('re-seeds the shared row when opening the same folder id on a different host', () => {
    seedEmptiedFolderWorkspaceOnTwoHosts()
    useAppStore.setState({
      activeWorktreeId: FOLDER_KEY,
      activeWorkspaceExecutionHostId: 'local'
    })

    const result = activateAndRevealFolderWorkspace(FOLDER_ID, { executionHostId: SSH_HOST_ID })

    expect(result).not.toBe(false)
    expect(useAppStore.getState().tabsByWorktree[FOLDER_KEY]).toHaveLength(1)
    expect(useAppStore.getState().activeWorkspaceExecutionHostId).toBe(SSH_HOST_ID)
  })
})
