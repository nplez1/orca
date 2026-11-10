import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  listEphemeralVmRuntimes,
  upsertEphemeralVmRuntime
} from '../../shared/ephemeral-vm-runtime-store'
import { resumeEphemeralVmRuntime } from './runtime-service'
import type { OrcaVmRecipe } from '../../shared/orca-yaml-hook-types'
import { cleanupTempDirs, makeDir, nodeCommand } from './runtime-service.test-harness'

afterEach(cleanupTempDirs)

describe('ephemeral VM runtime service resume deadlines', () => {
  const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')

  beforeEach(() => {
    // Isolate lifecycle tests from platform ACL behavior, which secure-file tests cover.
    Object.defineProperty(process, 'platform', { configurable: true, value: 'linux' })
  })

  afterEach(() => {
    if (originalPlatform) {
      Object.defineProperty(process, 'platform', originalPlatform)
    }
  })

  const LEASE_SSH_CONNECTION = {
    type: 'ssh' as const,
    projectRoot: '/workspace/repo',
    target: { label: 'VM', host: 'host', port: 22, username: 'orca' }
  }
  const SEEDED_RELEASE_AT = '2026-10-13T03:00:00Z'

  /** A suspended host holding a lease deadline, plus the resume hook that answers for it. */
  function seedSuspendedLease(printed: string): {
    userDataPath: string
    repoPath: string
    recipe: OrcaVmRecipe
  } {
    const userDataPath = makeDir('orca-ephemeral-vm-service-user-data-')
    const repoPath = makeDir('orca-ephemeral-vm-service-repo-')
    const resumePath = join(repoPath, 'resume.js')
    writeFileSync(resumePath, `console.log(${JSON.stringify(printed)})`)
    const recipe: OrcaVmRecipe = {
      id: 'cloud-sandbox',
      name: 'Cloud Sandbox',
      create: 'unused',
      resume: nodeCommand(resumePath)
    }
    upsertEphemeralVmRuntime(userDataPath, {
      id: 'runtime-1',
      recipeId: recipe.id,
      recipe,
      status: 'suspended',
      connectionMode: 'ssh',
      cleanupStatus: 'not_started',
      createdAt: 1,
      updatedAt: 1,
      recipeResult: {
        schemaVersion: 1,
        connection: LEASE_SSH_CONNECTION,
        userData: { releaseAt: SEEDED_RELEASE_AT }
      }
    })
    return { userDataPath, repoPath, recipe }
  }

  it('rejects a resume whose deadline cannot be read, keeping the stored one', async () => {
    const { userDataPath, repoPath, recipe } = seedSuspendedLease(
      JSON.stringify({
        schemaVersion: 1,
        connection: LEASE_SSH_CONNECTION,
        // Offsetless, so the deadline cannot be read as an instant.
        userData: { releaseAt: '2026-10-13T03:26:41' }
      })
    )

    const resumed = await resumeEphemeralVmRuntime({
      userDataPath,
      repoPath,
      recipe,
      runtimeId: 'runtime-1'
    })

    expect(resumed).toMatchObject({
      ok: false,
      error: expect.stringContaining('userData.releaseAt must be an RFC 3339 timestamp'),
      runtime: { status: 'resume_failed' }
    })
    // The earlier deadline is the only reconciliation Orca has left, so it must survive.
    expect(listEphemeralVmRuntimes(userDataPath)[0].recipeResult).toMatchObject({
      userData: { releaseAt: SEEDED_RELEASE_AT }
    })
  })

  it('rejects a resume that drops the deadline metadata', async () => {
    const { userDataPath, repoPath, recipe } = seedSuspendedLease(
      JSON.stringify({ schemaVersion: 1, connection: LEASE_SSH_CONNECTION })
    )

    const resumed = await resumeEphemeralVmRuntime({
      userDataPath,
      repoPath,
      recipe,
      runtimeId: 'runtime-1'
    })

    expect(resumed).toMatchObject({
      ok: false,
      error:
        'Resume returned no lifetime metadata, which would have discarded the release deadline.',
      runtime: { status: 'resume_failed' }
    })
    expect(listEphemeralVmRuntimes(userDataPath)[0].recipeResult).toMatchObject({
      userData: { releaseAt: SEEDED_RELEASE_AT }
    })
  })

  it('keeps a resume that still reports a deadline', async () => {
    const { userDataPath, repoPath, recipe } = seedSuspendedLease(
      JSON.stringify({
        schemaVersion: 1,
        connection: LEASE_SSH_CONNECTION,
        userData: { releaseAt: '2026-10-13T07:00:00Z' }
      })
    )

    const resumed = await resumeEphemeralVmRuntime({
      userDataPath,
      repoPath,
      recipe,
      runtimeId: 'runtime-1'
    })

    expect(resumed).toMatchObject({
      ok: true,
      runtime: {
        status: 'running',
        recipeResult: { userData: { releaseAt: '2026-10-13T07:00:00Z' } }
      }
    })
  })
})
