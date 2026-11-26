import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_HOST_MESH_SETTINGS } from '../../shared/host-mesh/host-mesh-admission'
import { readHostMeshSnapshot, updateHostMeshSettings } from './host-mesh-runtime'
import {
  configureHostMeshRuntimeFromApp,
  type HostMeshRuntimeServer
} from './host-mesh-runtime-deps'
import { hostMeshStorePath } from './host-mesh-store'

/**
 * The wiring, not the protocol: does a running app end up with a configured mesh at all.
 *
 * Why the keypair is real and only the server is a stub: `ownKeypair` writes this profile's X25519 key to
 * the userData path, so a snapshot that resolves proves the store and the keypair agree on one directory.
 */

const state = vi.hoisted(() => ({ userDataPath: '' }))

vi.mock('../persistence/loading-store/user-data-path', () => ({
  getCanonicalUserDataPath: () => state.userDataPath
}))

function fakeServer(revoked: string[] = []): HostMeshRuntimeServer {
  const server = {
    revokeRuntimeAccess: (deviceId: string) => {
      revoked.push(deviceId)
      return true
    },
    getDeviceRegistry: () => null
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: without a peer the wiring reaches only these two members.
  return server as unknown as HostMeshRuntimeServer
}

describe('the group in a running app', () => {
  beforeEach(() => {
    state.userDataPath = mkdtempSync(join(tmpdir(), 'orca-host-mesh-app-'))
  })

  afterEach(() => {
    rmSync(state.userDataPath, { recursive: true, force: true })
  })

  it('reports the group as unreachable until the app configures it', () => {
    // The state the panel was stuck in: every entry point refuses rather than reporting no members.
    expect(() => readHostMeshSnapshot()).toThrow('host_mesh_runtime_unavailable')
  })

  it('answers with the real state once the app configures it', async () => {
    configureHostMeshRuntimeFromApp(fakeServer())

    const snapshot = await readHostMeshSnapshot()

    expect(snapshot.inGroup).toBe(false)
    expect(snapshot.members).toEqual([])
    expect(snapshot.settings).toEqual(DEFAULT_HOST_MESH_SETTINGS)
    expect(snapshot.lastError).toBeNull()
    // The driver, not only the deps, is installed: an uninstalled factory throws this instead.
    expect(snapshot.groupId).toBe('')
  })

  it('keeps the group’s settings in the pairing store, not the app’s settings', async () => {
    configureHostMeshRuntimeFromApp(fakeServer())
    await updateHostMeshSettings({ enabled: false })

    const stored: unknown = JSON.parse(readFileSync(hostMeshStorePath(state.userDataPath), 'utf-8'))
    expect(stored).toMatchObject({
      settings: { ...DEFAULT_HOST_MESH_SETTINGS, enabled: false }
    })

    // A second startup pass reads them back rather than starting over at the defaults.
    configureHostMeshRuntimeFromApp(fakeServer())
    expect((await readHostMeshSnapshot()).settings.enabled).toBe(false)
  })

  it('leaves no file behind for a host that never joined', () => {
    configureHostMeshRuntimeFromApp(fakeServer())

    expect(existsSync(hostMeshStorePath(state.userDataPath))).toBe(false)
  })
})
