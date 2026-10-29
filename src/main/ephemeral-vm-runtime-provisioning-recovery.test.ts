import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  getEphemeralVmProvisioningAttemptsPath,
  listEphemeralVmProvisioningAttempts,
  removeEphemeralVmProvisioningAttempt,
  upsertEphemeralVmProvisioningAttempt,
  type EphemeralVmProvisioningAttempt
} from '../shared/ephemeral-vm-provisioning-attempts'
import { upsertEphemeralVmRuntime } from '../shared/ephemeral-vm-runtime-store'
import type { EphemeralVmRuntimeRecord } from '../shared/ephemeral-vm-runtimes'
import { flagInterruptedEphemeralVmProvisioning } from './ephemeral-vm-runtime-provisioning-recovery'

const NOW_MS = Date.parse('2026-10-29T12:00:00.000Z')

const SSH_CONNECTION = {
  type: 'ssh',
  projectRoot: '/workspace/repo',
  target: { label: 'VM', host: 'host', port: 22, username: 'orca' }
} as const

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

beforeEach(() => {
  vi.restoreAllMocks()
})

function makeDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

function attempt(
  overrides: Partial<EphemeralVmProvisioningAttempt> = {}
): EphemeralVmProvisioningAttempt {
  return {
    instanceId: 'orca-instance-1',
    recipeId: 'cloud-sandbox',
    repoPath: '/repo',
    repoId: 'repo-1',
    workspaceName: 'Fix Login Race',
    startedAt: NOW_MS - 60_000,
    ...overrides
  }
}

function runtimeRecord(id: string): EphemeralVmRuntimeRecord {
  return {
    id,
    recipeId: 'cloud-sandbox',
    repoId: 'repo-1',
    status: 'running',
    cleanupStatus: 'not_started',
    createdAt: NOW_MS - 60_000,
    updatedAt: NOW_MS - 60_000,
    recipeResult: { schemaVersion: 1, connection: SSH_CONNECTION }
  }
}

describe('flagging a create that never reported', () => {
  it('flags the attempt and says a machine may still be running', () => {
    const userDataPath = makeDir('orca-vm-recovery-user-data-')
    upsertEphemeralVmProvisioningAttempt(userDataPath, attempt())
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    const interrupted = flagInterruptedEphemeralVmProvisioning({ userDataPath, now: NOW_MS })

    expect(interrupted).toHaveLength(1)
    expect(interrupted[0]).toMatchObject({
      instanceId: 'orca-instance-1',
      interruptedAt: NOW_MS
    })
    // The flag is durable: startup is not the only reader, and the next process has to see it too.
    expect(listEphemeralVmProvisioningAttempts(userDataPath)).toEqual(interrupted)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0]?.[0]).toContain('never reported')
    expect(warn.mock.calls[0]?.[0]).toContain('orca-instance-1')
    expect(warn.mock.calls[0]?.[0]).toContain('delete it by hand')
  })

  it('drops the attempt when the create did report, because the host is already tracked', () => {
    const userDataPath = makeDir('orca-vm-recovery-reported-')
    upsertEphemeralVmProvisioningAttempt(userDataPath, attempt())
    upsertEphemeralVmRuntime(userDataPath, runtimeRecord('orca-instance-1'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    expect(flagInterruptedEphemeralVmProvisioning({ userDataPath, now: NOW_MS })).toEqual([])

    // The app died between persisting the runtime and clearing the row; nothing is at risk.
    expect(listEphemeralVmProvisioningAttempts(userDataPath)).toEqual([])
    expect(warn).not.toHaveBeenCalled()
  })

  it('reports an already-flagged attempt without warning about it a second time', () => {
    const userDataPath = makeDir('orca-vm-recovery-repeat-')
    upsertEphemeralVmProvisioningAttempt(userDataPath, attempt())
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    flagInterruptedEphemeralVmProvisioning({ userDataPath, now: NOW_MS - 1_000 })
    // Registration re-runs on macOS re-activation, so the second pass has to be quiet.
    const second = flagInterruptedEphemeralVmProvisioning({ userDataPath, now: NOW_MS })

    expect(second).toHaveLength(1)
    // The first interruption is the one that happened, so the later call must not move it.
    expect(second[0]?.interruptedAt).toBe(NOW_MS - 1_000)
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('does nothing when no create was in flight', () => {
    const userDataPath = makeDir('orca-vm-recovery-idle-')

    expect(flagInterruptedEphemeralVmProvisioning({ userDataPath, now: NOW_MS })).toEqual([])
    expect(existsSync(getEphemeralVmProvisioningAttemptsPath(userDataPath))).toBe(false)
  })

  it('survives an unreadable attempt file rather than failing the startup pass', () => {
    const userDataPath = makeDir('orca-vm-recovery-corrupt-')
    // A truncated write is the shape a killed process leaves behind.
    const path = getEphemeralVmProvisioningAttemptsPath(userDataPath)
    rmSync(path, { force: true })
    writeFileSync(path, '{"version":1,"attempts":[{"instanceId":')

    expect(flagInterruptedEphemeralVmProvisioning({ userDataPath, now: NOW_MS })).toEqual([])
    // The unreadable file is left alone rather than rewritten: it is the only trace of that create.
    expect(readFileSync(path, 'utf8')).toBe('{"version":1,"attempts":[{"instanceId":')
  })
})

describe('the attempt store', () => {
  it('keeps one row per instance id and drops the file when the last one settles', () => {
    const userDataPath = makeDir('orca-vm-recovery-store-')
    upsertEphemeralVmProvisioningAttempt(userDataPath, attempt())
    upsertEphemeralVmProvisioningAttempt(
      userDataPath,
      attempt({ instanceId: 'orca-instance-2', startedAt: NOW_MS })
    )
    // A retry of the same create must not leave the first row behind.
    upsertEphemeralVmProvisioningAttempt(userDataPath, attempt({ workspaceName: 'renamed' }))

    const attempts = listEphemeralVmProvisioningAttempts(userDataPath)
    expect(attempts.map((entry) => entry.instanceId)).toEqual([
      'orca-instance-1',
      'orca-instance-2'
    ])
    expect(attempts[0]?.workspaceName).toBe('renamed')

    const stored: unknown = JSON.parse(
      readFileSync(getEphemeralVmProvisioningAttemptsPath(userDataPath), 'utf8')
    )
    expect(stored).toMatchObject({ version: 1 })

    removeEphemeralVmProvisioningAttempt(userDataPath, 'orca-instance-1')
    removeEphemeralVmProvisioningAttempt(userDataPath, 'orca-instance-2')
    // No attempt in flight is the normal state, so the file does not linger to say so.
    expect(existsSync(getEphemeralVmProvisioningAttemptsPath(userDataPath))).toBe(false)
  })
})
