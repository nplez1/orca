import type {
  HostSettingsApplyReport,
  HostSettingsReplicationPayload,
  HostSettingsSyncState
} from '../../shared/host-settings-replication'
import type { HostSettingsCredentialPort } from './host-settings-credential-port'
import {
  buildHostSettingsDelta,
  buildHostSettingsSnapshot
} from './host-settings-replication-sender'
import {
  EMPTY_HOST_SETTINGS_CREDENTIAL_LEDGER,
  forgetCredentialHoldings,
  forgetHostHoldings,
  recordCredentialHoldings,
  type HostSettingsCredentialLedger
} from './host-settings-replication-ledger'

/**
 * What the main sends to a host, and what came back.
 *
 * Why `unreachable` rather than a thrown error: losing contact with a host is never evidence that
 * anything happened there, so the caller has to be able to leave that host's record untouched
 * instead of guessing whether the payload landed.
 */
export type HostSettingsReplicationSendResult =
  | { kind: 'applied'; report: HostSettingsApplyReport; state: HostSettingsSyncState }
  | { kind: 'needsSnapshot'; reason: 'revisionGap' | 'unknownBase' }
  | { kind: 'unsupportedVersion' }
  /** This host predates the method, or its caller may not use it. Learned once per connection. */
  | { kind: 'unsupportedMethod' }
  | { kind: 'unreachable'; detail: string }

export type HostSettingsReplicationTransport = {
  send(
    environmentId: string,
    payload: HostSettingsReplicationPayload
  ): Promise<HostSettingsReplicationSendResult>
}

export type HostSettingsReplicationPublishOutcome =
  | { kind: 'synced'; revision: number; state: HostSettingsSyncState }
  /** The host took some of it and refused the rest; the report names what and why. */
  | { kind: 'partial'; revision: number; report: HostSettingsApplyReport }
  | { kind: 'refused'; reason: 'unsupportedVersion' | 'needsSnapshot' | 'unsupportedMethod' }
  | { kind: 'unreachable'; detail: string }

/** Per host: the revision it last applied, and the credential ids that payload carried. */
type HostRecord = { revision: number; credentialIds: string[] }

export type HostSettingsReplicationPublisher = {
  /**
   * Push to one host.
   *
   * `attach` sends a snapshot, because a host that has just been paired has no revision for a delta to
   * build on. `changed` sends a delta, and falls back to a snapshot when the host says its revision is
   * not the delta's base — a host that was offline while several changes landed cannot be caught up by
   * replaying them in arrival order.
   */
  publish(
    environmentId: string,
    reason: 'attach' | 'changed'
  ): Promise<HostSettingsReplicationPublishOutcome>
  /** Which paired hosts hold which credential: what revocation works from. */
  readLedger(): HostSettingsCredentialLedger
  /** Forget a host that is no longer paired, without touching the others' holdings. */
  forgetHost(environmentId: string): void
}

/** Outcomes where the receiving host demonstrably does not hold the value. */
const HOST_DID_NOT_TAKE: readonly string[] = [
  'keptHostValue',
  'refusedWeakerProtection',
  'refusedUnknownKind'
]

export function createHostSettingsReplicationPublisher(input: {
  ports: readonly HostSettingsCredentialPort[]
  transport: HostSettingsReplicationTransport
  ledger?: HostSettingsCredentialLedger
}): HostSettingsReplicationPublisher {
  const records = new Map<string, HostRecord>()
  // Why an epoch per host: `forgetHost` can run while a publish is in flight, and recording that
  // publish's outcome afterwards would put a forgotten host back in the ledger.
  const epochs = new Map<string, number>()
  let ledger = input.ledger ?? EMPTY_HOST_SETTINGS_CREDENTIAL_LEDGER
  let nextRevision = 1

  function buildPayload(environmentId: string, reason: 'attach' | 'changed') {
    const record = records.get(environmentId)
    const revision = nextRevision
    return reason === 'attach' || record === undefined
      ? buildHostSettingsSnapshot(input.ports, revision, record?.credentialIds ?? [])
      : buildHostSettingsDelta({
          ports: input.ports,
          previousCredentialIds: record.credentialIds,
          baseRevision: record.revision,
          revision
        })
  }

  /**
   * Record what the host actually took.
   *
   * Why the ids that applied rather than the ids sent: the ledger is what revocation deletes from, and
   * a refused credential is one this host does not hold. Recording it would make the main report a
   * deletion it never performed.
   */
  function recordOutcome(
    environmentId: string,
    payload: HostSettingsReplicationPayload,
    report: HostSettingsApplyReport
  ): string[] {
    nextRevision = Math.max(nextRevision, payload.revision + 1)
    // Why the ledger errs toward listing too much: it is what revocation deletes from, so a host that
    // actually holds a credential is a correctness problem, while deleting a credential a host does not
    // hold is a no-op. Only the outcomes where the host demonstrably did not take the value are
    // excluded — including an outcome name this build does not know, which is a failure of ours to
    // interpret rather than evidence the write did not happen.
    const applied = payload.upserts
      .filter(
        (credential) =>
          !HOST_DID_NOT_TAKE.includes(report.outcomes[credential.id] ?? 'applyFailedUnknown')
      )
      .map((credential) => credential.id)
    ledger = recordCredentialHoldings(ledger, { credentialIds: applied, hostId: environmentId })
    for (const id of payload.removals) {
      if (report.outcomes[id] === 'removed') {
        ledger = forgetCredentialHoldings(ledger, id, [environmentId])
      }
    }
    return applied
  }

  return {
    readLedger: () => ledger,
    forgetHost: (environmentId) => {
      records.delete(environmentId)
      epochs.set(environmentId, (epochs.get(environmentId) ?? 0) + 1)
      ledger = forgetHostHoldings(ledger, environmentId)
    },
    publish: async (environmentId, reason) => {
      const epoch = epochs.get(environmentId) ?? 0
      let payload = buildPayload(environmentId, reason)
      let result = await input.transport.send(environmentId, payload)
      if (result.kind === 'needsSnapshot') {
        // One retry, with a fresh revision and the same removal list: a host that rejected a delta is
        // not told the same revision twice, or its own revision gate would refuse the snapshot as a
        // replay. The removals come back with the snapshot because this is the last push that names
        // what the host should no longer hold.
        payload = buildHostSettingsSnapshot(
          input.ports,
          payload.revision + 1,
          records.get(environmentId)?.credentialIds ?? []
        )
        result = await input.transport.send(environmentId, payload)
      }
      if (result.kind === 'unreachable') {
        return { kind: 'unreachable', detail: result.detail }
      }
      if (
        result.kind === 'unsupportedVersion' ||
        result.kind === 'needsSnapshot' ||
        result.kind === 'unsupportedMethod'
      ) {
        return { kind: 'refused', reason: result.kind }
      }
      // Why only what applied rather than everything sent: a host that refused a credential, or kept
      // its own value, must not be told to delete it later — that would take a credential the user set
      // up on that host with the removal of one this host never received.
      const applied = recordOutcome(environmentId, payload, result.report)
      if ((epochs.get(environmentId) ?? 0) !== epoch) {
        // The host was forgotten while this push was in flight; its outcome is no longer ours to keep.
        return { kind: 'refused', reason: 'needsSnapshot' }
      }
      records.set(environmentId, { revision: payload.revision, credentialIds: applied })
      return result.state.kind === 'synced'
        ? { kind: 'synced', revision: payload.revision, state: result.state }
        : { kind: 'partial', revision: payload.revision, report: result.report }
    }
  }
}
