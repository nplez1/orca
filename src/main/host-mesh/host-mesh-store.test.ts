import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { HostMeshState } from '../../shared/host-mesh/host-mesh-contract'
import {
  createHostMeshStore,
  hostMeshStorePath,
  HostMeshStoreUnreadableError,
  MAX_HOST_MESH_STORE_BYTES,
  type HostMeshStore
} from './host-mesh-store'

const testState = { dir: '' }

function store(): HostMeshStore {
  return createHostMeshStore({ userDataPath: testState.dir })
}

function statePath(): string {
  return hostMeshStorePath(testState.dir)
}

function groupState(): HostMeshState {
  return {
    groupId: 'group-1',
    epoch: 7,
    selfKey: 'key-self',
    members: [
      { hostKey: 'key-a', label: 'Studio', addedAtEpoch: 3 },
      { hostKey: 'key-b', label: 'Laptop', introducedBy: 'key-a', addedAtEpoch: 5 }
    ],
    tombstones: [{ hostKey: 'key-gone', epoch: 6, removedBy: 'key-a' }],
    links: {
      outbound: {
        'key-a': { kind: 'ok' },
        'key-b': { kind: 'awaitingOffer', requestedAtEpoch: 5, expiresAt: 900 }
      },
      inbound: { 'key-a': { kind: 'active' }, 'key-b': { kind: 'absent' } }
    }
  }
}

function storedJson(): Record<string, unknown> {
  return JSON.parse(readFileSync(statePath(), 'utf-8'))
}

describe('the group on disk', () => {
  beforeEach(() => {
    testState.dir = mkdtempSync(join(tmpdir(), 'orca-host-mesh-'))
  })

  afterEach(() => {
    rmSync(testState.dir, { recursive: true, force: true })
  })

  it('reads a host with no file as no group', () => {
    expect(store().read()).toBeNull()
  })

  it('round-trips members, tombstones and both link directions', () => {
    const written = groupState()
    store().write(written)

    expect(store().read()).toEqual(written)
  })

  it('throws on a file it cannot parse rather than reading it as no group', () => {
    writeFileSync(statePath(), '{"version": 1, "state": ', 'utf-8')

    expect(() => store().read()).toThrow(HostMeshStoreUnreadableError)
  })

  it('throws on a file whose state is not a shape this build knows', () => {
    writeFileSync(
      statePath(),
      JSON.stringify({ version: 1, state: { groupId: 'group-1' }, peerIndex: {} }),
      'utf-8'
    )

    expect(() => store().read()).toThrow(HostMeshStoreUnreadableError)
  })

  it('carries a peer record this build cannot parse through a rewrite', () => {
    writeFileSync(
      statePath(),
      JSON.stringify({
        version: 1,
        state: null,
        peerIndex: {
          'key-a': { deviceRowIds: ['row-1'], environmentId: 'env-1', mintedBy: 'a-newer-build' },
          'key-b': { deviceRowIds: 'not-an-array' }
        }
      }),
      'utf-8'
    )

    store().write(groupState())

    const peerIndex = storedJson().peerIndex as Record<string, Record<string, unknown>>
    expect(peerIndex['key-a']).toEqual({
      deviceRowIds: ['row-1'],
      environmentId: 'env-1',
      mintedBy: 'a-newer-build'
    })
    expect(peerIndex['key-b']).toEqual({ deviceRowIds: 'not-an-array' })
  })

  it('keeps the index across a state write, and forgets a peer', () => {
    store().recordPeer('key-a', { deviceRowId: 'row-1', environmentId: 'env-1' })
    store().write(groupState())

    expect(store().readPeerIndex().get('key-a')).toEqual({
      deviceRowIds: ['row-1'],
      environmentId: 'env-1'
    })

    store().forgetPeer('key-a')

    expect(store().readPeerIndex().size).toBe(0)
    expect(store().read()).toEqual(groupState())
  })

  it('records a device row once however often it is recorded', () => {
    store().recordPeer('key-a', { deviceRowId: 'row-1' })
    store().recordPeer('key-a', { deviceRowId: 'row-1', environmentId: 'env-1' })
    store().recordPeer('key-a', { deviceRowId: 'row-2' })

    expect(store().readPeerIndex().get('key-a')).toEqual({
      deviceRowIds: ['row-1', 'row-2'],
      environmentId: 'env-1'
    })
  })

  it('treats a file past the byte cap as unreadable rather than loading it', () => {
    writeFileSync(
      statePath(),
      JSON.stringify({
        version: 1,
        state: null,
        peerIndex: {},
        pad: 'x'.repeat(MAX_HOST_MESH_STORE_BYTES)
      }),
      'utf-8'
    )

    expect(() => store().read()).toThrow(HostMeshStoreUnreadableError)
    expect(() => store().readPeerIndex()).toThrow(HostMeshStoreUnreadableError)
  })

  it('refuses to write a state past the byte cap', () => {
    const state = groupState()
    state.members[0].label = 'x'.repeat(MAX_HOST_MESH_STORE_BYTES)

    expect(() => store().write(state)).toThrow()
    expect(store().read()).toBeNull()
  })
})
