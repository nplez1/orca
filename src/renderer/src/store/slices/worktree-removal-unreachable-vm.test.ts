/**
 * A delete whose VM stopped answering must not leave both the workspace AND the machine behind.
 *
 * The reported failure: `worktree.rm` cannot reach the Orca server inside the VM, so the removal
 * threw before the renderer ever ran the recipe's destroy — the workspace stayed frozen in the
 * sidebar with the provider node still allocated. The destroy runs locally against the provider,
 * so the machine can be released without the guest, and the row can go with it.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { toast } from 'sonner'
import { getDefaultSettings } from '../../../../shared/constants'
import type { KnownRuntimeEnvironment } from '../../../../shared/runtime-environments'
import { createCompatibleRuntimeStatusResponseIfNeeded } from '../../runtime/runtime-compatibility-test-fixture'
import { clearRuntimeCompatibilityCacheForTests } from '../../runtime/runtime-rpc-client'
import { createTestStore, makeLayout, makeTab, makeWorktree, seedStore } from './store-test-helpers'
import { createStoreCascadesMockApi } from './store-cascades-test-harness'
import { resolveUnreachableVmRemovalFallback } from './worktrees/teardown/unreachable-vm-workspace-release'
import type * as AgentStatusModule from '@/lib/agent-status'

vi.mock('sonner', () => ({
  toast: { info: vi.fn(), success: vi.fn(), error: vi.fn(), warning: vi.fn() }
}))

vi.mock('@/components/terminal-pane/pty-dispatcher', () => ({
  restorePtyDataHandlersAfterFailedShutdown: vi.fn(),
  unregisterPtyDataHandlers: vi.fn(() => [])
}))

vi.mock('@/lib/agent-status', async (importOriginal) => {
  const actual = await importOriginal<typeof AgentStatusModule>()
  return {
    ...actual,
    detectAgentStatusFromTitle: vi.fn().mockReturnValue(null)
  }
})

const mockApi = createStoreCascadesMockApi()
const listRuntimes = vi.fn()
const cleanupRuntime = vi.fn()

// The store cascade harness predates the ephemeral-VM bridge; add the two calls this path makes.
const forgetLocal = vi.fn()
Object.assign(mockApi.worktrees, { forgetLocal })
Object.assign(globalThis.window.api, {
  ephemeralVm: { listRuntimes, cleanup: cleanupRuntime }
})

const WORKTREE_ID = 'repo1::/path/wt1'
const ENV_ID = 'env-vm-1'
const UNREACHABLE = `Error invoking remote method 'runtime-environments:call': Error: Could not connect to the remote Orca runtime at ws://127.0.0.1:42000.`

/** The runtime-environment record a recipe VM is reached as. */
function vmEnvironment(): KnownRuntimeEnvironment {
  return {
    id: ENV_ID,
    name: 'vm-host',
    createdAt: 0,
    updatedAt: 0,
    lastUsedAt: null,
    runtimeId: 'runtime-1',
    source: 'ephemeral-vm',
    endpoints: [
      {
        id: 'endpoint-1',
        kind: 'websocket',
        label: 'loopback',
        endpoint: 'ws://127.0.0.1:42000',
        deviceToken: 'a'.repeat(48),
        publicKeyB64: 'a'.repeat(43)
      }
    ],
    preferredEndpointId: 'endpoint-1'
  }
}

function seedVmWorkspace(store: ReturnType<typeof createTestStore>): void {
  seedStore(store, {
    settings: { ...getDefaultSettings('/tmp'), activeRuntimeEnvironmentId: ENV_ID },
    worktreesByRepo: {
      repo1: [
        makeWorktree({
          id: WORKTREE_ID,
          repoId: 'repo1',
          path: '/path/wt1',
          hostId: `runtime:${ENV_ID}`,
          displayName: 'vm-workspace'
        })
      ]
    }
  })
}

function failEveryRemoteCall(): void {
  mockApi.runtimeEnvironments.call.mockImplementation((args: { method: string }) => {
    const compatibility = createCompatibleRuntimeStatusResponseIfNeeded(args)
    if (compatibility) {
      return Promise.resolve(compatibility)
    }
    // Why no exemption for repo.hooksCheck: a host that never answered cannot answer it either, so
    // the trust check fails closed to 'skip'. That is also what lets the delete proceed without an
    // archive-hook waiver — see the trusted-repo case below, where it does not.
    return Promise.reject(new Error(UNREACHABLE))
  })
}

describe('deleting a workspace whose VM is unreachable', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    clearRuntimeCompatibilityCacheForTests()
    listRuntimes.mockReset()
    cleanupRuntime.mockReset()
    forgetLocal.mockReset()
    forgetLocal.mockResolvedValue({})
    failEveryRemoteCall()
  })

  it('releases the machine and still removes the workspace', async () => {
    const store = createTestStore()
    seedVmWorkspace(store)
    listRuntimes.mockResolvedValue([
      {
        id: 'rt-vm-1',
        workspaceId: WORKTREE_ID,
        runtimeEnvironmentId: ENV_ID,
        cleanupStatus: 'not_started',
        status: 'running'
      }
    ])
    cleanupRuntime.mockResolvedValue({
      id: 'rt-vm-1',
      status: 'cleaned',
      cleanupStatus: 'succeeded'
    })

    const result = await store.getState().removeWorktree({
      id: WORKTREE_ID,
      executionHostId: `runtime:${ENV_ID}`
    })

    // The delete completes instead of stranding the workspace on a connection error.
    expect(result).toEqual({ ok: true })
    expect(store.getState().worktreesByRepo['repo1']).toEqual([])
    // The provider node is released — the step that never ran before.
    expect(cleanupRuntime).toHaveBeenCalledWith({ runtimeId: 'rt-vm-1' })
    // The workspace row is forgotten locally, since no guest answered.
    expect(forgetLocal).toHaveBeenCalledWith(
      expect.objectContaining({ worktreeId: WORKTREE_ID, hostId: `runtime:${ENV_ID}` })
    )
    // And the user is told the machine was released, not deleted through its server.
    expect(toast.info).toHaveBeenCalledWith(
      'Workspace removed — its VM was released',
      expect.objectContaining({ description: expect.stringContaining('released the machine') })
    )
  })

  it('never re-runs the destroy while tearing the workspace down', async () => {
    const store = createTestStore()
    seedVmWorkspace(store)
    listRuntimes.mockResolvedValue([
      {
        id: 'rt-vm-1',
        workspaceId: WORKTREE_ID,
        runtimeEnvironmentId: ENV_ID,
        cleanupStatus: 'not_started',
        status: 'running'
      }
    ])
    cleanupRuntime.mockResolvedValue({
      id: 'rt-vm-1',
      status: 'cleaned',
      cleanupStatus: 'succeeded'
    })

    await store.getState().removeWorktree({
      id: WORKTREE_ID,
      executionHostId: `runtime:${ENV_ID}`
    })

    expect(cleanupRuntime).toHaveBeenCalledTimes(1)
  })

  it('tells the user when the recipe never owned the teardown', async () => {
    const store = createTestStore()
    seedVmWorkspace(store)
    listRuntimes.mockResolvedValue([
      {
        id: 'rt-vm-1',
        workspaceId: WORKTREE_ID,
        runtimeEnvironmentId: ENV_ID,
        cleanupStatus: 'not_started',
        status: 'running'
      }
    ])
    cleanupRuntime.mockResolvedValue({
      id: 'rt-vm-1',
      status: 'cleaned',
      cleanupStatus: 'disabled'
    })

    const result = await store.getState().removeWorktree({
      id: WORKTREE_ID,
      executionHostId: `runtime:${ENV_ID}`
    })

    expect(result).toEqual({ ok: true })
    // Why a different sentence: nothing released the machine, so claiming a release would lie.
    expect(toast.info).toHaveBeenCalledWith(
      'Workspace removed — its VM may still be running',
      expect.objectContaining({ description: expect.stringContaining('provider lease') })
    )
  })

  it('still removes the workspace when the machine could not be released', async () => {
    const store = createTestStore()
    seedVmWorkspace(store)
    listRuntimes.mockResolvedValue([
      {
        id: 'rt-vm-1',
        workspaceId: WORKTREE_ID,
        runtimeEnvironmentId: ENV_ID,
        cleanupStatus: 'not_started',
        status: 'running'
      }
    ])
    cleanupRuntime.mockResolvedValue({
      id: 'rt-vm-1',
      status: 'cleanup_failed',
      cleanupStatus: 'failed',
      cleanupLastError: 'provider said no'
    })

    const result = await store.getState().removeWorktree({
      id: WORKTREE_ID,
      executionHostId: `runtime:${ENV_ID}`
    })

    // Why the row goes anyway: a workspace Orca can never reach again is not something the user
    // should have to keep deleting, and the provider's own lease ends the machine.
    expect(result).toEqual({ ok: true })
    expect(store.getState().worktreesByRepo['repo1']).toEqual([])
    expect(forgetLocal).toHaveBeenCalled()
    expect(toast.info).toHaveBeenCalledWith(
      'Workspace removed — its VM may still be running',
      expect.objectContaining({ description: expect.stringContaining('provider lease') })
    )
  })

  it('tears the workspace down like any other delete', async () => {
    const store = createTestStore()
    seedStore(store, {
      settings: { ...getDefaultSettings('/tmp'), activeRuntimeEnvironmentId: ENV_ID },
      worktreesByRepo: {
        repo1: [
          makeWorktree({
            id: WORKTREE_ID,
            repoId: 'repo1',
            path: '/path/wt1',
            hostId: `runtime:${ENV_ID}`
          })
        ]
      },
      tabsByWorktree: { [WORKTREE_ID]: [makeTab({ id: 'tab1', worktreeId: WORKTREE_ID })] },
      ptyIdsByTabId: { tab1: ['pty1'] },
      terminalLayoutsByTabId: { tab1: makeLayout() }
    })
    listRuntimes.mockResolvedValue([
      { id: 'rt-vm-1', workspaceId: WORKTREE_ID, runtimeEnvironmentId: ENV_ID }
    ])
    cleanupRuntime.mockResolvedValue({
      id: 'rt-vm-1',
      status: 'cleaned',
      cleanupStatus: 'succeeded'
    })

    await store.getState().removeWorktree({
      id: WORKTREE_ID,
      executionHostId: `runtime:${ENV_ID}`
    })

    // Why this is the stuck-banner fix: the pane that kept asking to reconnect belongs to this
    // workspace, so nothing may be left mounted for it.
    expect(store.getState().tabsByWorktree[WORKTREE_ID]).toBeUndefined()
    expect(store.getState().ptyIdsByTabId['tab1']).toBeUndefined()
    expect(store.getState().terminalLayoutsByTabId['tab1']).toBeUndefined()
  })

  it('asks before skipping the archive hook a trusted repo would have run', async () => {
    const store = createTestStore()
    seedVmWorkspace(store)
    // A content-hash approval is a hook the normal delete WOULD have run; with the host down the
    // check cannot run, so the delete must ask instead of archiving nothing and destroying the VM.
    store.setState({
      trustedOrcaHooks: { repo1: { archive: { contentHash: 'hash', approvedAt: 0 } } }
    })
    listRuntimes.mockResolvedValue([
      { id: 'rt-vm-1', workspaceId: WORKTREE_ID, runtimeEnvironmentId: ENV_ID }
    ])

    const result = await store.getState().removeWorktree({
      id: WORKTREE_ID,
      executionHostId: `runtime:${ENV_ID}`
    })

    expect(result.ok).toBe(false)
    // Why it blocks: the hook is the user's last chance to save work off a checkout, and losing
    // contact is never evidence that it ran.
    expect(result.ok === false && result.error).toContain('Archive hook failed for worktree')
    expect(store.getState().worktreesByRepo['repo1']).toHaveLength(1)
    // Nothing was stopped on the user's behalf, so nothing may be destroyed either.
    expect(cleanupRuntime).not.toHaveBeenCalled()
    expect(forgetLocal).not.toHaveBeenCalled()
  })

  it('asks when the repo itself declares an archive script', async () => {
    const store = createTestStore()
    seedVmWorkspace(store)
    store.setState({
      repos: [
        {
          ...store.getState().repos[0]!,
          executionHostId: `runtime:${ENV_ID}`,
          hookSettings: {
            mode: 'auto',
            scripts: { setup: '', archive: 'git bundle create /tmp/wt.bundle HEAD' }
          }
        }
      ]
    })
    listRuntimes.mockResolvedValue([
      { id: 'rt-vm-1', workspaceId: WORKTREE_ID, runtimeEnvironmentId: ENV_ID }
    ])

    const result = await store.getState().removeWorktree({
      id: WORKTREE_ID,
      executionHostId: `runtime:${ENV_ID}`
    })

    expect(result.ok).toBe(false)
    expect(result.ok === false && result.error).toContain('Delete Anyway')
    expect(cleanupRuntime).not.toHaveBeenCalled()
  })

  it('finishes the delete once the archive hook is explicitly waived', async () => {
    const store = createTestStore()
    seedVmWorkspace(store)
    store.setState({ trustedOrcaHooks: { repo1: { all: { approvedAt: 0 } } } })
    listRuntimes.mockResolvedValue([
      { id: 'rt-vm-1', workspaceId: WORKTREE_ID, runtimeEnvironmentId: ENV_ID }
    ])
    cleanupRuntime.mockResolvedValue({
      id: 'rt-vm-1',
      status: 'cleaned',
      cleanupStatus: 'succeeded'
    })

    // "Delete Anyway" in the toast retries exactly this way.
    const result = await store
      .getState()
      .removeWorktree({ id: WORKTREE_ID, executionHostId: `runtime:${ENV_ID}` }, false, {
        allowFailedArchiveHook: true
      })

    expect(result).toEqual({ ok: true })
    expect(store.getState().worktreesByRepo['repo1']).toEqual([])
    expect(cleanupRuntime).toHaveBeenCalledWith({ runtimeId: 'rt-vm-1' })
  })

  it('removes the workspace even when the runtime records cannot be read', async () => {
    const store = createTestStore()
    seedStore(store, {
      settings: { ...getDefaultSettings('/tmp'), activeRuntimeEnvironmentId: ENV_ID },
      runtimeEnvironments: [vmEnvironment()],
      worktreesByRepo: {
        repo1: [
          makeWorktree({
            id: WORKTREE_ID,
            repoId: 'repo1',
            path: '/path/wt1',
            hostId: `runtime:${ENV_ID}`,
            displayName: 'vm-workspace'
          })
        ]
      }
    })
    // Why the unreadable listing must not matter: the row is what the user is deleting, and the
    // machine's own lease ends it. Refusing here is the stuck state this path exists to remove.
    listRuntimes.mockRejectedValue(new Error('runtime store unreadable'))

    const result = await store.getState().removeWorktree({
      id: WORKTREE_ID,
      executionHostId: `runtime:${ENV_ID}`
    })

    expect(result).toEqual({ ok: true })
    expect(store.getState().worktreesByRepo['repo1']).toEqual([])
    expect(toast.info).toHaveBeenCalledWith(
      'Workspace removed — its VM may still be running',
      expect.anything()
    )
  })

  it('leaves an ordinary unreachable runtime host on its original failure', async () => {
    const store = createTestStore()
    // A server the user paired: its machine may come back with their work, so its row stays.
    seedStore(store, {
      settings: { ...getDefaultSettings('/tmp'), activeRuntimeEnvironmentId: ENV_ID },
      runtimeEnvironments: [{ ...vmEnvironment(), source: 'manual' }],
      worktreesByRepo: {
        repo1: [
          makeWorktree({
            id: WORKTREE_ID,
            repoId: 'repo1',
            path: '/path/wt1',
            hostId: `runtime:${ENV_ID}`,
            displayName: 'paired-workspace'
          })
        ]
      }
    })
    // Why the record names this very workspace: a known non-VM environment outranks the records, so
    // even a leftover record that matches may not turn the user's own server into Orca's machine.
    listRuntimes.mockResolvedValue([
      { id: 'rt-leftover', workspaceId: WORKTREE_ID, runtimeEnvironmentId: ENV_ID }
    ])

    const result = await store.getState().removeWorktree({
      id: WORKTREE_ID,
      executionHostId: `runtime:${ENV_ID}`
    })

    expect(result.ok).toBe(false)
    expect(cleanupRuntime).not.toHaveBeenCalled()
    expect(forgetLocal).not.toHaveBeenCalled()
    expect(result.ok === false && result.error).toContain(
      'Could not connect to the remote Orca runtime'
    )
  })
})

/**
 * An SSH-connection-mode VM is reached as `ssh:<runtime-owned target>`, and its delete fails with
 * the SSH transport's own wording rather than the runtime's — same stuck state, different sentence.
 */
describe('an unreachable host whose transport is SSH', () => {
  const SSH_DROPPED =
    'Remote connection dropped. Click Reconnect on the SSH target before retrying.'

  beforeEach(() => {
    vi.clearAllMocks()
    listRuntimes.mockReset()
    cleanupRuntime.mockReset()
    forgetLocal.mockReset()
    forgetLocal.mockResolvedValue({})
  })

  it('drops a VM workspace whose target nothing serves', async () => {
    const store = createTestStore()
    listRuntimes.mockRejectedValue(new Error('runtime store unreadable'))

    await expect(
      resolveUnreachableVmRemovalFallback({
        error: new Error(SSH_DROPPED),
        worktreeId: WORKTREE_ID,
        worktreePath: '/path/wt1',
        hostId: 'ssh:runtime-ssh-vm-1',
        repoId: 'repo1',
        allowFailedArchiveHook: false,
        get: store.getState
      })
    ).resolves.toEqual({ kind: 'forget-locally' })
  })

  it('releases the machine when its runtime record is readable', async () => {
    const store = createTestStore()
    listRuntimes.mockResolvedValue([
      {
        id: 'rt-vm-1',
        workspaceId: WORKTREE_ID,
        sshTargetId: 'runtime-ssh-vm-1',
        cleanupStatus: 'not_started'
      }
    ])
    cleanupRuntime.mockResolvedValue({
      id: 'rt-vm-1',
      status: 'cleaned',
      cleanupStatus: 'succeeded'
    })

    const fallback = await resolveUnreachableVmRemovalFallback({
      error: new Error(SSH_DROPPED),
      worktreeId: WORKTREE_ID,
      worktreePath: '/path/wt1',
      hostId: 'ssh:runtime-ssh-vm-1',
      repoId: 'repo1',
      allowFailedArchiveHook: false,
      get: store.getState
    })

    expect(fallback.kind).toBe('forget-locally')
    // Why not here: the decision never destroys — the teardown that follows does.
    expect(cleanupRuntime).not.toHaveBeenCalled()
  })

  it('keeps the original failure for an SSH target the user configured', async () => {
    const store = createTestStore()
    listRuntimes.mockResolvedValue([])

    await expect(
      resolveUnreachableVmRemovalFallback({
        error: new Error(SSH_DROPPED),
        worktreeId: WORKTREE_ID,
        worktreePath: '/path/wt1',
        hostId: 'ssh:my-own-server',
        repoId: 'repo1',
        allowFailedArchiveHook: false,
        get: store.getState
      })
    ).resolves.toEqual({ kind: 'not-applicable' })
  })
})
