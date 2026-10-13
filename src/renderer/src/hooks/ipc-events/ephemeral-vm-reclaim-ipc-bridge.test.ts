import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import {
  LOCAL_EXECUTION_HOST_ID,
  toRuntimeExecutionHostId,
  toSshExecutionHostId,
  type ExecutionHostId
} from '../../../../shared/execution-host'
import type { EphemeralVmRuntimeReclaimed } from '../../../../shared/ephemeral-vm-runtime-reclaim'
import type { EphemeralVmRuntimeRecord } from '../../../../shared/ephemeral-vm-runtimes'
import { makeWorktree } from '../../store/slices/worktrees-slice-test-fixtures'
import { createTestStore } from '../../store/slices/worktrees-slice-test-harness'
import type { WorktreeSlice } from '../../store/slices/worktree-helpers'
import {
  forgetReclaimedEphemeralVmWorkspace,
  reconcileReclaimedEphemeralVmWorkspaces,
  registerEphemeralVmReclaimIpcBridge,
  resolveReclaimedEphemeralVmWorkspaceHostId
} from './ephemeral-vm-reclaim-ipc-bridge'

let store: ReturnType<typeof createTestStore>

// Why the module store is mocked rather than injected: the production wiring is the point of this
// bridge, so the handler has to reach the store the way the app hands it over.
vi.mock('../../store', () => ({
  useAppStore: {
    get getState() {
      return store.getState
    }
  }
}))

const WORKSPACE_ID = 'repo-1::/vm/workspace'
const RUNTIME_HOST_ID = toRuntimeExecutionHostId('env-vm')
const SSH_HOST_ID = toSshExecutionHostId('vm-target-1')

function reclaimEvent(workspaceId?: string): EphemeralVmRuntimeReclaimed {
  return {
    runtimeId: 'runtime-1',
    releaseAt: '2026-10-13T03:26:41Z',
    hostIds: [RUNTIME_HOST_ID, SSH_HOST_ID],
    ...(workspaceId ? { workspaceId } : {})
  }
}

function setWorkspaceHosts(hostIds: readonly ExecutionHostId[]): void {
  store.setState({
    worktreesByRepo: {
      'repo-1': hostIds.map((hostId, index) =>
        makeWorktree({ id: WORKSPACE_ID, repoId: 'repo-1', hostId, path: `/vm/${index}` })
      )
    }
  })
}

function makeRemoveWorktreeMock(): Mock<WorktreeSlice['removeWorktree']> {
  return vi.fn().mockResolvedValue({ ok: true })
}

let consoleWarn: ReturnType<typeof vi.spyOn>
let listRuntimes: Mock<() => Promise<EphemeralVmRuntimeRecord[]>>

/** A record as main persists it after a reclaim, where the host ids outlive the SSH target. */
function reclaimedRuntime(
  overrides: Partial<EphemeralVmRuntimeRecord> = {}
): EphemeralVmRuntimeRecord {
  return {
    id: 'runtime-1',
    recipeId: 'cloud-sandbox',
    repoId: 'repo-1',
    workspaceId: WORKSPACE_ID,
    connectionMode: 'ssh',
    status: 'running',
    cleanupStatus: 'not_started',
    reclaimedAt: Date.parse('2026-10-13T03:26:41Z'),
    reclaimedHostIds: [SSH_HOST_ID],
    createdAt: 1,
    updatedAt: 1,
    recipeResult: {
      schemaVersion: 1,
      connection: {
        type: 'ssh',
        projectRoot: '/vm/workspace',
        target: { label: 'VM', host: 'host', port: 22, username: 'orca' }
      }
    },
    ...overrides
  }
}

beforeEach(() => {
  store = createTestStore()
  consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  listRuntimes = vi.fn()
  listRuntimes.mockResolvedValue([])
  window.api.ephemeralVm.listRuntimes = listRuntimes
})

describe('resolveReclaimedEphemeralVmWorkspaceHostId', () => {
  it('answers with the runtime host when a workspace is listed on both spellings of one VM', () => {
    setWorkspaceHosts([SSH_HOST_ID, RUNTIME_HOST_ID])

    expect(
      resolveReclaimedEphemeralVmWorkspaceHostId(reclaimEvent(WORKSPACE_ID), store.getState())
    ).toBe(RUNTIME_HOST_ID)
  })

  it('answers with the only matching host, and nothing when no row belongs to the reclaimed host', () => {
    setWorkspaceHosts([SSH_HOST_ID])
    expect(
      resolveReclaimedEphemeralVmWorkspaceHostId(reclaimEvent(WORKSPACE_ID), store.getState())
    ).toBe(SSH_HOST_ID)

    setWorkspaceHosts([LOCAL_EXECUTION_HOST_ID])
    expect(
      resolveReclaimedEphemeralVmWorkspaceHostId(reclaimEvent(WORKSPACE_ID), store.getState())
    ).toBeNull()
  })

  it('never answers with a row belonging to a different host that shares the workspace id', () => {
    // Why this is the whole point of carrying hostIds: two VMs from one recipe with a fixed
    // projectRoot produce the same workspace id, so matching on the id alone would forget a live
    // sibling's row when the other VM was reclaimed.
    setWorkspaceHosts([toRuntimeExecutionHostId('env-other')])

    expect(
      resolveReclaimedEphemeralVmWorkspaceHostId(reclaimEvent(WORKSPACE_ID), store.getState())
    ).toBeNull()
  })

  it('accepts the persisted record spelling of the reclaimed host ids', () => {
    setWorkspaceHosts([SSH_HOST_ID])
    const record = reclaimedRuntime()

    // Why a separate spelling: the reconcile path reads `reclaimedHostIds` off the persisted
    // record, not `hostIds` off the live event, and an SSH-only host has nothing else to match on.
    expect(
      resolveReclaimedEphemeralVmWorkspaceHostId(
        { workspaceId: record.workspaceId, hostIds: record.reclaimedHostIds ?? [] },
        store.getState()
      )
    ).toBe(SSH_HOST_ID)
  })
})

describe('reconcileReclaimedEphemeralVmWorkspaces', () => {
  it('forgets the row of a runtime reclaimed while no window was listening', async () => {
    const removeWorktree = makeRemoveWorktreeMock()
    setWorkspaceHosts([SSH_HOST_ID])
    store.setState({ removeWorktree })
    listRuntimes.mockResolvedValue([reclaimedRuntime()])

    await reconcileReclaimedEphemeralVmWorkspaces()

    expect(removeWorktree).toHaveBeenCalledWith(
      { id: WORKSPACE_ID, executionHostId: SSH_HOST_ID },
      false,
      { mode: 'forget-local' }
    )
  })

  it('leaves a row whose host is not the reclaimed one', async () => {
    const removeWorktree = makeRemoveWorktreeMock()
    setWorkspaceHosts([toRuntimeExecutionHostId('env-other')])
    store.setState({ removeWorktree })
    listRuntimes.mockResolvedValue([reclaimedRuntime()])

    await reconcileReclaimedEphemeralVmWorkspaces()

    expect(removeWorktree).not.toHaveBeenCalled()
  })

  it('skips a runtime with no reclaimed host identities, and one never reclaimed', async () => {
    const removeWorktree = makeRemoveWorktreeMock()
    setWorkspaceHosts([SSH_HOST_ID])
    store.setState({ removeWorktree })
    listRuntimes.mockResolvedValue([
      reclaimedRuntime({ reclaimedHostIds: undefined }),
      reclaimedRuntime({ id: 'runtime-2', reclaimedAt: undefined })
    ])

    await reconcileReclaimedEphemeralVmWorkspaces()

    expect(removeWorktree).not.toHaveBeenCalled()
  })

  it('stays quiet when the runtime list cannot be read', async () => {
    listRuntimes.mockRejectedValue(new Error('IPC gone'))

    await expect(reconcileReclaimedEphemeralVmWorkspaces()).resolves.toBeUndefined()
  })

  it('stays quiet when this window has no preload api', async () => {
    vi.stubGlobal('window', {})
    try {
      await expect(reconcileReclaimedEphemeralVmWorkspaces()).resolves.toBeUndefined()
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

describe('forgetReclaimedEphemeralVmWorkspace', () => {
  it('forgets the workspace on its host while leaving files, git and branches alone', async () => {
    const removeWorktree = makeRemoveWorktreeMock()
    setWorkspaceHosts([RUNTIME_HOST_ID])
    store.setState({ removeWorktree })

    await forgetReclaimedEphemeralVmWorkspace(reclaimEvent(WORKSPACE_ID))

    expect(removeWorktree).toHaveBeenCalledWith(
      { id: WORKSPACE_ID, executionHostId: RUNTIME_HOST_ID },
      false,
      { mode: 'forget-local' }
    )
  })

  it('does nothing for an event that names no workspace', async () => {
    const removeWorktree = makeRemoveWorktreeMock()
    setWorkspaceHosts([RUNTIME_HOST_ID])
    store.setState({ removeWorktree })

    await forgetReclaimedEphemeralVmWorkspace(reclaimEvent())

    expect(removeWorktree).not.toHaveBeenCalled()
  })

  it('leaves a workspace this renderer only knows locally, and says why', async () => {
    const removeWorktree = makeRemoveWorktreeMock()
    setWorkspaceHosts([LOCAL_EXECUTION_HOST_ID])
    store.setState({ removeWorktree })

    await forgetReclaimedEphemeralVmWorkspace(reclaimEvent(WORKSPACE_ID))

    expect(removeWorktree).not.toHaveBeenCalled()
    expect(consoleWarn).toHaveBeenCalledWith(expect.stringContaining(WORKSPACE_ID))
  })

  it('reports a refused removal instead of throwing it', async () => {
    const removeWorktree: Mock<WorktreeSlice['removeWorktree']> = vi
      .fn()
      .mockResolvedValue({ ok: false, error: 'Workspace identity is ambiguous across hosts.' })
    setWorkspaceHosts([RUNTIME_HOST_ID])
    store.setState({ removeWorktree })

    await expect(
      forgetReclaimedEphemeralVmWorkspace(reclaimEvent(WORKSPACE_ID))
    ).resolves.toBeUndefined()

    expect(consoleWarn).toHaveBeenCalledWith(
      expect.stringContaining('Workspace identity is ambiguous across hosts.')
    )
  })
})

describe('registerEphemeralVmReclaimIpcBridge', () => {
  it('forgets later workspaces even when an earlier one fails', async () => {
    const removeWorktree = makeRemoveWorktreeMock()
    removeWorktree.mockRejectedValueOnce(new Error('IPC gone'))
    setWorkspaceHosts([RUNTIME_HOST_ID])
    store.setState({ removeWorktree })
    let deliver: ((event: EphemeralVmRuntimeReclaimed) => void) | undefined
    window.api.ephemeralVm.onRuntimeReclaimed = (callback) => {
      deliver = callback
      return () => {}
    }
    const unsubs: (() => void)[] = []

    registerEphemeralVmReclaimIpcBridge(unsubs)
    deliver?.(reclaimEvent(WORKSPACE_ID))
    deliver?.(reclaimEvent(WORKSPACE_ID))

    await vi.waitFor(() => expect(removeWorktree).toHaveBeenCalledTimes(2))
    // One subscription for the reclaim event and one for every publish, which is what makes a
    // reclaim that happened while no window was open converge once the lists load.
    expect(unsubs).toHaveLength(2)
  })
})
