import { describe, expect, it, vi } from 'vitest'
import { HOST_SETTINGS_REPLICATION_PAYLOAD_VERSION } from '../../shared/host-settings-replication'
import type {
  HostSettingsReplicationPayload,
  ReplicatedHostCredential
} from '../../shared/host-settings-replication'
import type { SecretAtRestProtection } from '../../shared/secret-at-rest-protection'
import {
  createHostSettingsCredentialRegistry,
  type HostSettingsCredentialPort
} from './host-settings-credential-port'
import {
  applyHostSettingsPayload,
  decideHostSettingsPayload
} from './host-settings-replication-receiver'

const CREDENTIAL_ID = 'api-key:deepseek'
const NOW = 1_700_000_000_000

function credential(overrides: Partial<ReplicatedHostCredential> = {}): ReplicatedHostCredential {
  return {
    id: CREDENTIAL_ID,
    kind: CREDENTIAL_ID,
    label: 'DeepSeek API key',
    protection: 'sealed',
    onlyIfEmpty: false,
    payload: 'incoming-key',
    ...overrides
  }
}

function payload(
  overrides: Partial<HostSettingsReplicationPayload> = {}
): HostSettingsReplicationPayload {
  return {
    version: HOST_SETTINGS_REPLICATION_PAYLOAD_VERSION,
    baseRevision: null,
    revision: 7,
    upserts: [credential()],
    removals: [],
    ...overrides
  }
}

/** The bytes a receiving host's store holds, so a test can read them back after an apply. */
type Held = { payload: string | null; protection: SecretAtRestProtection | null }

/** An in-memory stand-in for one credential store on the receiving host. */
function fakePort(
  options: { canSeal?: boolean; existing?: Held } = {}
): HostSettingsCredentialPort & {
  held: Held
} {
  const held: Held = {
    payload: options.existing?.payload ?? null,
    protection: options.existing?.protection ?? null
  }
  return {
    kind: CREDENTIAL_ID,
    held,
    canSeal: () => options.canSeal ?? true,
    protectionOf: (id: string) => (id === CREDENTIAL_ID ? held.protection : null),
    list: () => [],
    apply: (incoming: ReplicatedHostCredential) => {
      held.payload = incoming.payload
      held.protection = 'sealed'
    },
    remove: (id: string) => {
      if (id === CREDENTIAL_ID) {
        held.payload = null
        held.protection = null
      }
    }
  }
}

describe('deciding whether a host may apply a payload', () => {
  it('applies a snapshot to a host that has never synced', () => {
    expect(decideHostSettingsPayload(null, payload())).toEqual({ kind: 'apply' })
  })

  it('applies a delta whose base is the revision this host holds', () => {
    expect(decideHostSettingsPayload(7, payload({ baseRevision: 7, revision: 8 }))).toEqual({
      kind: 'apply'
    })
  })

  it('asks for a snapshot rather than replaying a delta past a gap', () => {
    expect(decideHostSettingsPayload(5, payload({ baseRevision: 7, revision: 8 }))).toEqual({
      kind: 'needsSnapshot',
      reason: 'revisionGap'
    })
  })

  it('asks for a snapshot when a delta names a base this host never reached', () => {
    expect(decideHostSettingsPayload(null, payload({ baseRevision: 7, revision: 8 }))).toEqual({
      kind: 'needsSnapshot',
      reason: 'unknownBase'
    })
  })

  it('refuses a payload version it does not know instead of guessing', () => {
    // Why built inline: a newer main is exactly what sends a version this build has never seen.
    expect(decideHostSettingsPayload(null, { ...payload(), version: 99 })).toEqual({
      kind: 'unsupportedVersion'
    })
  })
})

describe('applying a payload on the receiving host', () => {
  it('stores the credential and reports a clean sync', () => {
    const port = fakePort()
    const { report, state } = applyHostSettingsPayload({
      payload: payload(),
      registry: createHostSettingsCredentialRegistry([port]),
      now: NOW
    })

    expect(port.held.payload).toBe('incoming-key')
    expect(report.outcomes).toEqual({ [CREDENTIAL_ID]: 'applied' })
    expect(state).toEqual({ kind: 'synced', revision: 7, syncedAt: NOW })
  })

  it('refuses a sealed credential on a host that cannot seal, and never reports a clean sync', () => {
    const port = fakePort({ canSeal: false })
    const { report, state } = applyHostSettingsPayload({
      payload: payload(),
      registry: createHostSettingsCredentialRegistry([port]),
      now: NOW
    })

    expect(port.held.payload).toBeNull()
    expect(report.outcomes).toEqual({ [CREDENTIAL_ID]: 'refusedWeakerProtection' })
    expect(state).toEqual({
      kind: 'partial',
      revision: 7,
      syncedAt: NOW,
      refusals: [CREDENTIAL_ID]
    })
  })

  it('replicates a value the host can hold at the same protection', () => {
    const port = fakePort({ canSeal: false })
    const { report } = applyHostSettingsPayload({
      payload: payload({ upserts: [credential({ protection: 'plaintext' })] }),
      registry: createHostSettingsCredentialRegistry([port]),
      now: NOW
    })

    expect(report.outcomes).toEqual({ [CREDENTIAL_ID]: 'applied' })
  })

  it('keeps a deliberate local value when the credential only fills an empty host', () => {
    const port = fakePort({ existing: { payload: 'mine', protection: 'sealed' } })
    const { report, state } = applyHostSettingsPayload({
      payload: payload({ upserts: [credential({ onlyIfEmpty: true })] }),
      registry: createHostSettingsCredentialRegistry([port]),
      now: NOW
    })

    expect(port.held.payload).toBe('mine')
    expect(report.outcomes).toEqual({ [CREDENTIAL_ID]: 'keptHostValue' })
    // Why not `synced`: the host did not receive everything the main sent, and saying otherwise
    // would hide a divergence the user has to be able to see.
    expect(state).toMatchObject({ kind: 'partial', refusals: [CREDENTIAL_ID] })
  })

  it('fills an empty host even when the credential only fills empty hosts', () => {
    const port = fakePort()
    const { report } = applyHostSettingsPayload({
      payload: payload({ upserts: [credential({ onlyIfEmpty: true })] }),
      registry: createHostSettingsCredentialRegistry([port]),
      now: NOW
    })

    expect(port.held.payload).toBe('incoming-key')
    expect(report.outcomes).toEqual({ [CREDENTIAL_ID]: 'applied' })
  })

  it('refuses a credential whose kind this build has no adapter for', () => {
    const { report, state } = applyHostSettingsPayload({
      payload: payload({ upserts: [credential({ id: 'jira:site-1', kind: 'jira' })] }),
      registry: createHostSettingsCredentialRegistry([]),
      now: NOW
    })

    expect(report.outcomes).toEqual({ 'jira:site-1': 'refusedUnknownKind' })
    expect(state).toMatchObject({ kind: 'partial', refusals: ['jira:site-1'] })
  })

  it('removes a revoked credential and proves it is gone', () => {
    const port = fakePort({ existing: { payload: 'old', protection: 'sealed' } })
    const { report, state } = applyHostSettingsPayload({
      payload: payload({ upserts: [], removals: [CREDENTIAL_ID] }),
      registry: createHostSettingsCredentialRegistry([port]),
      now: NOW
    })

    expect(port.held.payload).toBeNull()
    expect(report.outcomes).toEqual({ [CREDENTIAL_ID]: 'removed' })
    expect(state).toMatchObject({ kind: 'synced' })
  })

  it('reports a removal it cannot prove instead of claiming the token is gone', () => {
    const port = fakePort({ existing: { payload: 'stubborn', protection: 'sealed' } })
    port.remove = vi.fn()

    const { report, state } = applyHostSettingsPayload({
      payload: payload({ upserts: [], removals: [CREDENTIAL_ID] }),
      registry: createHostSettingsCredentialRegistry([port]),
      now: NOW
    })

    expect(report.outcomes).toEqual({ [CREDENTIAL_ID]: 'removalUnverified' })
    expect(state).toMatchObject({ kind: 'partial', refusals: [CREDENTIAL_ID] })
  })

  it('resolves an id to the most specific adapter when kinds share a prefix', () => {
    const registry = createHostSettingsCredentialRegistry([
      { ...fakePort(), kind: 'api-key' },
      { ...fakePort(), kind: 'api-key:deepseek:enterprise' }
    ])

    expect(registry.forCredentialId('api-key:deepseek:enterprise')?.kind).toBe(
      'api-key:deepseek:enterprise'
    )
    expect(registry.forCredentialId('api-key:minimax')?.kind).toBe('api-key')
  })
})
