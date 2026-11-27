import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  listEphemeralVmProvisioningAttempts,
  upsertEphemeralVmProvisioningAttempt
} from '../../../shared/ephemeral-vm-provisioning-attempts'

const testState = vi.hoisted(() => ({ dir: '' }))

vi.mock('electron', () => ({
  app: { getPath: () => testState.dir },
  ipcMain: { handle: () => {}, removeHandler: () => {} }
}))

import {
  EPHEMERAL_VM_RECLAIM_SWEEP_INTERVAL_MS,
  stopEphemeralVmRuntimeReclaim
} from '../../ephemeral-vm-runtime-reclaim'
import { registerLazyEphemeralVmHandlers } from './lazy-ephemeral-vm-handlers'

const STARTED_AT_MS = Date.parse('2026-10-29T12:00:00.000Z') - 60_000

beforeEach(() => {
  testState.dir = mkdtempSync(join(tmpdir(), 'orca-lazy-ephemeral-vm-'))
})

afterEach(() => {
  stopEphemeralVmRuntimeReclaim()
  rmSync(testState.dir, { recursive: true, force: true })
  vi.restoreAllMocks()
})

/**
 * Why this pins the whole point of the lazy registrar: the handler group only loads on the first
 * `ephemeralVm:*` call, so a session that never opens the VM UI must still get the reclaim sweep and
 * the interrupted-create flagging. Neither needs an IPC call here, and nothing else in this test
 * stands in for the fork's code — the flag is read back from the file the startup duty wrote.
 */
describe('fork startup duties', () => {
  it('runs the reclaim sweep and flags a create that never reported, with no ephemeralVm IPC call', () => {
    upsertEphemeralVmProvisioningAttempt(testState.dir, {
      instanceId: 'orca-instance-1',
      recipeId: 'cloud-sandbox',
      repoPath: '/repo',
      repoId: 'repo-1',
      workspaceName: 'Fix Login Race',
      startedAt: STARTED_AT_MS
    })
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval')

    // SAFETY: registration only captures the store for the lazily loaded group, so this test never reads it.
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the group's callback receives the store and this test never invokes it, so no member is read.
    registerLazyEphemeralVmHandlers({} as never)

    expect(setIntervalSpy).toHaveBeenCalledWith(
      expect.any(Function),
      EPHEMERAL_VM_RECLAIM_SWEEP_INTERVAL_MS
    )
    expect(listEphemeralVmProvisioningAttempts(testState.dir)).toEqual([
      expect.objectContaining({ instanceId: 'orca-instance-1', interruptedAt: expect.any(Number) })
    ])
  })
})
