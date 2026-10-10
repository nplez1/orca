import {
  HOST_SETTINGS_REPLICATION_PAYLOAD_VERSION,
  type HostSettingsApplyOutcome,
  type HostSettingsApplyReport,
  type HostSettingsPayloadDecision,
  type HostSettingsReplicationPayload,
  type HostSettingsSyncState
} from '../../shared/host-settings-replication'
import type { HostSettingsCredentialRegistry } from './host-settings-credential-port'

/**
 * Whether this host may apply a payload as it stands.
 *
 * Why a revision gate rather than a queue: a host that was offline while several deltas were
 * produced cannot be caught up by replaying them in the order they happen to arrive, and a silent
 * out-of-order apply is worse than one extra snapshot.
 */
export function decideHostSettingsPayload(
  hostRevision: number | null,
  payload: HostSettingsReplicationPayload
): HostSettingsPayloadDecision {
  if (payload.version !== HOST_SETTINGS_REPLICATION_PAYLOAD_VERSION) {
    return { kind: 'unsupportedVersion' }
  }
  if (payload.baseRevision === null) {
    return { kind: 'apply' }
  }
  if (hostRevision === null) {
    return { kind: 'needsSnapshot', reason: 'unknownBase' }
  }
  return hostRevision === payload.baseRevision
    ? { kind: 'apply' }
    : { kind: 'needsSnapshot', reason: 'revisionGap' }
}

/**
 * Apply a payload this host has already accepted, and report what happened to every item.
 *
 * The report is the point: `applied`, `keptHostValue`, `refusedWeakerProtection` and
 * `removalUnverified` are the whole difference between "the host has this credential now" and "the
 * host has something, and nobody checked what". The resulting state is `partial` when anything was
 * refused, so a half-replicated host never reports a clean sync.
 */
export function applyHostSettingsPayload(input: {
  payload: HostSettingsReplicationPayload
  registry: HostSettingsCredentialRegistry
  now: number
}): { report: HostSettingsApplyReport; state: HostSettingsSyncState } {
  const { payload, registry, now } = input
  const outcomes: Record<string, HostSettingsApplyOutcome> = {}

  for (const credential of payload.upserts) {
    const port = registry.forCredentialId(credential.id)
    if (!port || port.kind !== credential.kind) {
      outcomes[credential.id] = 'refusedUnknownKind'
      continue
    }
    if (credential.onlyIfEmpty && port.protectionOf(credential.id) !== null) {
      outcomes[credential.id] = 'keptHostValue'
      continue
    }
    // Why refuse rather than replicate: a sealed value written where it cannot be sealed lands as
    // plaintext, which is a protection downgrade the user never agreed to and cannot see.
    if (credential.protection === 'sealed' && !port.canSeal()) {
      outcomes[credential.id] = 'refusedWeakerProtection'
      continue
    }
    port.apply(credential)
    outcomes[credential.id] = 'applied'
  }

  for (const id of payload.removals) {
    const port = registry.forCredentialId(id)
    if (!port) {
      outcomes[id] = 'refusedUnknownKind'
      continue
    }
    port.remove(id)
    // Why re-read rather than trust the unlink: "the token is gone" is a security claim, and the
    // only honest evidence for it is the store that would still answer with the token.
    outcomes[id] = port.protectionOf(id) === null ? 'removed' : 'removalUnverified'
  }

  const refusals = Object.entries(outcomes)
    .filter(([, outcome]) => outcome !== 'applied' && outcome !== 'removed')
    .map(([id]) => id)

  const report: HostSettingsApplyReport = { revision: payload.revision, outcomes }
  return {
    report,
    state:
      refusals.length === 0
        ? { kind: 'synced', revision: payload.revision, syncedAt: now }
        : { kind: 'partial', revision: payload.revision, syncedAt: now, refusals }
  }
}
