import type { PairingOffer } from '../../shared/pairing'
import type { RuntimeRpcResponse } from '../../shared/runtime-rpc-envelope'
import { HOST_SETTINGS_APPLY_METHOD } from '../../shared/host-settings-replication'
import type { HostSettingsReplicationApplyResult } from '../../shared/host-settings-replication'
import type { HostSettingsCredentialPort } from './host-settings-credential-port'
import type { HostSettingsCredentialLedger } from './host-settings-replication-ledger'
import {
  createHostSettingsReplicationPublisher,
  type HostSettingsReplicationPublishOutcome,
  type HostSettingsReplicationSendResult,
  type HostSettingsReplicationTransport
} from './host-settings-replication-publisher'

const APPLY_TIMEOUT_MS = 20_000
/** Collapses a burst of saves — a settings pane writes several fields — into one delta. */
const CHANGE_DEBOUNCE_MS = 250
/** How long to wait before retrying a first push that did not land. */
const RETRY_DELAY_MS = 2_000

type SendApplyRequest = (
  pairing: PairingOffer,
  method: string,
  params: unknown,
  timeoutMs: number
) => Promise<RuntimeRpcResponse<HostSettingsReplicationApplyResult>>

/** The decisions a host may answer with, at runtime as well as in the type. */
const APPLY_DECISIONS: readonly string[] = [
  'applied',
  'needsSnapshot',
  'unsupportedVersion',
  'refusedNotTheMain'
]

export type HostSettingsReplicationConnectionObservation = {
  environmentId: string
  /** Bumped on every re-pair or reconnect, so a new generation is a new attachment. */
  transportGeneration: number
  state: string
}

export type HostSettingsReplicationSync = {
  /** Feed every connection-diagnostics change for one environment. */
  observeConnection(observation: HostSettingsReplicationConnectionObservation): void
  /** Call after any replicated credential changes; the delta is debounced and coalesced. */
  notifyChanged(): void
  /** Stop tracking a host that is no longer paired. */
  forgetHost(environmentId: string): void
  /** Await the in-flight work, for teardown and tests. */
  drain(): Promise<void>
}

/**
 * Drives replication from connection state and change notifications.
 *
 * Why the pre-method host is learned from its own refusal rather than from an advertised capability:
 * the diagnostics the main observes here carry a host's connection state but not its capability list,
 * so asking first would mean a second RPC on every attach to answer a question the apply itself
 * answers. The refusal costs one failed call per host per connection, and that host is then remembered
 * so a reconnect does not repeat it.
 *
 * Why a per-host queue rather than fire-and-forget: two pushes to one host that overlap would build
 * both deltas from the same base revision, and the second would be refused for a revision gap the main
 * created itself.
 */
export function createHostSettingsReplicationSync(input: {
  ports: readonly HostSettingsCredentialPort[]
  /** Resolves the paired host's offer, or throws when the environment is gone. */
  resolvePairing: (environmentId: string) => PairingOffer
  /** Overridable so a test never opens a socket. */
  sendRequest: SendApplyRequest
  ledger?: HostSettingsCredentialLedger
  /** Overridable so a test does not wait on a real timer. */
  scheduleDebounce?: (run: () => void) => () => void
  /** Overridable so a test does not wait for the retry of a first push that never landed. */
  scheduleRetry?: (run: () => void) => void
  /** Whether the host advertises replication; forwarded to the transport's probe. */
  supportsReplication?: (environmentId: string) => Promise<boolean>
}): HostSettingsReplicationSync {
  const transport: HostSettingsReplicationTransport = {
    ...(input.supportsReplication === undefined
      ? {}
      : { supportsReplication: input.supportsReplication }),
    send: async (environmentId, payload) => {
      let pairing: PairingOffer
      try {
        pairing = input.resolvePairing(environmentId)
      } catch (error) {
        return { kind: 'unreachable', detail: describe(error) }
      }
      let response: RuntimeRpcResponse<HostSettingsReplicationApplyResult>
      try {
        response = await input.sendRequest(
          pairing,
          HOST_SETTINGS_APPLY_METHOD,
          { payload },
          APPLY_TIMEOUT_MS
        )
      } catch (error) {
        return { kind: 'unreachable', detail: describe(error) }
      }
      if (!response.ok) {
        return isUnsupportedMethod(response)
          ? { kind: 'unsupportedMethod' }
          : { kind: 'unreachable', detail: response.error.message }
      }
      const result = response.result
      // A host that answers with a shape this build cannot read is not a host that applied anything,
      // and reporting it as applied would record a holding that does not exist. The membership test is
      // the runtime half of the union: the switch below is exhaustive over the type, so it has no
      // default, and this is what keeps an out-of-band answer from falling through it.
      if (!result || typeof result !== 'object' || !APPLY_DECISIONS.includes(result.decision)) {
        return unreadableResult()
      }
      switch (result.decision) {
        case 'applied':
          return { kind: 'applied', report: result.report, state: result.state }
        case 'needsSnapshot':
          return { kind: 'needsSnapshot', reason: result.reason }
        case 'unsupportedVersion':
          return { kind: 'unsupportedVersion' }
        case 'refusedNotTheMain':
          return { kind: 'refusedNotTheMain' }
      }
    }
  }

  const publisher = createHostSettingsReplicationPublisher({
    ports: input.ports,
    transport,
    ...(input.ledger === undefined ? {} : { ledger: input.ledger })
  })

  const connectedGenerations = new Map<string, number>()
  const pushedGenerations = new Map<string, number>()
  const unsupportedHosts = new Set<string>()
  const queues = new Map<string, Promise<unknown>>()
  /** One retry per host for a first push that did not land. */
  const retries = new Map<string, number>()

  function enqueue(
    environmentId: string,
    reason: 'attach' | 'changed',
    transportGeneration: number
  ): Promise<HostSettingsReplicationPublishOutcome> {
    const previous = queues.get(environmentId) ?? Promise.resolve()
    const next = previous
      .catch(() => undefined)
      .then(async () => {
        // Why probe before pushing rather than only learning from a refusal: the capability is the
        // negotiation this wire expects, and a host that does not advertise it should not be sent a
        // payload it will only reject. The refusal path below stays as the fallback for a host whose
        // advertisement is wrong or absent.
        if (transport.supportsReplication !== undefined) {
          const supported = await transport.supportsReplication(environmentId)
          if (!supported) {
            stopAsking(environmentId, transportGeneration)
            return { kind: 'refused', reason: 'unsupportedMethod' } as const
          }
        }
        return await publisher.publish(environmentId, reason)
      })
      .then((outcome) => {
        // Why `notTheMain` also stops the asking: another paired caller has already configured this
        // host, so retrying would only fight it. A new connection clears this and tries again.
        if (
          outcome.kind === 'refused' &&
          (outcome.reason === 'unsupportedMethod' || outcome.reason === 'notTheMain')
        ) {
          stopAsking(environmentId, transportGeneration)
          return outcome
        }
        if (outcome.kind === 'unreachable') {
          // Why one retry: the first push rides a connection that has just come up, and a socket error
          // or a timeout there would otherwise leave a freshly paired host empty until some credential
          // happens to change — the opposite of "install it and start using it".
          const attempts = retries.get(environmentId) ?? 0
          if (attempts < 1) {
            retries.set(environmentId, attempts + 1)
            scheduleRetry(() => void enqueue(environmentId, reason, transportGeneration))
            return outcome
          }
        }
        retries.delete(environmentId)
        return outcome
      })
      // Why caught here rather than left to the caller: every call site is a `void enqueue(...)`, so a
      // throw would surface as an unhandled rejection and take the process's error handling with it.
      .catch((error): HostSettingsReplicationPublishOutcome => {
        return { kind: 'unreachable', detail: describe(error) }
      })
    queues.set(environmentId, next)
    return next
  }

  /**
   * Stop pushing to a host for this connection, without forgetting what it holds.
   *
   * Why the generation is checked: a push queued on the previous connection can settle after the host
   * has reconnected, and deleting the new connection's entry there would leave the host attached but
   * never pushed again.
   */
  function stopAsking(environmentId: string, transportGeneration: number): void {
    unsupportedHosts.add(environmentId)
    if (connectedGenerations.get(environmentId) === transportGeneration) {
      connectedGenerations.delete(environmentId)
    }
  }

  const schedule = input.scheduleDebounce ?? defaultDebounce
  const scheduleRetry =
    input.scheduleRetry ?? ((run: () => void) => void setTimeout(run, RETRY_DELAY_MS))
  let cancelPending: (() => void) | null = null

  return {
    observeConnection: ({ environmentId, transportGeneration, state }) => {
      if (state !== 'ready') {
        // Why: a host that drops and comes back re-attaches, and its in-memory revision died with the
        // old process — so the next `ready` has to send a snapshot, not a delta built on trust.
        connectedGenerations.delete(environmentId)
        return
      }
      // Why attachment rather than the generation decides the early return: a generation is only bumped
      // when the pairing changes, so a host that dropped and reconnected on the same pairing would be
      // skipped here and then silently stop receiving deltas, having been dropped from the set above.
      const reattached = !connectedGenerations.has(environmentId)
      connectedGenerations.set(environmentId, transportGeneration)
      if (pushedGenerations.get(environmentId) === transportGeneration && !reattached) {
        return
      }
      // Why per connection rather than for the life of the process: a host that refused the first
      // attempt may have been upgraded or re-paired since, and nothing else would ever ask it again.
      unsupportedHosts.delete(environmentId)
      pushedGenerations.set(environmentId, transportGeneration)
      void enqueue(environmentId, 'attach', transportGeneration)
    },
    notifyChanged: () => {
      if (connectedGenerations.size === 0) {
        return
      }
      cancelPending?.()
      cancelPending = schedule(() => {
        cancelPending = null
        for (const [environmentId, transportGeneration] of connectedGenerations) {
          void enqueue(environmentId, 'changed', transportGeneration)
        }
      })
    },
    forgetHost: (environmentId) => {
      connectedGenerations.delete(environmentId)
      pushedGenerations.delete(environmentId)
      unsupportedHosts.delete(environmentId)
      queues.delete(environmentId)
      retries.delete(environmentId)
      publisher.forgetHost(environmentId)
    },
    drain: async () => {
      await Promise.all([...queues.values()].map((queue) => queue.catch(() => undefined)))
    }
  }
}

function defaultDebounce(run: () => void): () => void {
  const timer = setTimeout(run, CHANGE_DEBOUNCE_MS)
  return () => clearTimeout(timer)
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function unreadableResult(): HostSettingsReplicationSendResult {
  return {
    kind: 'unreachable',
    detail: 'host answered with an unreadable replication result'
  }
}

/**
 * Why a refusal and not just the code: an older host answers `method_not_found`, and a host that
 * refuses this caller answers `forbidden` with a message naming the permission. Both mean "stop
 * asking this host", and treating the second as an error would retry it on every connection forever.
 */
function isUnsupportedMethod(
  response: RuntimeRpcResponse<HostSettingsReplicationApplyResult>
): boolean {
  if (response.ok) {
    return false
  }
  return (
    response.error.code === 'method_not_found' ||
    response.error.code === 'forbidden' ||
    /not available to mobile clients|was not granted when it paired/.test(response.error.message)
  )
}
