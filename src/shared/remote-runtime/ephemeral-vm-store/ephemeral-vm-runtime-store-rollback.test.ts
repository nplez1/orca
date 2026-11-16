import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { removeTempDirs } from '../../testing/remove-temp-dirs.test-support'
import { afterEach, describe, expect, it } from 'vitest'
import {
  getEphemeralVmRuntimeStorePath,
  listEphemeralVmRuntimes,
  updateEphemeralVmRuntimeStatus,
  upsertEphemeralVmRuntime
} from './ephemeral-vm-runtime-store'
import { getEphemeralVmRuntimeFeatureStorePath } from './ephemeral-vm-runtime-feature-store'
import { getEphemeralVmWriteAheadRuntimeStorePath } from './ephemeral-vm-runtime-write-ahead-store'
import {
  RollbackEphemeralVmRuntimeStoreSchema,
  type EphemeralVmRuntimeRecord
} from './ephemeral-vm-runtimes'

function runtimeRecord(
  overrides: Partial<EphemeralVmRuntimeRecord> = {}
): EphemeralVmRuntimeRecord {
  return {
    id: 'ordinary-runtime',
    recipeId: 'ordinary-recipe',
    recipe: {
      id: 'ordinary-recipe',
      name: 'Ordinary VM',
      create: './create.sh',
      destroy: './destroy.sh'
    },
    status: 'running',
    cleanupStatus: 'not_started',
    createdAt: 1_000,
    updatedAt: 1_000,
    recipeResult: {
      schemaVersion: 1,
      connection: {
        type: 'ssh',
        projectRoot: '/workspace/ordinary',
        target: {
          label: 'Ordinary VM',
          host: 'ordinary.example.com',
          port: 22,
          username: 'developer'
        }
      },
      userData: { resourceId: 'ordinary-resource' }
    },
    ...overrides
  }
}

function provisionedRootRecord(): EphemeralVmRuntimeRecord {
  return runtimeRecord({
    id: 'provisioned-runtime',
    recipeId: 'provisioned-recipe',
    recipe: {
      id: 'provisioned-recipe',
      name: 'Provisioned VM',
      create: './create.sh',
      destroy: './destroy.sh',
      checkoutMode: 'provisioned-root'
    },
    createdAt: 2_000,
    updatedAt: 2_000,
    recipeResult: {
      schemaVersion: 2,
      checkoutMode: 'provisioned-root',
      connection: {
        type: 'ssh',
        projectRoot: '/workspace/provisioned',
        target: {
          label: 'Provisioned VM',
          host: 'provisioned.example.com',
          port: 22,
          username: 'developer'
        }
      },
      userData: { resourceId: 'provisioned-resource' }
    }
  })
}

describe('ephemeral VM runtime store rollback projection', () => {
  const tempDirs: string[] = []

  afterEach(async () => {
    await removeTempDirs(tempDirs.splice(0))
  })

  function makeUserDataPath(): string {
    const path = mkdtempSync(join(tmpdir(), 'orca-vm-rollback-store-'))
    tempDirs.push(path)
    return path
  }

  it('keeps a mixed store readable by the rollback schema and restores new fields', () => {
    const userDataPath = makeUserDataPath()
    const ordinary = upsertEphemeralVmRuntime(userDataPath, runtimeRecord())
    const provisioned = upsertEphemeralVmRuntime(userDataPath, provisionedRootRecord())

    const persisted = JSON.parse(readFileSync(getEphemeralVmRuntimeStorePath(userDataPath), 'utf8'))
    expect(RollbackEphemeralVmRuntimeStoreSchema.parse(persisted).runtimes).toHaveLength(2)
    expect(persisted.runtimes[0].recipe).not.toHaveProperty('checkoutMode')
    expect(persisted.runtimes[0].recipeResult).toMatchObject({ schemaVersion: 1 })
    expect(listEphemeralVmRuntimes(userDataPath)).toEqual([provisioned, ordinary])
  })

  it('keeps a runtime with both a provisioned root and an extend hook readable by an older build', () => {
    const userDataPath = makeUserDataPath()
    const runtime = runtimeRecord({
      recipe: { ...runtimeRecord().recipe!, checkoutMode: 'orca-worktree' },
      extend: './extend.sh',
      extendDurations: ['1h', '4h', '1d']
    })

    upsertEphemeralVmRuntime(userDataPath, runtime)

    const persisted = JSON.parse(readFileSync(getEphemeralVmRuntimeStorePath(userDataPath), 'utf8'))
    expect(RollbackEphemeralVmRuntimeStoreSchema.safeParse(persisted).success).toBe(true)
    // Why: the recipe snapshot is strict in an older build, so a checkoutMode left in the store file
    // would make every runtime in the file unreadable there. The record itself is not strict, so the
    // extend hook rides along at the top level and a build that predates it simply ignores it.
    expect(persisted.runtimes[0].recipe).not.toHaveProperty('checkoutMode')
    expect(persisted.runtimes[0]).toMatchObject({
      extend: './extend.sh',
      extendDurations: ['1h', '4h', '1d']
    })

    // The sidecar entry must carry nothing but the checkout-mode keys an older build's strict entry
    // schema accepts — adding a newer key here would cost that build the checkout mode as well.
    const sidecar = JSON.parse(
      readFileSync(getEphemeralVmRuntimeFeatureStorePath(userDataPath), 'utf8')
    )
    expect(sidecar.records).toEqual([
      expect.objectContaining({
        id: runtime.id,
        recipeId: runtime.recipeId,
        recipeCheckoutMode: 'orca-worktree'
      })
    ])
    expect(sidecar.records[0]).not.toHaveProperty('recipeExtend')
    expect(sidecar.records[0]).not.toHaveProperty('recipeExtendDurations')

    expect(listEphemeralVmRuntimes(userDataPath)).toEqual([runtime])
  })

  it('restores the extend hook for several runtimes at once', () => {
    const userDataPath = makeUserDataPath()
    const first = runtimeRecord({
      id: 'first-extend-runtime',
      extend: './first.sh',
      extendDurations: ['1h']
    })
    const second = runtimeRecord({
      id: 'second-extend-runtime',
      createdAt: 2_000,
      updatedAt: 2_000,
      extend: './second.sh',
      extendDurations: ['2h', '1d']
    })

    upsertEphemeralVmRuntime(userDataPath, first)
    upsertEphemeralVmRuntime(userDataPath, second)

    expect(listEphemeralVmRuntimes(userDataPath)).toEqual([second, first])
  })

  it('never overwrites a write-ahead file it cannot read', () => {
    const userDataPath = makeUserDataPath()
    upsertEphemeralVmRuntime(userDataPath, runtimeRecord())
    const sidecarPath = getEphemeralVmWriteAheadRuntimeStorePath(userDataPath)
    const unreadable = '{"version":2,"runtimes":[{"id":"from-a-newer-build"}]}'
    writeFileSync(sidecarPath, unreadable)

    // Tracked VMs keep working, and the unreadable records survive the write.
    updateEphemeralVmRuntimeStatus(userDataPath, 'ordinary-runtime', { status: 'suspended' })
    expect(readFileSync(sidecarPath, 'utf8')).toBe(unreadable)

    // A new record that could not be kept is refused before its create starts.
    const { recipeResult: _recipeResult, ...writeAhead } = runtimeRecord({ id: 'new-runtime' })
    expect(() =>
      upsertEphemeralVmRuntime(userDataPath, { ...writeAhead, status: 'provisioning' })
    ).toThrow()
    expect(readFileSync(sidecarPath, 'utf8')).toBe(unreadable)
  })
})
