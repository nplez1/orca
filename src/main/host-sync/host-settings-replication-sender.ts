import type { HostSettingsReplicationPayload } from '../../shared/host-settings-replication'
import { HOST_SETTINGS_REPLICATION_PAYLOAD_VERSION } from '../../shared/host-settings-replication'
import type { HostSettingsCredentialPort } from './host-settings-credential-port'

/**
 * Build what the main sends.
 *
 * Why a snapshot is the default: a host that has just been paired has no revision to base a delta on,
 * and "install, pair, and it works" is the case that has to be right. Deltas exist for everything
 * after that, and they are built from the credential ids the last payload carried.
 */
export function buildHostSettingsSnapshot(
  ports: readonly HostSettingsCredentialPort[],
  revision: number,
  previousCredentialIds: readonly string[] = []
): HostSettingsReplicationPayload {
  const upserts = ports.flatMap((port) => port.list())
  const held = new Set(upserts.map((credential) => credential.id))
  return {
    version: HOST_SETTINGS_REPLICATION_PAYLOAD_VERSION,
    baseRevision: null,
    revision,
    upserts,
    // Why a snapshot still names removals: a host restarts with no revision of its own, so a snapshot
    // is the only push that can clear what it already holds. A removal lost that way would never be
    // re-sent, because the delta after it does not name the credential either.
    removals: previousCredentialIds.filter((id) => !held.has(id))
  }
}

/**
 * What changed since the last payload this host accepted.
 *
 * Why ids rather than values: a credential whose value changed is re-sent whole — the contract has one
 * notion of an upsert — and comparing values would mean the main reading every secret it holds just
 * to decide nothing changed.
 */
export function buildHostSettingsDelta(input: {
  ports: readonly HostSettingsCredentialPort[]
  /** Credential ids the last payload carried. */
  previousCredentialIds: readonly string[]
  revision: number
  baseRevision: number
}): HostSettingsReplicationPayload {
  const upserts = input.ports.flatMap((port) => port.list())
  const held = new Set(upserts.map((credential) => credential.id))
  return {
    version: HOST_SETTINGS_REPLICATION_PAYLOAD_VERSION,
    baseRevision: input.baseRevision,
    revision: input.revision,
    // Why re-send everything rather than only the changed ids: a port reports what it holds, not when
    // it changed, and a wrong "unchanged" leaves a host silently holding a stale credential.
    upserts,
    removals: input.previousCredentialIds.filter((id) => !held.has(id))
  }
}
