import { describe, expect, it, vi } from 'vitest'
import {
  toRuntimeExecutionHostId,
  toSshExecutionHostId
} from '../../../../../../shared/execution-host'
import type { EphemeralVmRuntimeRecord } from '../../../../../../shared/ephemeral-vm-runtimes'
import { resolveEphemeralHostLease } from './HostSectionHeader'

// Why: the header's menu reaches the whole app store, and this suite only exercises the lease label.
vi.mock('../../HostSectionHeaderMenu', () => ({ HostSectionHeaderMenu: () => null }))

const RUNTIME_HOST_ID = toRuntimeExecutionHostId('env-vm')
const SSH_HOST_ID = toSshExecutionHostId('vm-target-1')

function makeRuntime(overrides: Partial<EphemeralVmRuntimeRecord> = {}): EphemeralVmRuntimeRecord {
  return {
    id: 'runtime-1',
    recipeId: 'cloud-sandbox',
    workspaceId: 'workspace-1',
    runtimeEnvironmentId: 'env-vm',
    status: 'running',
    cleanupStatus: 'not_started',
    createdAt: 1_000,
    updatedAt: 1_000,
    recipeResult: {
      schemaVersion: 1,
      pairingCode: 'orca://pair?code=test',
      projectRoot: '/workspace/repo',
      userData: { releaseAt: '2026-10-13T03:26:41Z', provider: 'fly' }
    },
    ...overrides
  }
}

const NOW_MS = Date.parse('2026-10-13T00:26:41Z')

describe('resolveEphemeralHostLease', () => {
  it('reads the lease of the host the runtime owns', () => {
    expect(resolveEphemeralHostLease([makeRuntime()], RUNTIME_HOST_ID, NOW_MS)).toEqual({
      expired: false,
      remaining: '3h'
    })
  })

  it('finds an SSH-only recipe by its target id', () => {
    const runtime = makeRuntime({ runtimeEnvironmentId: undefined, sshTargetId: 'vm-target-1' })

    expect(resolveEphemeralHostLease([runtime], SSH_HOST_ID, NOW_MS)).toEqual({
      expired: false,
      remaining: '3h'
    })
  })

  it('marks the host expired once its deadline has passed', () => {
    const afterDeadline = Date.parse('2026-10-13T04:26:41Z')

    expect(resolveEphemeralHostLease([makeRuntime()], RUNTIME_HOST_ID, afterDeadline)).toEqual({
      expired: true,
      remaining: '0m'
    })
  })

  it('answers with nothing for another host, or for a released runtime', () => {
    expect(resolveEphemeralHostLease([makeRuntime()], SSH_HOST_ID, NOW_MS)).toBeNull()
    expect(
      resolveEphemeralHostLease(
        [makeRuntime({ cleanupStatus: 'succeeded' })],
        RUNTIME_HOST_ID,
        NOW_MS
      )
    ).toBeNull()
  })

  it('answers with nothing for a reclaimed host, however it is still reachable', () => {
    // Why this case: a reclaim whose SSH-target removal failed leaves `sshTargetId` on the record, so
    // the header still resolves this host on both spellings — and neither may read as an ephemeral
    // lease, because the countdown and the Extend action went with the reclaim.
    const reclaimed = makeRuntime({
      reclaimedAt: 1_700_000_000_000,
      sshTargetId: 'vm-target-1'
    })

    expect(resolveEphemeralHostLease([reclaimed], RUNTIME_HOST_ID, NOW_MS)).toBeNull()
    expect(resolveEphemeralHostLease([reclaimed], SSH_HOST_ID, NOW_MS)).toBeNull()
  })

  it('answers with nothing when the recipe published no deadline', () => {
    const runtime = makeRuntime({
      recipeResult: {
        schemaVersion: 1,
        pairingCode: 'orca://pair?code=test',
        projectRoot: '/workspace/repo'
      }
    })

    expect(resolveEphemeralHostLease([runtime], RUNTIME_HOST_ID, NOW_MS)).toBeNull()
  })
})
