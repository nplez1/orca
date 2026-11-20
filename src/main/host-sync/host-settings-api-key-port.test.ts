import { describe, expect, it, vi } from 'vitest'
import type { ReplicatedHostCredential } from '../../shared/host-settings-replication'
import type { SecretAtRestProtection } from '../../shared/secure-storage/secret-at-rest-protection'
import { createHostSettingsApiKeyPort } from './host-settings-api-key-port'
import type { HostSettingsApiKeyStore } from './host-settings-api-key-port'
import { createHostSettingsCredentialRegistry } from './host-settings-credential-port'
import { applyHostSettingsPayload } from './host-settings-replication-receiver'

const ID = 'api-key:deepseek'
const LABEL = 'DeepSeek API key'

/** The store the port adapts, with a readable payload so a test can see what landed. */
type FakeStore = HostSettingsApiKeyStore & { currentPayload: () => string | null }

function fakeStore(
  initial: { payload: string | null; protection: SecretAtRestProtection | null } = {
    payload: null,
    protection: null
  },
  options: { undecodable?: boolean } = {}
): FakeStore {
  let payload = initial.payload
  let protection = initial.protection
  return {
    currentPayload: () => payload,
    has: () => payload !== null,
    read: () => {
      if (options.undecodable && payload !== null) {
        throw new Error('API key could not be decrypted')
      }
      return payload
    },
    save: (key: string) => {
      payload = key
      protection = 'sealed'
    },
    clear: () => {
      payload = null
      protection = null
    },
    protection: () => protection
  }
}

const canSeal = (): boolean => true

const createPort = (store: HostSettingsApiKeyStore) =>
  createHostSettingsApiKeyPort({ kind: ID, id: ID, label: LABEL, store, canSeal })

describe('the provider-key credential port', () => {
  it('lists nothing when the host holds no key', async () => {
    const port = createPort(fakeStore())

    expect(await port.list()).toEqual([])
    expect(await port.protectionOf(ID)).toBeNull()
  })

  it('exports the held key with the protection it actually sits at', async () => {
    const port = createPort(fakeStore({ payload: 'sk-live', protection: 'sealed' }))

    expect(await port.list()).toEqual([
      {
        id: ID,
        kind: ID,
        label: LABEL,
        protection: 'sealed',
        onlyIfEmpty: false,
        payload: 'sk-live'
      }
    ])
  })

  it('adopts an incoming value through the store it owns', async () => {
    const store = fakeStore()
    const port = createPort(store)

    await port.apply({
      id: ID,
      kind: ID,
      label: LABEL,
      protection: 'sealed',
      onlyIfEmpty: false,
      payload: 'sk-incoming'
    })

    expect(store.currentPayload()).toBe('sk-incoming')
  })

  it('clears the key and then reports no protection, which is what proves a removal', async () => {
    const store = fakeStore({ payload: 'sk-live', protection: 'sealed' })
    const port = createPort(store)

    await port.remove(ID)

    expect(store.currentPayload()).toBeNull()
    expect(await port.protectionOf(ID)).toBeNull()
  })

  it('ignores a credential that belongs to another provider', async () => {
    const store = fakeStore({ payload: 'sk-live', protection: 'sealed' })
    const clear = vi.spyOn(store, 'clear')
    const port = createPort(store)

    await port.remove('api-key:minimax')

    expect(clear).not.toHaveBeenCalled()
    expect(await port.protectionOf('api-key:minimax')).toBeNull()
  })

  // Why: "removed" has to mean the bytes are gone. A file that is present but undecodable must
  // still read as held, or revocation reports a success it cannot see.
  it('still reports a key as held when the file is present but undecodable', async () => {
    const port = createPort(
      fakeStore({ payload: 'sk-corrupt', protection: null }, { undecodable: true })
    )

    expect(await port.protectionOf(ID)).toBe('plaintext')
    expect(await port.list()).toEqual([])
  })
})

function incoming(payload: string): ReplicatedHostCredential {
  return {
    id: ID,
    kind: ID,
    label: LABEL,
    protection: 'sealed',
    onlyIfEmpty: false,
    payload
  }
}

describe('a provider key the user entered on the host', () => {
  it('keeps the host key when replication has never written this id', async () => {
    const store = fakeStore({ payload: 'sk-mine', protection: 'sealed' })
    const port = createPort(store)

    const { report, state } = await applyHostSettingsPayload({
      payload: {
        version: 1,
        baseRevision: null,
        revision: 3,
        upserts: [incoming('sk-laptop')],
        removals: []
      },
      registry: createHostSettingsCredentialRegistry([port]),
      replicatedIds: [],
      now: 1
    })

    expect(store.currentPayload()).toBe('sk-mine')
    expect(report.outcomes).toEqual({ [ID]: 'keptHostValue' })
    expect(state).toMatchObject({ kind: 'partial' })
  })

  // Why the other half: a value replication did put here is the main's to update, so the guard must
  // not turn into "a host key is never replaced" — that would strand a rotated key forever.
  it('replaces the host copy once replication owns that id', async () => {
    const store = fakeStore({ payload: 'sk-old', protection: 'sealed' })
    const port = createPort(store)

    const { report } = await applyHostSettingsPayload({
      payload: {
        version: 1,
        baseRevision: null,
        revision: 4,
        upserts: [incoming('sk-rotated')],
        removals: []
      },
      registry: createHostSettingsCredentialRegistry([port]),
      replicatedIds: [ID],
      now: 1
    })

    expect(store.currentPayload()).toBe('sk-rotated')
    expect(report.outcomes).toEqual({ [ID]: 'applied' })
  })
})
