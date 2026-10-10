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
 * Why the parameter is a loose `version: number` rather than the contract type: the whole point of a
 * versioned payload is that a build can be handed one it does not know, and that payload cannot be
 * typed as a version this build defines.
 *
 * Why a revision gate rather than a queue: a host that was offline while several deltas were
 * produced cannot be caught up by replaying them in the order they happen to arrive, and a silent
 * out-of-order apply is worse than one extra snapshot.
 */
export function decideHostSettingsPayload(
  hostRevision: number | null,
  payload: Pick<HostSettingsReplicationPayload, 'baseRevision'> & { version: number }
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
    try {
      port.apply(credential)
    } catch (error) {
      // Why per item, and why a failure is still recorded as possibly held: an adapter that throws
      // partway through (a malformed payload, a full disk) may already have written the value, and one
      // throwing credential must not stop the rest of the payload from being applied — nor abort the
      // whole RPC, which the main would read as "unreachable" and leave the ledger with nothing.
      console.warn(`[orca] Could not apply replicated credential ${credential.id}`, error)
      outcomes[credential.id] = 'applyFailed'
      continue
    }
    // Why re-read the store instead of trusting the adapter: a store whose keyring is unavailable at
    // write time falls back to plaintext, so an adapter that believes it can seal is not evidence that
    // the value landed sealed. If it did not, the weaker copy is removed rather than left behind — a
    // silent protection downgrade is the one outcome this policy exists to prevent.
    if (credential.protection === 'sealed' && port.protectionOf(credential.id) !== 'sealed') {
      try {
        port.remove(credential.id)
      } catch (error) {
        // Why `applyFailed` and not a refusal: the weaker copy is still on disk, so neither side may
        // treat this as "the host does not hold it" — a refusal would take it out of both the host's
        // record and the main's ledger, and nothing would ever clean it up.
        console.warn(`[orca] Could not withdraw downgraded credential ${credential.id}`, error)
        outcomes[credential.id] = 'applyFailed'
        continue
      }
      outcomes[credential.id] = 'refusedWeakerProtection'
      continue
    }
    outcomes[credential.id] = 'applied'
  }

  for (const id of payload.removals) {
    const port = registry.forCredentialId(id)
    if (!port) {
      outcomes[id] = 'refusedUnknownKind'
      continue
    }
    // Why per removal: an unlink can fail for reasons that have nothing to do with us — EBUSY under a
    // Windows antivirus scan, EPERM on a locked file — and an uncaught throw here aborted the whole
    // apply, so later removals never ran and the upserts that had already landed were never recorded.
    try {
      port.remove(id)
    } catch (error) {
      console.warn(`[orca] Could not remove replicated credential ${id}`, error)
      outcomes[id] = 'removalUnverified'
      continue
    }
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
