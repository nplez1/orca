import {
  HOST_SETTINGS_REPLICATION_PAYLOAD_VERSION,
  type HostSettingsReplicationApplyResult,
  type HostSettingsReplicationPayload,
  type HostSettingsSyncState
} from '../../shared/host-settings-replication'
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

let hostRevision: number | null = null

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
  payload: HostSettingsReplicationPayload,
  options: { registry?: HostSettingsCredentialRegistry; now?: number } = {}
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
  const { report, state } = applyHostSettingsPayload({
    payload,
    registry: options.registry ?? HOST_SETTINGS_CREDENTIAL_REGISTRY,
    now: options.now ?? Date.now()
  })
  hostRevision = payload.revision
  lastState = state
  return { decision: 'applied', report, state }
}
