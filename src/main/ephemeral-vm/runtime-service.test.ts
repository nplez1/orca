import '../../shared/remote-runtime/host-store/environment-store-worker-test-fixture'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  listEphemeralVmRuntimes,
  upsertEphemeralVmRuntime
} from '../../shared/remote-runtime/ephemeral-vm-store/ephemeral-vm-runtime-store'
import { listEphemeralVmProvisioningAttempts } from '../../shared/ephemeral-vm-provisioning-attempts'
import { getEphemeralVmRuntimeFeatureStorePath } from '../../shared/remote-runtime/ephemeral-vm-store/ephemeral-vm-runtime-feature-store'
import { cleanupEphemeralVmRuntime, provisionEphemeralVmRuntime } from './runtime-service'
import { stopEphemeralVmRuntimeCleanup } from './runtime-cleanup-control'
import type { OrcaVmRecipe } from '../../shared/orca-yaml-hook-types'
import { cleanupTempDirs, makeDir, nodeCommand } from './runtime-service.test-harness'

afterEach(cleanupTempDirs)

describe('ephemeral VM runtime service', () => {
  it('stops a hung destroy and starts a fresh retry', async () => {
    const userDataPath = makeDir('orca-ephemeral-vm-service-user-data-')
    const repoPath = makeDir('orca-ephemeral-vm-service-repo-')
    const cleanupPath = join(repoPath, 'cleanup.js')
    const countPath = join(repoPath, 'cleanup-count.txt')
    writeFileSync(
      cleanupPath,
      `require('fs').appendFileSync(${JSON.stringify(countPath)}, 'x'); setInterval(() => {}, 1000)`
    )
    const recipe: OrcaVmRecipe = {
      id: 'cloud-sandbox',
      name: 'Cloud Sandbox',
      create: 'unused',
      destroy: nodeCommand(cleanupPath)
    }
    upsertEphemeralVmRuntime(userDataPath, {
      id: 'runtime-1',
      recipeId: recipe.id,
      recipe,
      status: 'running',
      cleanupStatus: 'not_started',
      createdAt: 1_000,
      updatedAt: 1_000,
      recipeResult: {
        schemaVersion: 1,
        connection: {
          type: 'ssh',
          projectRoot: '/workspace/repo',
          target: { label: 'VM', host: 'host', port: 22, username: 'orca' }
        }
      }
    })
    const cleanupArgs = {
      userDataPath,
      repoPath,
      recipe,
      runtimeId: 'runtime-1'
    }

    const cleanup = cleanupEphemeralVmRuntime(cleanupArgs)
    await vi.waitFor(() => expect(readFileSync(countPath, 'utf8')).toBe('x'))
    const stopping = stopEphemeralVmRuntimeCleanup({ userDataPath, runtimeId: 'runtime-1' })
    expect(stopping).not.toBeNull()
    await expect(stopping).resolves.toMatchObject({
      ok: false,
      runtime: { status: 'cleanup_failed', cleanupStatus: 'failed' },
      error: 'Cleanup stopped by user.'
    })
    await expect(cleanup).resolves.toMatchObject({ ok: false })
    writeFileSync(cleanupPath, `require('fs').appendFileSync(${JSON.stringify(countPath)}, 'x')`)
    await expect(cleanupEphemeralVmRuntime(cleanupArgs)).resolves.toMatchObject({
      ok: true,
      runtime: { status: 'cleaned', cleanupStatus: 'succeeded' }
    })
    expect(readFileSync(countPath, 'utf8')).toBe('xx')
  })

  it('keeps rollback-readable cleanup recovery when post-create destroy also fails', async () => {
    const userDataPath = makeDir('orca-ephemeral-vm-service-user-data-')
    const repoPath = makeDir('orca-ephemeral-vm-service-repo-')
    const startPath = join(repoPath, 'start.js')
    const cleanupPath = join(repoPath, 'cleanup.js')
    const featurePath = getEphemeralVmRuntimeFeatureStorePath(userDataPath)
    writeFileSync(
      startPath,
      [
        `require('fs').writeFileSync(${JSON.stringify(featurePath)}, '{')`,
        'console.log(JSON.stringify({',
        '  schemaVersion: 2,',
        '  checkoutMode: "provisioned-root",',
        '  connection: {',
        '    type: "ssh",',
        '    projectRoot: "/workspace/repo",',
        '    target: { label: "VM", host: "host", port: 22, username: "orca" }',
        '  },',
        '  userData: { providerResourceId: "paid-vm" }',
        '}))'
      ].join('\n')
    )
    writeFileSync(cleanupPath, 'process.exit(1)')

    await expect(
      provisionEphemeralVmRuntime({
        userDataPath,
        repoPath,
        recipe: {
          id: 'cloud-sandbox',
          name: 'Cloud Sandbox',
          checkoutMode: 'provisioned-root',
          create: nodeCommand(startPath),
          destroy: nodeCommand(cleanupPath)
        },
        now: 1_000
      })
    ).rejects.toThrow('Could not preserve ephemeral VM runtime compatibility metadata')
    expect(listEphemeralVmRuntimes(userDataPath)).toEqual([
      expect.objectContaining({
        status: 'cleanup_failed',
        cleanupStatus: 'failed',
        recipe: expect.not.objectContaining({ checkoutMode: expect.anything() }),
        recipeResult: expect.objectContaining({
          schemaVersion: 1,
          userData: { providerResourceId: 'paid-vm' }
        })
      })
    ])
    // Why the row stays: the destroy hook failed, so the machine may still be running and this is the only
    // record naming it.
    expect(listEphemeralVmProvisioningAttempts(userDataPath)).toHaveLength(1)
  })
})
