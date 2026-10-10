import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PairingOffer } from '../../shared/pairing'
import type { RuntimeRpcResponse } from '../../shared/runtime-rpc-envelope'
import { HOST_SETTINGS_APPLY_METHOD } from '../../shared/host-settings-replication'
import type { HostSettingsReplicationApplyResult } from '../../shared/host-settings-replication'
import type { HostSettingsCredentialPort } from './host-settings-credential-port'
import { createHostSettingsReplicationSync } from './host-settings-replication-sync'

const CREDENTIAL_ID = 'api-key:deepseek'
const HOST = 'env-1'
const PAIRING: PairingOffer = {
  v: 2,
  endpoint: 'wss://host.test',
  deviceToken: 'token',
  publicKeyB64: 'paired-host-public-key'
}

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

function envelope(): { id: string; _meta: { runtimeId: string } } {
  return { id: 'test', _meta: { runtimeId: 'test-runtime' } }
}

function ok(revision = 1): RuntimeRpcResponse<HostSettingsReplicationApplyResult> {
  return {
    ...envelope(),
    ok: true,
    result: {
      decision: 'applied',
      report: { revision, outcomes: { [CREDENTIAL_ID]: 'applied' } },
      state: { kind: 'synced', revision, syncedAt: 1 }
    }
  }
}

function failure(
  code: string,
  message = ''
): RuntimeRpcResponse<HostSettingsReplicationApplyResult> {
  return { ...envelope(), ok: false, error: { code, message } }
}

function notTheMain(): RuntimeRpcResponse<HostSettingsReplicationApplyResult> {
  return { ...envelope(), ok: true, result: { decision: 'refusedNotTheMain' } }
}

/** Run the debounce the moment it is scheduled, so a test does not wait on a timer. */
function immediateDebounce(run: () => void): () => void {
  run()
  return () => {}
}

/**
 * Read the payload out of a request without asserting its shape: `JSON.parse` is what a fake transport
 * receives anyway, and a cast here would be the test telling itself what it should be checking.
 */
function payloadOf(params: unknown): { baseRevision: number | null; revision: number } {
  const parsed = JSON.parse(JSON.stringify(params))
  return {
    baseRevision: parsed?.payload?.baseRevision ?? null,
    revision: parsed?.payload?.revision ?? 0
  }
}

function createSync(
  overrides: {
    sendRequest?: (
      pairing: PairingOffer,
      method: string,
      params: unknown
    ) => Promise<RuntimeRpcResponse<HostSettingsReplicationApplyResult>>
    supportsReplication?: (environmentId: string) => Promise<boolean>
    held?: boolean
  } = {}
) {
  const sent: { method: string; payload: { baseRevision: number | null; revision: number } }[] = []
  const sync = createHostSettingsReplicationSync({
    ports: [port(overrides.held ?? true)],
    resolvePairing: () => PAIRING,
    scheduleDebounce: immediateDebounce,
    ...(overrides.supportsReplication === undefined
      ? {}
      : { supportsReplication: overrides.supportsReplication }),
    sendRequest: async (_pairing, method, params) => {
      sent.push({
        method,
        payload: payloadOf(params)
      })
      return overrides.sendRequest === undefined
        ? ok(sent.length)
        : await overrides.sendRequest(_pairing, method, params)
    }
  })
  return { sync, sent }
}

const ready = (transportGeneration = 1) => ({
  environmentId: HOST,
  transportGeneration,
  state: 'ready'
})

describe('driving replication from connection state', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('pushes a snapshot the first time a host is ready', async () => {
    const { sync, sent } = createSync()

    sync.observeConnection(ready())
    await sync.drain()

    expect(sent).toHaveLength(1)
    expect(sent[0]?.method).toBe(HOST_SETTINGS_APPLY_METHOD)
    expect(sent[0]?.payload.baseRevision).toBeNull()
  })

  it('does not push again while the host stays on the same connection', async () => {
    const { sync, sent } = createSync()

    sync.observeConnection(ready())
    await sync.drain()
    sync.observeConnection(ready())
    await sync.drain()

    expect(sent).toHaveLength(1)
  })

  it('sends a fresh snapshot when the host reconnects on a new generation', async () => {
    const { sync, sent } = createSync()

    sync.observeConnection(ready(1))
    await sync.drain()
    sync.observeConnection(ready(2))
    await sync.drain()

    expect(sent).toHaveLength(2)
    // Why null again rather than a delta: the host's own revision died with the process that held it,
    // so a delta based on this main's record could be refused or, worse, applied over a stale host.
    expect(sent[1]?.payload.baseRevision).toBeNull()
  })

  it('re-attaches a host that dropped and came back, so it keeps getting deltas', async () => {
    const { sync, sent } = createSync()

    sync.observeConnection(ready(1))
    await sync.drain()
    sync.observeConnection({ ...ready(1), state: 'reconnecting' })
    sync.observeConnection(ready(1))
    await sync.drain()
    sync.notifyChanged()
    await sync.drain()

    expect(sent).toHaveLength(3)
    expect(sent[2]?.payload.baseRevision).not.toBeNull()
  })

  it('pushes a delta to every attached host when a credential changes', async () => {
    const { sync, sent } = createSync()

    sync.observeConnection(ready(1))
    sync.observeConnection({ environmentId: 'env-2', transportGeneration: 1, state: 'ready' })
    await sync.drain()
    sync.notifyChanged()
    await sync.drain()

    expect(sent).toHaveLength(4)
    expect(sent[2]).toMatchObject({ method: HOST_SETTINGS_APPLY_METHOD })
  })

  it('does nothing on a change when no host is attached', async () => {
    const { sync, sent } = createSync()

    sync.notifyChanged()
    await sync.drain()

    expect(sent).toHaveLength(0)
  })

  it('does not push to a host that does not advertise replication', async () => {
    const { sync, sent } = createSync({ supportsReplication: async () => false })

    sync.observeConnection(ready())
    await sync.drain()

    expect(sent).toHaveLength(0)
  })

  it('pushes when a host that predates the capability is upgraded onto a new generation', async () => {
    let supported = false
    const { sync, sent } = createSync({ supportsReplication: async () => supported })

    sync.observeConnection(ready(1))
    await sync.drain()
    supported = true
    sync.observeConnection(ready(2))
    await sync.drain()

    expect(sent).toHaveLength(1)
  })

  it('stops asking a host that refuses the method, then tries again on the next connection', async () => {
    let refusals = 1
    const { sync, sent } = createSync({
      sendRequest: async () => {
        if (refusals > 0) {
          refusals -= 1
          return failure('method_not_found')
        }
        return ok()
      }
    })

    sync.observeConnection(ready(1))
    await sync.drain()
    sync.notifyChanged()
    await sync.drain()

    // One refusal, and no repeated attempts within the same connection.
    expect(sent).toHaveLength(1)

    sync.observeConnection(ready(2))
    await sync.drain()

    expect(sent).toHaveLength(2)
  })

  it('stops pushing to a host another main configured, without forgetting it', async () => {
    const { sync, sent } = createSync({
      sendRequest: async () => notTheMain()
    })

    sync.observeConnection(ready(1))
    await sync.drain()
    sync.notifyChanged()
    await sync.drain()

    expect(sent).toHaveLength(1)
  })

  it('treats an unreachable host as unproven rather than as a downgrade', async () => {
    const { sync, sent } = createSync({
      sendRequest: async () => failure('transport_closed', 'socket closed')
    })

    sync.observeConnection(ready(1))
    await sync.drain()
    sync.notifyChanged()
    await sync.drain()

    // Why still pushing: losing contact says nothing about what the host is, so it must not be cached
    // as unsupported — the next change retries it.
    expect(sent.length).toBeGreaterThan(1)
  })

  it('survives a transport that throws, instead of rejecting out of the caller', async () => {
    const { sync, sent } = createSync({
      sendRequest: async () => {
        throw new Error('socket died')
      }
    })

    sync.observeConnection(ready())
    await expect(sync.drain()).resolves.toBeUndefined()

    expect(sent).toHaveLength(1)
  })

  it('forgets a host without touching the others', async () => {
    const { sync, sent } = createSync()

    sync.observeConnection(ready(1))
    sync.observeConnection({ environmentId: 'env-2', transportGeneration: 1, state: 'ready' })
    await sync.drain()
    sync.forgetHost(HOST)
    sync.notifyChanged()
    await sync.drain()

    expect(sent).toHaveLength(3)
    expect(sent[2]).toBeDefined()
  })
})

describe('the driver singleton', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  // Why: the driver is created by the first connection, so a credential saved before any host has ever
  // connected must be a no-op rather than an error — and must not build a driver that resolves an app
  // environment which may not exist yet.
  it('lets a credential change through before any host has connected', async () => {
    const { noteReplicatedCredentialChanged } = await import('./host-settings-replication-service')

    expect(() => noteReplicatedCredentialChanged()).not.toThrow()
  })
})
