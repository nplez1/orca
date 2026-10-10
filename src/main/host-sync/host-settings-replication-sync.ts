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

type SendApplyRequest = (
  pairing: PairingOffer,
  method: string,
  params: unknown,
  timeoutMs: number
) => Promise<RuntimeRpcResponse<HostSettingsReplicationApplyResult>>

/** The decisions a host may answer with, at runtime as well as in the type. */
const APPLY_DECISIONS: readonly string[] = ['applied', 'needsSnapshot', 'unsupportedVersion']

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
 * answers. The refusal costs one failed call per host per connection, and that host is them remembered
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
}): HostSettingsReplicationSync {
  const transport: HostSettingsReplicationTransport = {
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

  function enqueue(
    environmentId: string,
    reason: 'attach' | 'changed'
  ): Promise<HostSettingsReplicationPublishOutcome> {
    const previous = queues.get(environmentId) ?? Promise.resolve()
    const next = previous
      .catch(() => undefined)
      .then(() => publisher.publish(environmentId, reason))
      .then((outcome) => {
        if (outcome.kind === 'refused' && outcome.reason === 'unsupportedMethod') {
          unsupportedHosts.add(environmentId)
          connectedGenerations.delete(environmentId)
        }
        return outcome
      })
    queues.set(environmentId, next)
    return next
  }

  const schedule = input.scheduleDebounce ?? defaultDebounce
  let cancelPending: (() => void) | null = null

  return {
    observeConnection: ({ environmentId, transportGeneration, state }) => {
      if (state !== 'ready') {
        // Why: a host that drops and comes back re-attaches, and its in-memory revision died with the
        // old process — so the next `ready` has to send a snapshot, not a delta built on trust.
        connectedGenerations.delete(environmentId)
        return
      }
      if (pushedGenerations.get(environmentId) === transportGeneration) {
        return
      }
      // Why per generation rather than for the life of the process: a host that refused the first
      // attempt may have been upgraded or re-paired since, and nothing else would ever ask it again.
      unsupportedHosts.delete(environmentId)
      pushedGenerations.set(environmentId, transportGeneration)
      connectedGenerations.set(environmentId, transportGeneration)
      void enqueue(environmentId, 'attach')
    },
    notifyChanged: () => {
      if (connectedGenerations.size === 0) {
        return
      }
      cancelPending?.()
      cancelPending = schedule(() => {
        cancelPending = null
        for (const environmentId of connectedGenerations.keys()) {
          void enqueue(environmentId, 'changed')
        }
      })
    },
    forgetHost: (environmentId) => {
      connectedGenerations.delete(environmentId)
      pushedGenerations.delete(environmentId)
      unsupportedHosts.delete(environmentId)
      queues.delete(environmentId)
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
