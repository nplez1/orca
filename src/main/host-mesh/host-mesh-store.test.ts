import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { HostMeshState } from '../../shared/host-mesh/host-mesh-contract'
import { DEFAULT_HOST_MESH_SETTINGS } from '../../shared/host-mesh/host-mesh-admission'
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
    },
    names: { 'key-a': { label: 'Studio', version: 2 } },
    routes: { 'key-a': ['ws://192.168.1.20:6768'] }
  }
}

function storedJson(): Record<string, unknown> {
  const record: Record<string, unknown> = {}
  Object.assign(record, JSON.parse(readFileSync(statePath(), 'utf-8')))
  return record
}

function nestedRecord(parent: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = parent[key]
  const record: Record<string, unknown> = {}
  return value !== null && typeof value === 'object' ? Object.assign(record, value) : record
}

describe('every link a driver can write is a link the store can read back', () => {
  // Why its own temp dir: a test that forgot one wrote `host-mesh.json` into the repository root, and it
  // reached a commit. The store path is derived from the user data directory, so the test must supply one.
  beforeEach(() => {
    testState.dir = mkdtempSync(join(tmpdir(), 'orca-mesh-store-kinds-'))
  })
  afterEach(() => {
    rmSync(testState.dir, { recursive: true, force: true })
  })

  it('round-trips each outbound and inbound kind, so a new one cannot make the file unreadable', () => {
    // Why this exists: adding a link kind without teaching this schema made the store refuse the file its own
    // driver had just written, which reads to the owner as "move it aside to start over" — mid-upgrade.
    const allKinds: HostMeshState = {
      ...groupState(),
      links: {
        outbound: {
          'key-ok': { kind: 'ok' },
          'key-awaiting': { kind: 'awaitingOffer', requestedAtEpoch: 5, expiresAt: 900 },
          'key-failed': { kind: 'redeemFailed', reason: 'offer-expired', attempts: 2, retryAt: 90 },
          'key-unreachable': { kind: 'unreachable', since: 12 },
          'key-unsupported': { kind: 'unsupported', since: 13 }
        },
        inbound: {
          'key-active': { kind: 'active' },
          'key-redeem': { kind: 'awaitingRedeem', expiresAt: 900 },
          'key-absent': { kind: 'absent' }
        }
      }
    }
    store().write(allKinds)

    expect(store().read()).toEqual(allKinds)
  })
})

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

    const peerIndex = nestedRecord(storedJson(), 'peerIndex')
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
      mintedRowIds: [],
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
      // Present and empty: neither of these was minted here, they were adopted from the caller.
      mintedRowIds: [],
      environmentId: 'env-1'
    })
  })

  it('drops revoked rows from the index and keeps every row it was not told about', () => {
    // Why this matters: an entry keeps everything ever minted for that machine so removal can revoke the set, and
    // the mesh minted one row per failed offer. Without this the index grew by one entry per retry forever.
    store().recordPeer('key-a', { deviceRowId: 'row-1', environmentId: 'env-1' })
    store().recordPeer('key-a', { deviceRowId: 'row-2', minted: true })
    store().recordPeer('key-b', { deviceRowId: 'row-3' })

    store().forgetPeerDeviceRows(new Set(['row-2', 'row-3']))

    expect(store().readPeerIndex().get('key-a')).toEqual({
      deviceRowIds: ['row-1'],
      mintedRowIds: [],
      environmentId: 'env-1'
    })
    expect(store().readPeerIndex().get('key-b')).toEqual({
      deviceRowIds: [],
      mintedRowIds: [],
      environmentId: null
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

  it('defaults the group’s settings and round-trips a change', () => {
    expect(store().readSettings()).toEqual(DEFAULT_HOST_MESH_SETTINGS)

    store().writeSettings({ ...DEFAULT_HOST_MESH_SETTINGS, enabled: false })

    expect(store().readSettings()).toEqual({
      ...DEFAULT_HOST_MESH_SETTINGS,
      enabled: false
    })
  })

  it('keeps a setting this build cannot read at its default rather than refusing the group', () => {
    writeFileSync(
      statePath(),
      JSON.stringify({
        version: 1,
        state: null,
        peerIndex: {},
        settings: { enabled: 'yes', futureRule: true }
      }),
      'utf-8'
    )

    expect(store().readSettings()).toEqual(DEFAULT_HOST_MESH_SETTINGS)
  })

  it('keeps the settings across a state write', () => {
    store().writeSettings({ ...DEFAULT_HOST_MESH_SETTINGS, enabled: false })
    store().write(groupState())

    expect(store().readSettings().enabled).toBe(false)
  })
})

describe('the names the group agreed on', () => {
  beforeEach(() => {
    testState.dir = mkdtempSync(join(tmpdir(), 'orca-mesh-store-names-'))
  })
  afterEach(() => {
    rmSync(testState.dir, { recursive: true, force: true })
  })

  it('survives a write and read, so a rename is not undone by the next pass', () => {
    store().write({ ...groupState(), names: { 'key-b': { label: 'Build mini', version: 3 } } })

    expect(store().read()?.names).toEqual({ 'key-b': { label: 'Build mini', version: 3 } })
  })
})

describe('a group written before names existed', () => {
  beforeEach(() => {
    testState.dir = mkdtempSync(join(tmpdir(), 'orca-mesh-store-legacy-'))
  })
  afterEach(() => {
    rmSync(testState.dir, { recursive: true, force: true })
  })

  it('reads back with no names rather than as an unreadable file', () => {
    // Why the file is written by hand: every build before this one wrote exactly this, and the reader has to accept it.
    writeFileSync(
      statePath(),
      JSON.stringify({
        version: 1,
        state: {
          groupId: 'group-1',
          epoch: 7,
          selfKey: 'key-self',
          members: [{ hostKey: 'key-a', label: 'Studio', addedAtEpoch: 3 }],
          tombstones: [],
          links: { outbound: {}, inbound: {} }
        }
      })
    )

    expect(store().read()?.names).toEqual({})
  })
})
