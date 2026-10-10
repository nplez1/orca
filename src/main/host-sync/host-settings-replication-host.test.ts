import { describe, expect, it, vi } from 'vitest'
import { ApplyHostSettingsReplicationParams } from '../../shared/rpc-contract/host-settings-params'
import type { ReplicatedHostCredential } from '../../shared/host-settings-replication'
import { HOST_SETTINGS_METHODS } from '../runtime/rpc/methods/host-settings'
import type { HostSettingsCredentialPort } from './host-settings-credential-port'
import { applyHostSettingsReplication } from './host-settings-replication-host'
import { createInMemoryHostSettingsReplicationHoldings } from './host-settings-replication-holdings'

const CREDENTIAL_ID = 'api-key:deepseek'
const NOW = 1_700_000_000_000

function credential(overrides: Partial<ReplicatedHostCredential> = {}): ReplicatedHostCredential {
  return {
    id: CREDENTIAL_ID,
    kind: CREDENTIAL_ID,
    label: 'DeepSeek API key',
    protection: 'sealed',
    onlyIfEmpty: false,
    payload: 'sk-live',
    ...overrides
  }
}

function snapshot(revision: number, upserts = [credential()], removals: string[] = []) {
  return { version: 1, baseRevision: null, revision, upserts, removals }
}

/**
 * A store that behaves like the real ones: it starts empty, and whether a write lands sealed depends on
 * the host — which is what makes the downgrade path reachable at all.
 */
function fakePort(
  options: { canSeal?: boolean; writeProtection?: 'sealed' | 'plaintext' } = {}
): HostSettingsCredentialPort & { held: Map<string, string> } {
  const held = new Map<string, string>()
  const writeProtection = options.writeProtection ?? 'sealed'
  return {
    kind: CREDENTIAL_ID,
    held,
    canSeal: () => options.canSeal ?? true,
    unreadableIds: () => [],
    protectionOf: (id) => (held.has(id) ? writeProtection : null),
    list: () => [],
    apply: (incoming) => {
      if (incoming.payload === 'explodes') {
        throw new Error('disk full')
      }
      held.set(incoming.id, incoming.payload)
    },
    remove: (id) => {
      held.delete(id)
    }
  }
}

const registry = (port: HostSettingsCredentialPort) => ({ forCredentialId: () => port })

describe('the host-settings RPC surface', () => {
  const apply = HOST_SETTINGS_METHODS.find(
    (method) => method.name === 'hostSettings.applyReplication'
  )
  const state = HOST_SETTINGS_METHODS.find(
    (method) => method.name === 'hostSettings.replicationState'
  )

  it('lets a paired desktop push with the permission it already holds, and a phone nowhere', () => {
    // Why `accounts-admin`: it is in RUNTIME_PAIRED_STANDARD and absent from the mobile allowlist, so
    // the trust boundary is the existing one rather than a new permission nobody has audited.
    expect(apply?.permission).toBe('accounts-admin')
    expect(state?.permission).toBe('workspace')
  })

  it('accepts a version this build does not know, so the refusal can name it', () => {
    const parsed = ApplyHostSettingsReplicationParams.safeParse({
      payload: { ...snapshot(1), version: 2 }
    })

    expect(parsed.success).toBe(true)
  })

  it('bounds what one payload can carry', () => {
    const over = (count: number) => Array.from({ length: count }, () => credential())
    const tooMany = ApplyHostSettingsReplicationParams.safeParse({
      payload: { ...snapshot(1), upserts: over(501) }
    })
    const tooLong = ApplyHostSettingsReplicationParams.safeParse({
      payload: { ...snapshot(1), upserts: [credential({ payload: 'x'.repeat(64_001) })] }
    })
    const unknownCredentialKey = ApplyHostSettingsReplicationParams.safeParse({
      payload: { ...snapshot(1), upserts: [{ ...credential(), surprise: true }] }
    })

    expect(tooMany.success).toBe(false)
    expect(tooLong.success).toBe(false)
    expect(unknownCredentialKey.success).toBe(false)
  })

  it('tolerates an unknown payload key, because a new optional field must be survivable', () => {
    // Why not `.strict()` on the payload: refusing it makes a newer sender's optional field an outage,
    // which is the opposite of what docs/reference/remote-wire-compatibility.md asks for. The credential
    // itself stays strict — an unknown key there would be a field this build silently ignores on a
    // secret.
    expect(
      ApplyHostSettingsReplicationParams.safeParse({
        payload: { ...snapshot(1), aFieldFromANewerMain: true }
      }).success
    ).toBe(true)
  })
})

describe('applying a payload on the host', () => {
  it('refuses a version it does not know, by name, and records nothing', () => {
    const holdings = createInMemoryHostSettingsReplicationHoldings()
    const port = fakePort()

    const result = applyHostSettingsReplication(
      { ...snapshot(1), version: 2 },
      { registry: registry(port), holdings, now: NOW }
    )

    expect(result).toEqual({ decision: 'unsupportedVersion' })
    expect(holdings.read().revision).toBeNull()
    expect(port.held.size).toBe(0)
  })

  it('pins the first main that pushes a snapshot, and refuses a different one', () => {
    const holdings = createInMemoryHostSettingsReplicationHoldings()

    const first = applyHostSettingsReplication(snapshot(1), {
      registry: registry(fakePort()),
      holdings,
      now: NOW,
      callerFingerprint: 'main-a'
    })
    const second = applyHostSettingsReplication(
      { ...snapshot(2), baseRevision: 1 },
      { registry: registry(fakePort()), holdings, now: NOW, callerFingerprint: 'main-b' }
    )

    expect(first).toMatchObject({ decision: 'applied' })
    // Why refuse: without the pin, a second paired desktop could send a removal list and delete the
    // credentials the first one configured.
    expect(second).toEqual({ decision: 'refusedNotTheMain' })
    expect(holdings.read().mainFingerprint).toBe('main-a')
  })

  it('always allows a local owner, which is the user at this machine', () => {
    const holdings = createInMemoryHostSettingsReplicationHoldings()

    applyHostSettingsReplication(snapshot(1), {
      registry: registry(fakePort()),
      holdings,
      now: NOW,
      callerFingerprint: 'main-a'
    })
    const owned = applyHostSettingsReplication(
      { ...snapshot(2), baseRevision: 1 },
      { registry: registry(fakePort()), holdings, now: NOW }
    )

    expect(owned).toMatchObject({ decision: 'applied' })
  })

  it('withdraws a credential the main no longer holds when a snapshot arrives', () => {
    const holdings = createInMemoryHostSettingsReplicationHoldings()
    const port = fakePort()

    applyHostSettingsReplication(snapshot(1), { registry: registry(port), holdings, now: NOW })
    // The main lost the credential, and this host restarted, so the push is a snapshot with no mention
    // of it — which is the only place a removal can travel.
    const result = applyHostSettingsReplication(snapshot(9, []), {
      registry: registry(port),
      holdings,
      now: NOW
    })

    expect(port.held.size).toBe(0)
    expect(result).toMatchObject({ decision: 'applied' })
    expect(holdings.read().ids).toEqual([])
  })

  it('keeps its own revision across a restart, so the next push can be a delta', () => {
    const holdings = createInMemoryHostSettingsReplicationHoldings()

    applyHostSettingsReplication(snapshot(4), {
      registry: registry(fakePort()),
      holdings,
      now: NOW
    })
    // A fresh process reads the same record; the in-memory state above is gone.
    const result = applyHostSettingsReplication(
      { ...snapshot(5), baseRevision: 4 },
      { registry: registry(fakePort()), holdings, now: NOW + 1 }
    )

    expect(result).toMatchObject({ decision: 'applied' })
    expect(holdings.read().revision).toBe(5)
  })

  it('withdraws a value that did not land sealed, rather than leaving the weaker copy', () => {
    const port = fakePort({ canSeal: true, writeProtection: 'plaintext' })

    const result = applyHostSettingsReplication(snapshot(1), {
      registry: registry(port),
      holdings: createInMemoryHostSettingsReplicationHoldings(),
      now: NOW
    })

    expect(result).toMatchObject({
      decision: 'applied',
      report: { outcomes: { [CREDENTIAL_ID]: 'refusedWeakerProtection' } }
    })
    expect(port.held.size).toBe(0)
  })

  it('lets a re-paired or replacement main take the pin with a snapshot, but not with a delta', () => {
    const holdings = createInMemoryHostSettingsReplicationHoldings()

    applyHostSettingsReplication(snapshot(1), {
      registry: registry(fakePort()),
      holdings,
      now: NOW,
      callerFingerprint: 'main-a'
    })

    // Why this must be allowed: the fingerprint is derived from the pairing token, and every new pairing
    // offer mints a fresh one — so re-pairing the same laptop changes it. Refusing forever left a host
    // nothing could ever configure again, silently.
    const replacement = applyHostSettingsReplication(snapshot(2), {
      registry: registry(fakePort()),
      holdings,
      now: NOW,
      callerFingerprint: 'main-b'
    })
    expect(replacement).toMatchObject({ decision: 'applied' })
    expect(holdings.read().mainFingerprint).toBe('main-b')

    // A delta still may not move it, so a second paired client cannot take over by syncing.
    expect(
      applyHostSettingsReplication(
        { ...snapshot(3), baseRevision: 2 },
        { registry: registry(fakePort()), holdings, now: NOW, callerFingerprint: 'main-a' }
      )
    ).toEqual({ decision: 'refusedNotTheMain' })
  })

  it('does not strand a credential the main holds but could not read', () => {
    const holdings = createInMemoryHostSettingsReplicationHoldings()
    const port = fakePort()

    applyHostSettingsReplication(snapshot(1), { registry: registry(port), holdings, now: NOW })
    // The main's keyring was locked, so it named the credential as unreadable rather than absent.
    const result = applyHostSettingsReplication(
      { ...snapshot(2, []), unreadable: [CREDENTIAL_ID] },
      { registry: registry(port), holdings, now: NOW }
    )

    expect(result).toMatchObject({ decision: 'applied' })
    expect(port.held.has(CREDENTIAL_ID)).toBe(true)
    expect(holdings.read().ids).toEqual([CREDENTIAL_ID])
  })

  it('keeps going when one removal fails, and does not claim it is gone', () => {
    const holdings = createInMemoryHostSettingsReplicationHoldings()
    const stubborn = credential({ id: 'api-key:other' })
    const port = fakePort()
    port.held.set(CREDENTIAL_ID, 'old')
    port.held.set('api-key:other', 'stuck')
    port.remove = (id: string) => {
      if (id === 'api-key:other') {
        throw Object.assign(new Error('busy'), { code: 'EBUSY' })
      }
      port.held.delete(id)
    }

    const result = applyHostSettingsReplication(
      { ...snapshot(1, [], [CREDENTIAL_ID, 'api-key:other']) },
      { registry: registry(port), holdings, now: NOW }
    )

    // Why both outcomes matter: an uncaught throw here used to abort the whole apply, so the second
    // removal never ran and the main read the failure as an unreachable host.
    expect(result).toMatchObject({
      decision: 'applied',
      report: {
        outcomes: { [CREDENTIAL_ID]: 'removed', 'api-key:other': 'removalUnverified' }
      }
    })
    expect(stubborn.id).toBe('api-key:other')
    expect(port.held.has('api-key:other')).toBe(true)
    expect(holdings.read().ids).toEqual(['api-key:other'])
  })

  it('reports an adapter that throws without losing the rest of the payload', () => {
    const port = fakePort()
    const second = credential({ id: 'api-key:other' })
    const spy = vi.spyOn(port, 'apply')

    const result = applyHostSettingsReplication(
      snapshot(1, [credential({ payload: 'explodes' }), second]),
      {
        registry: { forCredentialId: () => port },
        holdings: createInMemoryHostSettingsReplicationHoldings(),
        now: NOW
      }
    )

    expect(spy).toHaveBeenCalledTimes(2)
    expect(result).toMatchObject({
      decision: 'applied',
      report: {
        outcomes: { [CREDENTIAL_ID]: 'applyFailed', 'api-key:other': 'applied' }
      }
    })
  })
})
