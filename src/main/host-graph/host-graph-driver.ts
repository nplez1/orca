import { getAppEnvironment } from '../../shared/app-lifecycle/app-environment'
import { mapWithConcurrency } from '../../shared/concurrency/map-with-concurrency'
import {
  HOST_GRAPH_EXCHANGE_METHOD,
  type HostGraphAdjacency,
  type HostGraphExchangeResult
} from '../../shared/host-graph/host-graph-contract'
import { composeHostGraph, type HostGraphAnswer } from '../../shared/host-graph/host-graph-compose'
import type {
  HostGraphFailure,
  HostGraphSnapshot
} from '../../shared/host-graph/host-graph-snapshot'
import type { KnownRuntimeEnvironment } from '../../shared/remote-runtime/host-catalog/runtime-environments'
import type { PairingOffer } from '../../shared/remote-runtime/pairing/mobile-relay-pairing-offer'
import {
  listEnvironments,
  resolveEnvironmentPairingOffer
} from '../../shared/remote-runtime/host-store/runtime-environment-store'
import { RuntimeEnvironmentStoreError } from '../../shared/remote-runtime/host-store/runtime-environment-store-records'
import { pairedRuntimeConnectionFromOffer } from '../../shared/remote-runtime/pairing/paired-runtime-connection'
import { sendRemoteRuntimeRequestOnSocket } from '../../shared/remote-runtime/requests/remote-runtime-request-socket'
import type { RuntimeRpcResponse } from '../../shared/remote-runtime/rpc/runtime-rpc-envelope'
import {
  FLEET_HOST_CONCURRENCY,
  FLEET_HOST_TIMEOUT_MS
} from '../runtime/orchestration/legacy-remote-home/federated-fleet-snapshot'
import { readLocalAdjacency } from './host-graph-local-adjacency'

/**
 * The client half of host discovery: ask every paired host for its adjacency, compose what comes back.
 *
 * Why nothing is persisted: the answer is other machines' claims about right now, and a cached file
 * would outlive the pairing it was read under. The caches below are the whole of the memory, and the
 * IPC layer decides when a refresh happens.
 */

/** The whole fan-out's ceiling, so one wedged host cannot hold a read open indefinitely. */
const HOST_GRAPH_TOTAL_TIMEOUT_MS = 5_000
/** How long a composed snapshot is served before the next read refreshes it. */
const SNAPSHOT_TTL_MS = 60_000
/** How long a host that does not answer the exchange is left alone; an upgrade is not imminent. */
const UNSUPPORTED_RETRY_MS = 10 * 60_000

/** The fields of a saved pairing the fan-out needs; a stored environment is assignable as-is. */
export type HostGraphPeerEnvironment = Pick<KnownRuntimeEnvironment, 'id' | 'name'> &
  Partial<Pick<KnownRuntimeEnvironment, 'source'>>

export type HostGraphDriverDeps = {
  listEnvironments: () => Promise<readonly HostGraphPeerEnvironment[]>
  /** Resolves a paired host's offer, or throws when the environment is gone. */
  resolvePairing: (environmentId: string) => Promise<PairingOffer>
  sendRequest: (
    pairing: PairingOffer,
    method: string,
    params: unknown,
    timeoutMs: number
  ) => Promise<RuntimeRpcResponse<HostGraphExchangeResult>>
  readOwn: () => Promise<HostGraphAdjacency>
  now: () => number
}

export type { HostGraphFailure, HostGraphSnapshot }

type PeerAsk =
  | { kind: 'answer'; answer: HostGraphAnswer }
  | { kind: 'failure'; code: HostGraphFailure['code'] }

type DriverState = {
  snapshot: HostGraphSnapshot | null
  /** One fan-out at a time: a burst of reads is a burst of the same question. */
  inFlight: Promise<HostGraphSnapshot> | null
  /** The last full answer per environment, so an `unchanged` reply does not drop its machines. */
  answers: Map<string, HostGraphExchangeResult>
  /** The revision each environment last answered with, so an unchanged reply is one word. */
  revisions: Map<string, string>
  /** Expiry times for hosts that answered `capability_unsupported`. */
  unsupportedUntil: Map<string, number>
}

let state: DriverState = emptyState()

function emptyState(): DriverState {
  return {
    snapshot: null,
    inFlight: null,
    answers: new Map(),
    revisions: new Map(),
    unsupportedUntil: new Map()
  }
}

/** Tests only: forget every cached answer, revision and refusal. */
export function resetHostGraphDriver(): void {
  state = emptyState()
}

/** The last snapshot, refreshed when it is older than a minute. */
export async function readHostGraph(
  overrides: Partial<HostGraphDriverDeps> = {}
): Promise<HostGraphSnapshot> {
  const deps = { ...defaultDeps(), ...overrides }
  const cached = state.snapshot
  if (cached !== null && deps.now() - cached.refreshedAt < SNAPSHOT_TTL_MS) {
    return cached
  }
  return refreshHostGraph(overrides)
}

/** Ask every paired host, whether or not a snapshot is still fresh. */
export async function refreshHostGraph(
  overrides: Partial<HostGraphDriverDeps> = {}
): Promise<HostGraphSnapshot> {
  if (state.inFlight !== null) {
    return state.inFlight
  }
  const deps = { ...defaultDeps(), ...overrides }
  const run = fanOut(deps).finally(() => {
    state.inFlight = null
  })
  state.inFlight = run
  return run
}

async function fanOut(deps: HostGraphDriverDeps): Promise<HostGraphSnapshot> {
  const own = await deps.readOwn()
  const deadline = deps.now() + HOST_GRAPH_TOTAL_TIMEOUT_MS
  const environments = (await deps.listEnvironments()).filter(
    // Why excluded: a recipe VM is a workspace scratch host, not a machine the user owns.
    (environment) => environment.source !== 'ephemeral-vm'
  )
  const asks = await mapWithConcurrency(environments, FLEET_HOST_CONCURRENCY, (environment) =>
    askPeer(environment, { own, deadline, deps })
  )

  const answers: HostGraphAnswer[] = []
  const failures: HostGraphFailure[] = []
  asks.forEach((ask, index) => {
    if (ask.kind === 'answer') {
      answers.push(ask.answer)
      return
    }
    failures.push({
      environmentId: environments[index].id,
      name: environments[index].name,
      code: ask.code
    })
  })

  const snapshot: HostGraphSnapshot = {
    own,
    fleet: composeHostGraph({ viewer: own.self.ref, own, answers, now: deps.now() }),
    refreshedAt: deps.now(),
    failures
  }
  state.snapshot = snapshot
  return snapshot
}

async function askPeer(
  environment: HostGraphPeerEnvironment,
  context: { own: HostGraphAdjacency; deadline: number; deps: HostGraphDriverDeps }
): Promise<PeerAsk> {
  const { deps } = context
  const unsupportedUntil = state.unsupportedUntil.get(environment.id)
  if (unsupportedUntil !== undefined && unsupportedUntil > deps.now()) {
    return { kind: 'failure', code: 'capability_unsupported' }
  }
  // Why the deadline also gates the ask: a host the budget never reaches is a host that answered
  // nothing, and waiting for it would make the whole read as slow as the slowest pairing.
  const remaining = context.deadline - deps.now()
  if (remaining <= 0) {
    return { kind: 'failure', code: 'host_unavailable' }
  }
  let pairing: PairingOffer
  try {
    pairing = await deps.resolvePairing(environment.id)
  } catch (error) {
    return { kind: 'failure', code: failureCodeOf(error) }
  }

  let response: RuntimeRpcResponse<HostGraphExchangeResult>
  try {
    response = await deps.sendRequest(
      pairing,
      HOST_GRAPH_EXCHANGE_METHOD,
      { self: context.own, knownRevision: state.revisions.get(environment.id) },
      Math.min(FLEET_HOST_TIMEOUT_MS, remaining)
    )
  } catch (error) {
    return { kind: 'failure', code: failureCodeOf(error) }
  }
  if (!response.ok) {
    if (isUnsupported(response)) {
      rememberUnsupported(environment.id, deps.now())
      return { kind: 'failure', code: 'capability_unsupported' }
    }
    return {
      kind: 'failure',
      code: response.error.code === 'server_pairing_changed' ? 'peer_changed' : 'host_unavailable'
    }
  }

  const result = response.result
  // Why an unchanged answer reuses the stored one: the host is saying "same facts as last time", and
  // reading that as "no facts" would drop every machine it had reported from the fleet.
  if (isUnchanged(result)) {
    const previous = state.answers.get(environment.id)
    if (previous !== undefined && !isUnchanged(previous)) {
      return { kind: 'answer', answer: answerOf(previous, deps.now()) }
    }
    return { kind: 'failure', code: 'host_unavailable' }
  }
  if (!isFullAnswer(result)) {
    return { kind: 'failure', code: 'host_unavailable' }
  }
  state.answers.set(environment.id, result)
  state.revisions.set(environment.id, result.adjacency.revision)
  return { kind: 'answer', answer: answerOf(result, deps.now()) }
}

function answerOf(
  result: Exclude<HostGraphExchangeResult, { unchanged: true }>,
  receivedAt: number
): HostGraphAnswer {
  return { adjacency: result.adjacency, heard: result.heard, receivedAt, depth: 1 }
}

function rememberUnsupported(environmentId: string, now: number): void {
  state.unsupportedUntil.set(environmentId, now + UNSUPPORTED_RETRY_MS)
}

function isUnchanged(result: HostGraphExchangeResult): result is { unchanged: true } {
  return typeof result === 'object' && result !== null && 'unchanged' in result
}

function isFullAnswer(
  result: HostGraphExchangeResult
): result is Exclude<HostGraphExchangeResult, { unchanged: true }> {
  return (
    typeof result === 'object' &&
    result !== null &&
    'adjacency' in result &&
    typeof result.adjacency === 'object' &&
    result.adjacency !== null &&
    Array.isArray(result.heard)
  )
}

/**
 * Why the same refusal set as host-settings replication: an older host answers `method_not_found`,
 * and a host that refuses this caller answers `forbidden`. Both mean this build cannot answer.
 */
function isUnsupported(response: RuntimeRpcResponse<HostGraphExchangeResult>): boolean {
  if (response.ok) {
    return false
  }
  return response.error.code === 'method_not_found' || response.error.code === 'forbidden'
}

/** A re-pairing adds a new environment, so a saved pairing that no longer resolves is a changed peer. */
function failureCodeOf(error: unknown): HostGraphFailure['code'] {
  return error instanceof RuntimeEnvironmentStoreError && error.code === 'invalid_argument'
    ? 'peer_changed'
    : 'host_unavailable'
}

/**
 * Why lazy: it needs the app environment to resolve a path and a pairing, and this module is imported
 * by IPC registration, which loads before either exists. Every field here is called, never read.
 */
function defaultDeps(): HostGraphDriverDeps {
  const userDataPath = (): string => getAppEnvironment().getPath('userData')
  return {
    listEnvironments: () => listEnvironments(userDataPath()),
    resolvePairing: (environmentId) =>
      resolveEnvironmentPairingOffer(userDataPath(), environmentId),
    sendRequest: (pairing, method, params, timeoutMs) =>
      sendRemoteRuntimeRequestOnSocket<HostGraphExchangeResult>(
        pairedRuntimeConnectionFromOffer(pairing),
        method,
        params,
        timeoutMs
      ),
    readOwn: readLocalAdjacency,
    now: () => Date.now()
  }
}
