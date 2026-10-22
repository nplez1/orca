import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { listEphemeralVmRuntimes } from '../shared/ephemeral-vm-runtime-store'
import { cleanupFailedEphemeralVmStart } from './ephemeral-vm/failed-start-cleanup'

const ownedDirs: string[] = []

function makeUserDataPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'orca-vm-failed-start-'))
  ownedDirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of ownedDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

const SSH_CONNECTION = {
  type: 'ssh' as const,
  projectRoot: '/workspace/repo',
  target: { label: 'box', host: 'box.example.com', port: 22, username: 'developer' }
}

function failedStart(instanceId: string): {
  context: { instanceId: string; recipeId: string; repoPath: string }
  recipeResult: {
    schemaVersion: 1
    connection: typeof SSH_CONNECTION
    userData: { resourceId: string }
  }
} {
  return {
    context: { instanceId, recipeId: 'cloud-sandbox', repoPath: process.cwd() },
    recipeResult: {
      schemaVersion: 1,
      connection: SSH_CONNECTION,
      userData: { resourceId: 'res-1' }
    }
  }
}

/**
 * The failed-start path writes a recovery record through the same strict snapshot schema as the
 * provision path, so a recipe declaring `extend` has to survive it too.
 *
 * Why this is worth its own test: a throw here happens *after* the provider has billed for a machine
 * and leaves it with no Cleanup row — the exact untracked paid lease the lifetime contract exists to
 * prevent. `destroy: none` reaches this path for every failed start, which is a likely pairing with
 * a recipe whose provider sells extensions.
 */
describe('cleanupFailedEphemeralVmStart', () => {
  it('records a failed start for a recipe that declares extend and disables destroy', async () => {
    const userDataPath = makeUserDataPath()
    const cleaned = await cleanupFailedEphemeralVmStart(
      {
        userDataPath,
        repoPath: process.cwd(),
        recipe: {
          id: 'cloud-sandbox',
          name: 'Cloud Sandbox',
          create: './create.sh',
          destroyDisabled: true,
          extend: './extend.sh',
          extendDurations: ['1h', '4h']
        }
      },
      failedStart('orca-failed-start-1')
    )

    expect(cleaned).toBe(false)
    const record = listEphemeralVmRuntimes(userDataPath)[0]
    expect(record).toMatchObject({
      id: 'orca-failed-start-1',
      status: 'cleanup_failed',
      cleanupStatus: 'disabled',
      extend: './extend.sh',
      extendDurations: ['1h', '4h']
    })
    // Why the snapshot: it is the strict schema, so the extend fields must not have been written into it.
    expect(record?.recipe).toEqual({
      id: 'cloud-sandbox',
      name: 'Cloud Sandbox',
      create: './create.sh',
      destroyDisabled: true
    })
  })

  it('records a failed start for a recipe that declares extend and no hook at all', async () => {
    const userDataPath = makeUserDataPath()
    await cleanupFailedEphemeralVmStart(
      {
        userDataPath,
        repoPath: process.cwd(),
        recipe: {
          id: 'cloud-sandbox',
          name: 'Cloud Sandbox',
          create: './create.sh',
          destroyDisabled: true
        }
      },
      failedStart('orca-failed-start-2')
    )

    const record = listEphemeralVmRuntimes(userDataPath)[0]
    expect(record?.extend).toBeUndefined()
    expect(record?.extendDurations).toBeUndefined()
  })
})
