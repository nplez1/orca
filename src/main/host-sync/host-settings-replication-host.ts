import {
  HOST_SETTINGS_REPLICATION_PAYLOAD_VERSION,
  type HostSettingsReplicationApplyResult,
  type HostSettingsReplicationPayload,
  type HostSettingsSyncState
} from '../../shared/host-settings-replication'
import {
  createInMemoryHostSettingsReplicationHoldings,
  type HostSettingsReplicationHoldings
} from './host-settings-replication-holdings'
import { HOST_SETTINGS_CREDENTIAL_REGISTRY } from './host-settings-credential-ports'
import type { HostSettingsCredentialRegistry } from './host-settings-credential-port'
import {
  applyHostSettingsPayload,
  decideHostSettingsPayload
} from './host-settings-replication-receiver'

/**
 * The receiving half, as the host's RPC handler uses it.
 *
 * Why the revision lives in memory: it is a cache of "what the main last sent me", and losing it on a
 * restart costs one snapshot, which the next attach sends anyway. Persisting it would mean a file
 * whose staleness is harder to reason about than its absence.
 */

export type { HostSettingsReplicationApplyResult }

/**
 * A payload as it arrives: the version is a number this build may not know, which is why the schema
 * accepts any integer and the decision below refuses an unknown one by name.
 */
type HostSettingsIncomingPayload = Pick<
  HostSettingsReplicationPayload,
  'baseRevision' | 'revision' | 'upserts' | 'removals'
> & { version: number }

let hostRevision: number | null = null

/** Where this host records what arrived by replication, so a snapshot can clean up after a removal. */
const defaultHoldings = createInMemoryHostSettingsReplicationHoldings()

/** What this host last applied, or null when it has never synced. */
export function getHostSettingsReplication(): {
  revision: number | null
  state: HostSettingsSyncState
} {
  return {
    revision: hostRevision,
    state: hostRevision === null ? { kind: 'neverSynced' } : lastState
  }
}

// Why kept apart from the revision: `partial` and `synced` can share a revision, and the refusal list
// is what the main needs to show, so the revision alone cannot answer "did everything land".
let lastState: HostSettingsSyncState = { kind: 'neverSynced' }

/** @internal — a fresh host process, and the boundary between test cases. */
export function resetHostSettingsReplication(): void {
  hostRevision = null
  lastState = { kind: 'neverSynced' }
}

/**
 * Apply what the main sent.
 *
 * Why the payload is re-checked rather than trusted: it crosses a wire and arrives through a socket
 * this build does not fully control, so an unknown version is refused by name instead of applied as a
 * best guess, and the revision of a refused payload is never recorded.
 */
export function applyHostSettingsReplication(
  payload: HostSettingsIncomingPayload,
  options: {
    registry?: HostSettingsCredentialRegistry
    now?: number
    /** Supplied by the RPC method; the in-memory default is for a test and for a host mid-startup. */
    holdings?: HostSettingsReplicationHoldings
  } = {}
): HostSettingsReplicationApplyResult {
  const decision = decideHostSettingsPayload(hostRevision, payload)
  if (decision.kind === 'needsSnapshot') {
    return { decision: 'needsSnapshot', reason: decision.reason }
  }
  if (decision.kind === 'unsupportedVersion') {
    return { decision: 'unsupportedVersion' }
  }
  if (payload.version !== HOST_SETTINGS_REPLICATION_PAYLOAD_VERSION) {
    return { decision: 'unsupportedVersion' }
  }
  const registry = options.registry ?? HOST_SETTINGS_CREDENTIAL_REGISTRY
  const holdings = options.holdings ?? defaultHoldings
  // Why rebuilt rather than used in place: the schema accepts any integer version so an unknown one is
  // refused by name, and this is the point where the version is known to be this build's.
  const contractPayload: HostSettingsReplicationPayload = {
    version: HOST_SETTINGS_REPLICATION_PAYLOAD_VERSION,
    baseRevision: payload.baseRevision,
    revision: payload.revision,
    upserts: payload.upserts,
    removals: payload.removals
  }
  const previouslyReplicated = holdings.read()

  // Why a snapshot clears what replication previously put here, and nothing else: the snapshot is
  // authoritative over the set it owns, which is how a removal is delivered to a host that restarted
  // and no longer has a revision for the delta that carried it. The host's own stores may also hold
  // credentials the user entered on this machine, and those are not in this list, so they are left
  // alone — the same reason a refusal must not be recorded as a hold.
  const incoming = new Set(contractPayload.upserts.map((credential) => credential.id))
  const stranded =
    contractPayload.baseRevision === null
      ? previouslyReplicated.filter((id) => !incoming.has(id))
      : []

  const { report, state } = applyHostSettingsPayload({
    payload:
      stranded.length === 0
        ? contractPayload
        : { ...contractPayload, removals: [...contractPayload.removals, ...stranded] },
    registry,
    now: options.now ?? Date.now()
  })

  const removed = new Set(
    Object.entries(report.outcomes)
      .filter(([, outcome]) => outcome === 'removed')
      .map(([id]) => id)
  )
  const stillHeld = new Set(
    previouslyReplicated
      .filter((id) => !removed.has(id))
      .concat(
        contractPayload.upserts
          // `refused*` and `keptHostValue` mean the host did not take the main's copy, so it is not
          // this host's replicated holding either.
          .filter((credential) => {
            const outcome = report.outcomes[credential.id]
            return (
              outcome !== undefined &&
              outcome !== 'refusedUnknownKind' &&
              outcome !== 'refusedWeakerProtection' &&
              outcome !== 'keptHostValue'
            )
          })
          .map((credential) => credential.id)
      )
  )
  holdings.write([...stillHeld])

  hostRevision = contractPayload.revision
  lastState = state
  return { decision: 'applied', report, state }
}
