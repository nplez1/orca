import { beforeEach, describe, expect, it, vi } from 'vitest'

const listRuntimes = vi.fn()
const cleanup = vi.fn().mockResolvedValue({ status: 'cleaned' })

// @ts-expect-error -- test shim for the preload bridge
globalThis.window = { api: { ephemeralVm: { listRuntimes, cleanup } } }

import {
  cleanupEphemeralVmRuntimesForDeleted,
  listEphemeralVmRuntimesForWorkspace
} from './ephemeral-vm-runtime-cleanup'
import { toSshExecutionHostId } from '../../../shared/execution-host'
import { setRuntimeEnvironmentCatalogRefresher } from '@/runtime/runtime-environment-pairing-refresh'

function runtime(overrides: Record<string, unknown>): Record<string, unknown> {
  return { id: 'rt', cleanupStatus: 'not_started', ...overrides }
}

/** The full summary, so an assertion cannot pass by ignoring a newly classified runtime. */
function summary(overrides: Partial<Record<string, string[]>> = {}): Record<string, string[]> {
  return {
    destroyedSshTargetIds: [],
    retainedSshTargetIds: [],
    releasedRuntimeIds: [],
    destroyDisabledRuntimeIds: [],
    failedRuntimeIds: [],
    matchedRuntimeIds: [],
    ...overrides
  }
}

describe('cleanupEphemeralVmRuntimesForDeleted', () => {
  beforeEach(() => {
    listRuntimes.mockReset()
    cleanup.mockReset().mockResolvedValue({ status: 'cleaned' })
  })

  it('cleans runtimes matched by workspace id and returns destroyed SSH target ids', async () => {
    listRuntimes.mockResolvedValue([
      runtime({ id: 'rt-1', workspaceId: 'wt-1', sshTargetId: 'runtime-ssh-a' }),
      runtime({ id: 'rt-2', workspaceId: 'wt-other' })
    ])

    const destroyed = await cleanupEphemeralVmRuntimesForDeleted({ workspaceIds: ['wt-1'] })

    expect(cleanup).toHaveBeenCalledTimes(1)
    expect(cleanup).toHaveBeenCalledWith({ runtimeId: 'rt-1' })
    expect(destroyed).toEqual(
      summary({
        destroyedSshTargetIds: ['runtime-ssh-a'],
        releasedRuntimeIds: ['rt-1'],
        matchedRuntimeIds: ['rt-1']
      })
    )
  })

  it("re-reads the server catalog once a cleanup may have forgotten the VM's server (#33805)", async () => {
    listRuntimes.mockResolvedValue([
      runtime({ id: 'rt-a', workspaceId: 'wt-1', runtimeEnvironmentId: 'env-a' })
    ])
    const refresher = vi.fn(async () => {})
    setRuntimeEnvironmentCatalogRefresher(refresher)
    try {
      await cleanupEphemeralVmRuntimesForDeleted({ workspaceIds: ['wt-1'] })
    } finally {
      setRuntimeEnvironmentCatalogRefresher(null)
    }

    expect(refresher).toHaveBeenCalledTimes(1)
    expect(refresher.mock.invocationCallOrder[0]).toBeGreaterThan(
      cleanup.mock.invocationCallOrder[0]
    )
  })

  it('cleans only the confirmed host runtime when another host owns the same workspace id', async () => {
    listRuntimes.mockResolvedValue([
      runtime({
        id: 'rt-a',
        workspaceId: 'wt-1',
        runtimeEnvironmentId: 'env-a'
      }),
      runtime({
        id: 'rt-b',
        workspaceId: 'wt-1',
        runtimeEnvironmentId: 'env-b'
      })
    ])

    await cleanupEphemeralVmRuntimesForDeleted({
      hostScopedWorkspaces: [{ workspaceId: 'wt-1', executionHostId: 'runtime:env-a' }]
    })

    expect(cleanup).toHaveBeenCalledTimes(1)
    expect(cleanup).toHaveBeenCalledWith({ runtimeId: 'rt-a' })
  })

  it('cleans only the confirmed SSH-host runtime when target ids need encoding', async () => {
    listRuntimes.mockResolvedValue([
      runtime({ id: 'rt-a', workspaceId: 'wt-1', sshTargetId: 'build/a|primary' }),
      runtime({ id: 'rt-b', workspaceId: 'wt-1', sshTargetId: 'build-b' })
    ])

    await cleanupEphemeralVmRuntimesForDeleted({
      hostScopedWorkspaces: [
        { workspaceId: 'wt-1', executionHostId: toSshExecutionHostId('build/a|primary') }
      ]
    })

    expect(cleanup).toHaveBeenCalledTimes(1)
    expect(cleanup).toHaveBeenCalledWith({ runtimeId: 'rt-a' })
  })

  it('cleans a runtime matched only by its runtime-owned SSH target id', async () => {
    // SSH-mode workspace deletion is project removal; find its runtime via repo connectionId even without a matching workspace ID.
    listRuntimes.mockResolvedValue([
      runtime({ id: 'rt-1', workspaceId: undefined, sshTargetId: 'runtime-ssh-orca-1' })
    ])

    const destroyed = await cleanupEphemeralVmRuntimesForDeleted({
      runtimeOwnedSshTargetIds: ['runtime-ssh-orca-1']
    })

    expect(cleanup).toHaveBeenCalledWith({ runtimeId: 'rt-1' })
    expect(destroyed).toEqual(
      summary({
        destroyedSshTargetIds: ['runtime-ssh-orca-1'],
        releasedRuntimeIds: ['rt-1'],
        matchedRuntimeIds: ['rt-1']
      })
    )
  })

  it('ignores non-runtime-owned target ids and already-cleaned runtimes', async () => {
    listRuntimes.mockResolvedValue([
      runtime({ id: 'rt-done', workspaceId: 'wt-1', cleanupStatus: 'succeeded' }),
      runtime({ id: 'rt-user', sshTargetId: 'my-server' })
    ])

    const destroyed = await cleanupEphemeralVmRuntimesForDeleted({
      workspaceIds: ['wt-1'],
      runtimeOwnedSshTargetIds: ['my-server']
    })

    expect(cleanup).not.toHaveBeenCalled()
    expect(destroyed).toEqual(summary({ matchedRuntimeIds: ['rt-done'] }))
  })

  it('never cleans a reclaimed runtime, whose destroy would reach a machine that may still be alive', async () => {
    // Why this is the load-bearing case: a reclaim already released this host's registrations because
    // its provider lease lapsed. The workspace row that follows is Orca forgetting it, and re-entering
    // cleanup here would run the recipe's destroy on a machine the user may still be using.
    listRuntimes.mockResolvedValue([
      runtime({
        id: 'rt-reclaimed',
        workspaceId: 'wt-1',
        cleanupStatus: 'not_started',
        reclaimedAt: 1_700_000_000_000
      }),
      runtime({
        id: 'rt-reclaimed-ssh',
        sshTargetId: 'runtime-ssh-b',
        reclaimedAt: 1_700_000_000_000
      })
    ])

    const destroyed = await cleanupEphemeralVmRuntimesForDeleted({
      workspaceIds: ['wt-1'],
      runtimeOwnedSshTargetIds: ['runtime-ssh-b']
    })

    expect(cleanup).not.toHaveBeenCalled()
    expect(destroyed).toEqual(summary({ matchedRuntimeIds: ['rt-reclaimed', 'rt-reclaimed-ssh'] }))
  })

  it('retries a completed provider cleanup while its SSH target remains', async () => {
    listRuntimes.mockResolvedValue([
      runtime({
        id: 'rt-1',
        workspaceId: 'wt-1',
        status: 'cleanup_failed',
        cleanupStatus: 'succeeded',
        sshTargetId: 'runtime-ssh-a'
      })
    ])
    cleanup.mockResolvedValue({ status: 'cleaned', cleanupStatus: 'succeeded' })

    await expect(cleanupEphemeralVmRuntimesForDeleted({ workspaceIds: ['wt-1'] })).resolves.toEqual(
      summary({
        destroyedSshTargetIds: ['runtime-ssh-a'],
        releasedRuntimeIds: ['rt-1'],
        matchedRuntimeIds: ['rt-1']
      })
    )
    expect(cleanup).toHaveBeenCalledWith({ runtimeId: 'rt-1' })
  })

  it('does not report a retained SSH target as destroyed', async () => {
    listRuntimes.mockResolvedValue([
      runtime({ id: 'rt-1', workspaceId: 'wt-1', sshTargetId: 'runtime-ssh-a' })
    ])
    cleanup.mockResolvedValue({
      status: 'cleanup_failed',
      cleanupStatus: 'failed',
      sshTargetId: 'runtime-ssh-a'
    })

    await expect(cleanupEphemeralVmRuntimesForDeleted({ workspaceIds: ['wt-1'] })).resolves.toEqual(
      summary({
        retainedSshTargetIds: ['runtime-ssh-a'],
        failedRuntimeIds: ['rt-1'],
        matchedRuntimeIds: ['rt-1']
      })
    )
  })

  it('reads a failed destroy off the returned record, not off the absence of a throw', async () => {
    // Why: ephemeralVm:cleanup answers a failed destroy with the record itself, so the caller that
    // decides whether a machine is still allocated has to read cleanupStatus.
    listRuntimes.mockResolvedValue([runtime({ id: 'rt-1', workspaceId: 'wt-1' })])
    cleanup.mockResolvedValue({ status: 'cleanup_failed', cleanupStatus: 'failed' })

    await expect(cleanupEphemeralVmRuntimesForDeleted({ workspaceIds: ['wt-1'] })).resolves.toEqual(
      summary({ failedRuntimeIds: ['rt-1'], matchedRuntimeIds: ['rt-1'] })
    )
  })

  it('classifies a recipe with no destroy step as disabled rather than released', async () => {
    listRuntimes.mockResolvedValue([runtime({ id: 'rt-1', workspaceId: 'wt-1' })])
    cleanup.mockResolvedValue({ status: 'cleaned', cleanupStatus: 'disabled' })

    await expect(cleanupEphemeralVmRuntimesForDeleted({ workspaceIds: ['wt-1'] })).resolves.toEqual(
      summary({ destroyDisabledRuntimeIds: ['rt-1'], matchedRuntimeIds: ['rt-1'] })
    )
  })

  it('swallows listRuntimes failures', async () => {
    listRuntimes.mockRejectedValue(new Error('boom'))
    await expect(cleanupEphemeralVmRuntimesForDeleted({ workspaceIds: ['wt-1'] })).resolves.toEqual(
      summary()
    )
  })

  it('retains an explicit runtime target when runtime listing fails', async () => {
    listRuntimes.mockRejectedValue(new Error('boom'))

    await expect(
      cleanupEphemeralVmRuntimesForDeleted({
        runtimeOwnedSshTargetIds: ['runtime-ssh-a']
      })
    ).resolves.toEqual(summary({ retainedSshTargetIds: ['runtime-ssh-a'] }))
  })
})

describe('listEphemeralVmRuntimesForWorkspace', () => {
  beforeEach(() => {
    listRuntimes.mockReset()
    cleanup.mockReset().mockResolvedValue({ status: 'cleaned', cleanupStatus: 'succeeded' })
  })

  it('names the records a delete would destroy, and touches none of them', async () => {
    listRuntimes.mockResolvedValue([
      runtime({ id: 'rt-1', workspaceId: 'wt-1', runtimeEnvironmentId: 'env-1' }),
      runtime({ id: 'rt-other', workspaceId: 'wt-2' })
    ])

    const matched = await listEphemeralVmRuntimesForWorkspace({
      workspaceId: 'wt-1',
      executionHostId: 'runtime:env-1'
    })

    expect(matched.map((entry) => entry.id)).toEqual(['rt-1'])
    // Why no destroy: the delete only decides here; the teardown that follows is the sole writer.
    expect(cleanup).not.toHaveBeenCalled()
  })

  it('names a released or reclaimed record too, which is why a retried delete still finishes', async () => {
    listRuntimes.mockResolvedValue([
      runtime({ id: 'rt-released', workspaceId: 'wt-1', cleanupStatus: 'succeeded' }),
      runtime({ id: 'rt-reclaimed', workspaceId: 'wt-1', reclaimedAt: 1_700_000_000_000 })
    ])

    const matched = await listEphemeralVmRuntimesForWorkspace({
      workspaceId: 'wt-1',
      executionHostId: null
    })

    expect(matched.map((entry) => entry.id)).toEqual(['rt-released', 'rt-reclaimed'])
  })

  it('answers nothing for a workspace no runtime names', async () => {
    listRuntimes.mockResolvedValue([runtime({ id: 'rt-1', workspaceId: 'wt-other' })])

    await expect(
      listEphemeralVmRuntimesForWorkspace({ workspaceId: 'wt-1', executionHostId: null })
    ).resolves.toEqual([])
  })
})
