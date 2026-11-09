import { beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  HostSettingsApplyOutcome,
  HostSettingsReplicationPayload
} from '../../shared/host-settings-replication'
import type { HostSettingsCredentialPort } from './host-settings-credential-port'
import { createInMemoryHostSettingsReplicationHoldings } from './host-settings-replication-holdings'
import {
  applyHostSettingsReplication,
  getHostSettingsReplication,
  resetHostSettingsReplication
} from './host-settings-replication-host'
import { createHostSettingsReplicationPublisher } from './host-settings-replication-publisher'
import type {
  HostSettingsReplicationSendResult,
  HostSettingsReplicationTransport
} from './host-settings-replication-publisher'

const CREDENTIAL_ID = 'api-key:deepseek'

function port(held: boolean): HostSettingsCredentialPort {
  return {
    kind: CREDENTIAL_ID,
    canSeal: () => true,
    unreadableIds: () => [],
    protectionOf: () => (held ? 'sealed' : null),
    list: () =>
      held
        ? [
            {
              id: CREDENTIAL_ID,
              kind: CREDENTIAL_ID,
              label: 'DeepSeek API key',
              protection: 'sealed',
              onlyIfEmpty: false,
              payload: 'sk-live'
            }
          ]
        : [],
    apply: () => {},
    remove: () => {}
  }
}

const HOST = 'env-1'

/** A host that accepts everything, so the publisher's bookkeeping is what is under test. */
function acceptingTransport(
  override: (
    payload: HostSettingsReplicationPayload
  ) => HostSettingsReplicationSendResult | null = () => null
): HostSettingsReplicationTransport & { sent: HostSettingsReplicationPayload[] } {
  const sent: HostSettingsReplicationPayload[] = []
  return {
    sent,
    send: async (_environmentId, payload) => {
      sent.push(payload)
      const overridden = override(payload)
      if (overridden !== null) {
        return overridden
      }
      const outcomes: Record<string, HostSettingsApplyOutcome> = {}
      for (const credential of payload.upserts) {
        outcomes[credential.id] = 'applied'
      }
      for (const id of payload.removals) {
        outcomes[id] = 'removed'
      }
      return {
        kind: 'applied',
        report: { revision: payload.revision, outcomes },
        state: { kind: 'synced', revision: payload.revision, syncedAt: 1 }
      }
    }
  }
}

/**
 * A main-side port whose credential can become unreadable, the way a locked keyring makes it.
 *
 * Why the switch rather than a fixed port: the issue's repro needs the id present in `unreadable` while
 * absent from `upserts`, which is exactly what a main that cannot read its own keyring reports.
 */
function readablePort(state: {
  value: string | null
  readable: boolean
}): HostSettingsCredentialPort {
  return {
    kind: CREDENTIAL_ID,
    canSeal: () => true,
    unreadableIds: () => (state.value !== null && !state.readable ? [CREDENTIAL_ID] : []),
    protectionOf: () => (state.value === null ? null : 'sealed'),
    list: () =>
      state.value === null || !state.readable
        ? []
        : [
            {
              id: CREDENTIAL_ID,
              kind: CREDENTIAL_ID,
              label: 'DeepSeek API key',
              protection: 'sealed',
              onlyIfEmpty: false,
              payload: state.value
            }
          ],
    apply: () => {},
    remove: () => {}
  }
}

/**
 * A host as a build before this fix behaves: it keeps a value it already holds, and deletes whatever
 * `removals` names.
 *
 * Why model the old behaviour instead of the fixed one: the main must not rely on a host filtering its
 * own removals, because a host still on the older build does not.
 */
function olderHostTransport(host: { value: string | null }): HostSettingsReplicationTransport & {
  sent: HostSettingsReplicationPayload[]
} {
  const sent: HostSettingsReplicationPayload[] = []
  return {
    sent,
    send: async (_environmentId, payload) => {
      sent.push(payload)
      const outcomes: Record<string, HostSettingsApplyOutcome> = {}
      for (const credential of payload.upserts) {
        if (host.value === null) {
          host.value = credential.payload
          outcomes[credential.id] = 'applied'
        } else {
          outcomes[credential.id] = 'keptHostValue'
        }
      }
      for (const id of payload.removals) {
        host.value = null
        outcomes[id] = 'removed'
      }
      return {
        kind: 'applied',
        report: { revision: payload.revision, outcomes },
        state: { kind: 'synced', revision: payload.revision, syncedAt: 1 }
      }
    }
  }
}

describe('publishing to a paired host', () => {
  it('never names an unreadable credential the host did not take, so the host keeps its own', async () => {
    const main: { value: string | null; readable: boolean } = { value: 'sk-main', readable: true }
    const host: { value: string | null } = { value: 'sk-host-own' }
    const transport = olderHostTransport(host)
    const publisher = createHostSettingsReplicationPublisher({
      ports: [readablePort(main)],
      transport
    })

    await publisher.publish(HOST, 'attach')
    // The main's keyring locks, so it can name the id but not read it.
    main.readable = false
    await publisher.publish(HOST, 'changed')
    // The user then deletes the credential on the main, and the next delta is what carries the removal.
    main.value = null
    await publisher.publish(HOST, 'changed')

    // Why this must stay empty: the host's value is the user's own, and a host on the older build deletes
    // whatever a removal names — which is the issue's repro.
    expect(transport.sent[2]?.removals).toEqual([])
    expect(host.value).toBe('sk-host-own')
  })

  it('still names an unreadable credential the host does hold, so a later deletion reaches it', async () => {
    const main: { value: string | null; readable: boolean } = { value: 'sk-main', readable: true }
    const host: { value: string | null } = { value: null }
    const transport = olderHostTransport(host)
    const publisher = createHostSettingsReplicationPublisher({
      ports: [readablePort(main)],
      transport
    })

    await publisher.publish(HOST, 'attach')
    expect(host.value).toBe('sk-main')
    main.readable = false
    await publisher.publish(HOST, 'changed')
    main.value = null
    await publisher.publish(HOST, 'changed')

    // Why the removal must still travel: dropping every unreadable id would leave a revoked credential on
    // a host that really holds it, which is the loss the carry exists to prevent.
    expect(transport.sent[2]?.removals).toEqual([CREDENTIAL_ID])
    expect(host.value).toBeNull()
  })

  it('sends a snapshot when a host has just been attached', async () => {
    const transport = acceptingTransport()
    const publisher = createHostSettingsReplicationPublisher({ ports: [port(true)], transport })

    const outcome = await publisher.publish(HOST, 'attach')

    expect(transport.sent[0]?.baseRevision).toBeNull()
    expect(outcome).toMatchObject({ kind: 'synced', revision: 1 })
    expect(publisher.readLedger().hostsByCredential[CREDENTIAL_ID]).toEqual([HOST])
  })

  it('sends a delta based on the revision the host already applied', async () => {
    const transport = acceptingTransport()
    const publisher = createHostSettingsReplicationPublisher({ ports: [port(true)], transport })

    await publisher.publish(HOST, 'attach')
    await publisher.publish(HOST, 'changed')

    expect(transport.sent[1]).toMatchObject({ baseRevision: 1, revision: 2 })
  })

  it('sends a snapshot to a host that was never attached, even on a change', async () => {
    const transport = acceptingTransport()
    const publisher = createHostSettingsReplicationPublisher({ ports: [port(true)], transport })

    await publisher.publish(HOST, 'changed')

    expect(transport.sent[0]?.baseRevision).toBeNull()
  })

  it('reports what the host removed only when the host confirmed it is gone', async () => {
    const transport = acceptingTransport()
    const held = { value: true }
    const publisher = createHostSettingsReplicationPublisher({
      ports: [
        {
          ...port(true),
          list: () =>
            held.value
              ? [
                  {
                    id: CREDENTIAL_ID,
                    kind: CREDENTIAL_ID,
                    label: 'DeepSeek API key',
                    protection: 'sealed',
                    onlyIfEmpty: false,
                    payload: 'sk-live'
                  }
                ]
              : []
        }
      ],
      transport
    })

    await publisher.publish(HOST, 'attach')
    held.value = false
    await publisher.publish(HOST, 'changed')

    expect(transport.sent[1]?.removals).toEqual([CREDENTIAL_ID])
    expect(publisher.readLedger().hostsByCredential[CREDENTIAL_ID]).toBeUndefined()
  })

  it('keeps the holding when the host reports a removal it could not verify', async () => {
    const held = { value: true }
    const transport = acceptingTransport((payload) => {
      if (payload.removals.length === 0) {
        return null
      }
      return {
        kind: 'applied',
        report: {
          revision: payload.revision,
          outcomes: Object.fromEntries(payload.removals.map((id) => [id, 'removalUnverified']))
        },
        state: {
          kind: 'partial',
          revision: payload.revision,
          syncedAt: 1,
          refusals: [...payload.removals]
        }
      }
    })
    const publisher = createHostSettingsReplicationPublisher({
      ports: [
        {
          ...port(true),
          list: () =>
            held.value
              ? [
                  {
                    id: CREDENTIAL_ID,
                    kind: CREDENTIAL_ID,
                    label: 'DeepSeek API key',
                    protection: 'sealed',
                    onlyIfEmpty: false,
                    payload: 'sk-live'
                  }
                ]
              : []
        }
      ],
      transport
    })

    await publisher.publish(HOST, 'attach')
    held.value = false
    const outcome = await publisher.publish(HOST, 'changed')

    expect(outcome.kind).toBe('partial')
    // Why kept: the token is still there, so the next disconnect must try this host again.
    expect(publisher.readLedger().hostsByCredential[CREDENTIAL_ID]).toEqual([HOST])
  })

  it('keeps a removal the host could not verify in the next payload, so it is retried', async () => {
    const held = { value: true }
    const transport = acceptingTransport((payload) => {
      if (payload.removals.length === 0) {
        return null
      }
      return {
        kind: 'applied',
        report: {
          revision: payload.revision,
          outcomes: Object.fromEntries(payload.removals.map((id) => [id, 'removalUnverified']))
        },
        state: {
          kind: 'partial',
          revision: payload.revision,
          syncedAt: 1,
          refusals: [...payload.removals]
        }
      }
    })
    const publisher = createHostSettingsReplicationPublisher({
      ports: [
        {
          ...port(true),
          list: () =>
            held.value
              ? [
                  {
                    id: CREDENTIAL_ID,
                    kind: CREDENTIAL_ID,
                    label: 'DeepSeek API key',
                    protection: 'sealed',
                    onlyIfEmpty: false,
                    payload: 'sk-live'
                  }
                ]
              : []
        }
      ],
      transport
    })

    await publisher.publish(HOST, 'attach')
    held.value = false
    await publisher.publish(HOST, 'changed')
    await publisher.publish(HOST, 'changed')

    // Why it must be re-sent: otherwise a host that stays connected for days keeps a credential the
    // user has revoked, and the main reports `synced` while it is still there.
    expect(transport.sent[2]?.removals).toEqual([CREDENTIAL_ID])
  })

  it('never records a credential the host refused to hold', async () => {
    const transport = acceptingTransport(() => ({
      kind: 'applied',
      report: { revision: 1, outcomes: { [CREDENTIAL_ID]: 'refusedWeakerProtection' } },
      state: { kind: 'partial', revision: 1, syncedAt: 1, refusals: [CREDENTIAL_ID] }
    }))
    const publisher = createHostSettingsReplicationPublisher({ ports: [port(true)], transport })

    const outcome = await publisher.publish(HOST, 'attach')

    expect(outcome.kind).toBe('partial')
    expect(publisher.readLedger().hostsByCredential).toEqual({})
  })

  it('leaves the host record alone when the host cannot be reached', async () => {
    const reachable = { value: true }
    const transport = acceptingTransport(() =>
      reachable.value ? null : { kind: 'unreachable', detail: 'no route' }
    )
    const publisher = createHostSettingsReplicationPublisher({
      ports: [port(true)],
      transport
    })

    await publisher.publish(HOST, 'attach')
    reachable.value = false
    expect(await publisher.publish(HOST, 'changed')).toMatchObject({ kind: 'unreachable' })

    reachable.value = true
    await publisher.publish(HOST, 'changed')

    // Why still based on 1: the unreachable send never landed, so the host is still at revision 1.
    expect(transport.sent[2]?.baseRevision).toBe(1)
  })

  it('falls back to a snapshot when the host refuses a delta, at a fresh revision', async () => {
    const transport = acceptingTransport((payload) =>
      payload.baseRevision === null ? null : { kind: 'needsSnapshot', reason: 'revisionGap' }
    )
    const publisher = createHostSettingsReplicationPublisher({ ports: [port(true)], transport })

    await publisher.publish(HOST, 'attach')
    await publisher.publish(HOST, 'changed')

    expect(transport.sent[1]).toMatchObject({ baseRevision: 1, revision: 2 })
    expect(transport.sent[2]).toMatchObject({ baseRevision: null, revision: 3 })
  })

  it('refuses to replay when the host does not know the payload version', async () => {
    const transport = acceptingTransport(() => ({ kind: 'unsupportedVersion' }))
    const publisher = createHostSettingsReplicationPublisher({ ports: [port(true)], transport })

    expect(await publisher.publish(HOST, 'attach')).toEqual({
      kind: 'refused',
      reason: 'unsupportedVersion'
    })
    expect(transport.sent).toHaveLength(1)
  })

  it('forgets one host without touching another host holding the same credential', async () => {
    const transport = acceptingTransport()
    const publisher = createHostSettingsReplicationPublisher({ ports: [port(true)], transport })

    await publisher.publish('env-1', 'attach')
    await publisher.publish('env-2', 'attach')
    publisher.forgetHost('env-1')

    expect(publisher.readLedger().hostsByCredential[CREDENTIAL_ID]).toEqual(['env-2'])
  })

  it('sends nothing it does not hold', async () => {
    const transport = acceptingTransport()
    const publisher = createHostSettingsReplicationPublisher({ ports: [port(false)], transport })

    await publisher.publish(HOST, 'attach')

    expect(transport.sent[0]?.upserts).toEqual([])
  })
})

describe('applying what the main sent', () => {
  let holdings = createInMemoryHostSettingsReplicationHoldings()

  beforeEach(() => {
    resetHostSettingsReplication()
    holdings = createInMemoryHostSettingsReplicationHoldings()
  })

  const registry = {
    forCredentialId: () => ({
      kind: CREDENTIAL_ID,
      canSeal: () => true,
      unreadableIds: () => [],
      protectionOf: () => null,
      list: () => [],
      apply: vi.fn(),
      remove: vi.fn()
    })
  }

  function snapshot(revision: number): HostSettingsReplicationPayload {
    return {
      version: 1,
      baseRevision: null,
      revision,
      upserts: [
        {
          id: CREDENTIAL_ID,
          kind: CREDENTIAL_ID,
          label: 'DeepSeek API key',
          protection: 'sealed',
          onlyIfEmpty: false,
          payload: 'sk-live'
        }
      ],
      removals: []
    }
  }

  it('says it has never synced before it is sent anything', () => {
    expect(getHostSettingsReplication(holdings)).toEqual({
      revision: null,
      state: { kind: 'neverSynced' }
    })
  })

  it('applies a snapshot and remembers the revision it reached', () => {
    const result = applyHostSettingsReplication(snapshot(4), { registry, holdings, now: 99 })

    expect(result).toMatchObject({ decision: 'applied' })
    expect(getHostSettingsReplication(holdings)).toMatchObject({ revision: 4 })
  })

  it('asks for a snapshot instead of applying a delta past a gap, and keeps its revision', () => {
    applyHostSettingsReplication(snapshot(4), { registry, holdings, now: 99 })

    const result = applyHostSettingsReplication(
      { ...snapshot(9), baseRevision: 7 },
      { registry, holdings, now: 100 }
    )

    expect(result).toEqual({ decision: 'needsSnapshot', reason: 'revisionGap' })
    expect(getHostSettingsReplication(holdings)).toMatchObject({ revision: 4 })
  })

  it('refuses a version it does not know without advancing its revision', () => {
    // Why parsed from JSON: a newer main is exactly what sends a version this build has never seen,
    // and a round trip is how that payload arrives rather than how a test would write it.
    const fromANewerMain = JSON.parse(JSON.stringify({ ...snapshot(1), version: 2 }))

    const result = applyHostSettingsReplication(fromANewerMain, { registry, holdings, now: 99 })

    expect(result).toEqual({ decision: 'unsupportedVersion' })
    expect(getHostSettingsReplication(holdings).revision).toBeNull()
  })

  it('applies a delta whose base is the revision it holds', () => {
    applyHostSettingsReplication(snapshot(4), { registry, holdings, now: 99 })

    const result = applyHostSettingsReplication(
      { ...snapshot(5), baseRevision: 4 },
      { registry, holdings, now: 100 }
    )

    expect(result).toMatchObject({ decision: 'applied' })
    expect(getHostSettingsReplication(holdings).revision).toBe(5)
  })
})
