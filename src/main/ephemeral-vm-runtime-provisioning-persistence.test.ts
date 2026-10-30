import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  getEphemeralVmProvisioningAttemptsPath,
  listEphemeralVmProvisioningAttempts
} from '../shared/ephemeral-vm-provisioning-attempts'
import {
  getEphemeralVmRuntimeStorePath,
  listEphemeralVmRuntimes
} from '../shared/ephemeral-vm-runtime-store'
import { parseOrcaYaml } from '../shared/orca-yaml'
import type { OrcaVmRecipe } from '../shared/orca-yaml-hook-types'
import { provisionEphemeralVmRuntime } from './ephemeral-vm/runtime-provisioning'

const RELEASE_AT = '2026-06-01T13:00:00.000Z'

const SSH_CONNECTION = {
  type: 'ssh',
  projectRoot: '/workspace/repo',
  target: { label: 'VM', host: 'host', port: 22, username: 'orca' }
}

/** The shape orca.yaml produces, so the snapshot is exercised against a real parsed recipe. */
const RECIPE_YAML = [
  'environmentRecipes:',
  '  - id: cloud-sandbox',
  '    name: Cloud Sandbox',
  '    create: ./scripts/orca-vm/start.sh',
  '    extend: ./scripts/orca-vm/extend.sh',
  '    extendDurations: [1h, 4h]'
].join('\n')

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

function makeDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

function nodeCommand(scriptPath: string): string {
  return `"${process.execPath}" "${scriptPath}"`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasOwnKey(value: unknown, key: string): boolean {
  return isRecord(value) && Object.hasOwn(value, key)
}

/** The record as it sits on disk, so the assertion is about what was written, not what was parsed. */
function rawRuntimeRecord(userDataPath: string): Record<string, unknown> {
  const store: unknown = JSON.parse(
    readFileSync(getEphemeralVmRuntimeStorePath(userDataPath), 'utf8')
  )
  if (!isRecord(store) || !Array.isArray(store.runtimes) || !isRecord(store.runtimes[0])) {
    throw new Error('Unexpected ephemeral VM runtime store shape.')
  }
  return store.runtimes[0]
}

function parsedRecipe(): OrcaVmRecipe {
  const recipe = parseOrcaYaml(RECIPE_YAML)?.environmentRecipes?.[0]
  if (!recipe) {
    throw new Error('Fixture orca.yaml did not parse to a recipe.')
  }
  return recipe
}

/** Writes a create script that marks the machine as created before it reports its result. */
function writeCreateScript(repoPath: string): { command: string; markerPath: string } {
  const scriptPath = join(repoPath, 'create.js')
  const markerPath = join(repoPath, 'created.txt')
  writeFileSync(
    scriptPath,
    [
      `require('node:fs').writeFileSync(${JSON.stringify(markerPath)}, 'created')`,
      `console.log(${JSON.stringify(
        JSON.stringify({
          schemaVersion: 1,
          connection: SSH_CONNECTION,
          userData: { releaseAt: RELEASE_AT }
        })
      )})`
    ].join('\n')
  )
  return { command: nodeCommand(scriptPath), markerPath }
}

describe('persisting a provisioned ephemeral VM runtime', () => {
  it('keeps the recipe snapshot parsable when the recipe declares extend', async () => {
    const userDataPath = makeDir('orca-vm-provisioning-user-data-')
    const repoPath = makeDir('orca-vm-provisioning-repo-')
    const create = writeCreateScript(repoPath)
    const recipe: OrcaVmRecipe = {
      ...parsedRecipe(),
      create: create.command,
      extend: nodeCommand(join(repoPath, 'extend.js'))
    }

    const provisioned = await provisionEphemeralVmRuntime({
      userDataPath,
      repoPath,
      recipe,
      repoId: 'repo-1',
      projectId: 'project-1',
      workspaceName: 'Fix Login Race',
      now: 1_000
    })

    // The provider has already created and billed for this machine by the time persistence runs, so
    // a write that rejects leaves it untracked.
    expect(existsSync(create.markerPath)).toBe(true)
    expect(provisioned.ok).toBe(true)
    if (!provisioned.ok) {
      throw new Error(provisioned.start.error)
    }

    const persisted = listEphemeralVmRuntimes(userDataPath)[0]
    expect(persisted.extend).toBe(recipe.extend)
    expect(persisted.extendDurations).toEqual(['1h', '4h'])
    expect(persisted.recipe?.id).toBe('cloud-sandbox')

    const raw = rawRuntimeRecord(userDataPath)
    expect(raw.extend).toBe(recipe.extend)
    expect(raw.extendDurations).toEqual(['1h', '4h'])
    // The extend fields live on the record, never inside the strict lifecycle snapshot: an older
    // build has to keep reading that snapshot, and a strict parse rejection here costs a machine.
    expect(hasOwnKey(raw.recipe, 'extend')).toBe(false)
    expect(hasOwnKey(raw.recipe, 'extendDurations')).toBe(false)
    expect(raw.recipe).toMatchObject({ id: 'cloud-sandbox', create: create.command })
  })

  it('persists no extend keys for a recipe that declares none', async () => {
    const userDataPath = makeDir('orca-vm-provisioning-plain-user-data-')
    const repoPath = makeDir('orca-vm-provisioning-plain-repo-')
    const create = writeCreateScript(repoPath)
    const recipe: OrcaVmRecipe = { ...parsedRecipe(), create: create.command }
    delete recipe.extend
    delete recipe.extendDurations

    const provisioned = await provisionEphemeralVmRuntime({
      userDataPath,
      repoPath,
      recipe,
      repoId: 'repo-1',
      now: 1_000
    })

    expect(provisioned.ok).toBe(true)
    const raw = rawRuntimeRecord(userDataPath)
    expect(hasOwnKey(raw, 'extend')).toBe(false)
    expect(hasOwnKey(raw, 'extendDurations')).toBe(false)
    expect(raw.recipe).toMatchObject({ id: 'cloud-sandbox' })
  })
})

describe('a create that has not reported yet', () => {
  /**
   * A create that, mid-run, copies the attempt store and its own `ORCA_VM_INSTANCE_ID`. That is the
   * only way to observe the ordering this fix is about: the record has to exist while the hook is
   * still running, before any recipe result has come back.
   */
  function writeInspectingCreateScript(
    repoPath: string,
    userDataPath: string
  ): {
    command: string
    seenPath: string
    attemptsSnapshotPath: string
  } {
    const scriptPath = join(repoPath, 'create.js')
    const seenPath = join(repoPath, 'seen-instance.txt')
    const attemptsSnapshotPath = join(repoPath, 'attempts-at-create.json')
    writeFileSync(
      scriptPath,
      [
        "const fs = require('node:fs')",
        `fs.writeFileSync(${JSON.stringify(seenPath)}, process.env.ORCA_VM_INSTANCE_ID)`,
        `fs.copyFileSync(${JSON.stringify(getEphemeralVmProvisioningAttemptsPath(userDataPath))}, ${JSON.stringify(attemptsSnapshotPath)})`,
        `console.log(${JSON.stringify(
          JSON.stringify({
            schemaVersion: 1,
            connection: SSH_CONNECTION,
            userData: { releaseAt: RELEASE_AT }
          })
        )})`
      ].join('\n')
    )
    return { command: nodeCommand(scriptPath), seenPath, attemptsSnapshotPath }
  }

  it('is recorded before the hook runs, keyed by the id the hook is given', async () => {
    const userDataPath = makeDir('orca-vm-attempt-user-data-')
    const repoPath = makeDir('orca-vm-attempt-repo-')
    const create = writeInspectingCreateScript(repoPath, userDataPath)

    const provisioned = await provisionEphemeralVmRuntime({
      userDataPath,
      repoPath,
      recipe: { ...parsedRecipe(), create: create.command },
      repoId: 'repo-1',
      workspaceName: 'Fix Login Race',
      now: 1_000
    })

    expect(provisioned.ok).toBe(true)
    if (!provisioned.ok) {
      throw new Error(provisioned.start.error)
    }

    const instanceId = readFileSync(create.seenPath, 'utf8')
    // The hook was told which id its machine is filed under...
    expect(instanceId).toMatch(/^orca-/)
    // ...and that id was already on disk, with the workspace it was bought for, while it ran.
    const duringCreate: unknown = JSON.parse(readFileSync(create.attemptsSnapshotPath, 'utf8'))
    expect(duringCreate).toMatchObject({
      version: 1,
      attempts: [
        {
          instanceId,
          recipeId: 'cloud-sandbox',
          repoPath,
          repoId: 'repo-1',
          workspaceName: 'Fix Login Race',
          startedAt: 1_000
        }
      ]
    })
    // The runtime takes that same id, so the attempt and the record it becomes cannot be confused.
    expect(provisioned.runtime.id).toBe(instanceId)
    // And the attempt is gone once the record exists: an interrupted create is the only thing this
    // file is allowed to hold.
    expect(listEphemeralVmProvisioningAttempts(userDataPath)).toEqual([])
  })

  it('is dropped when the create reports a failure, because the user sees that failure', async () => {
    const userDataPath = makeDir('orca-vm-attempt-fail-user-data-')
    const repoPath = makeDir('orca-vm-attempt-fail-repo-')
    const scriptPath = join(repoPath, 'create.js')
    writeFileSync(scriptPath, 'process.exit(4)\n')

    const provisioned = await provisionEphemeralVmRuntime({
      userDataPath,
      repoPath,
      recipe: { ...parsedRecipe(), create: nodeCommand(scriptPath) },
      repoId: 'repo-1',
      now: 1_000
    })

    expect(provisioned.ok).toBe(false)
    expect(listEphemeralVmProvisioningAttempts(userDataPath)).toEqual([])
    expect(existsSync(getEphemeralVmProvisioningAttemptsPath(userDataPath))).toBe(false)
  })

  it('keeps the row when the create was killed, because nobody saw its transcript', async () => {
    // Why: a cancelled create's release has only the five seconds before Orca force-kills the process
    // group, so the destroy it started may never have finished — and the kill means the user never saw
    // the failure either. This row is what a later startup has to go on.
    const userDataPath = makeDir('orca-vm-attempt-abort-user-data-')
    const repoPath = makeDir('orca-vm-attempt-abort-repo-')
    const scriptPath = join(repoPath, 'create.js')
    writeFileSync(scriptPath, 'setTimeout(() => undefined, 30_000)\n')

    const provisioned = await provisionEphemeralVmRuntime({
      userDataPath,
      repoPath,
      recipe: { ...parsedRecipe(), create: nodeCommand(scriptPath) },
      repoId: 'repo-1',
      now: 1_000,
      signal: AbortSignal.timeout(200)
    })

    expect(provisioned.ok).toBe(false)
    if (provisioned.ok) {
      throw new Error('expected the cancelled create to fail')
    }
    expect(provisioned.start.aborted).toBe(true)
    expect(listEphemeralVmProvisioningAttempts(userDataPath)).toHaveLength(1)
    expect(listEphemeralVmProvisioningAttempts(userDataPath)[0]).toMatchObject({
      recipeId: 'cloud-sandbox',
      repoId: 'repo-1',
      startedAt: 1_000
    })
  })
})
