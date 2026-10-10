import {
  HOST_SETTINGS_REPLICATION_PAYLOAD_VERSION,
  type HostSettingsReplicationApplyResult,
  type HostSettingsReplicationPayload,
  type HostSettingsSyncState
} from '../../shared/host-settings-replication'
import { HOST_SETTINGS_CREDENTIAL_REGISTRY } from './host-settings-credential-ports'
import type { HostSettingsCredentialRegistry } from './host-settings-credential-port'
import {
  createInMemoryHostSettingsReplicationHoldings,
  EMPTY_HOST_SETTINGS_REPLICATION_RECORD,
  type HostSettingsReplicationHoldings
} from './host-settings-replication-holdings'
import {
  applyHostSettingsPayload,
  decideHostSettingsPayload
} from './host-settings-replication-receiver'

/**
 * The receiving half, as the host's RPC handler uses it.
 *
 * The revision, the replicated credential ids and the first paired caller to push are all in the
 * holdings record, because losing any of them on a restart is a real state a user reaches: the main is
 * often asleep, so the host comes up alone and must still know what it holds and who configured it.
 */

export type { HostSettingsReplicationApplyResult }

/**
 * A payload as it arrives: the version is a number this build may not know, which is why the schema
 * accepts any integer and the decision below refuses an unknown one by name.
 */
type HostSettingsIncomingPayload = Pick<
  HostSettingsReplicationPayload,
  'baseRevision' | 'revision' | 'upserts' | 'removals' | 'unreadable'
> & { version: number }

/** Supplied by the RPC method; the in-memory default is for a test and for a host mid-startup. */
const defaultHoldings = createInMemoryHostSettingsReplicationHoldings()

// Why kept in memory beside the persisted record: it is this process's most recent outcome, which can
// be `partial` at a revision the record also has, and the refusals in it are not worth a file write on
// every push.
let lastState: HostSettingsSyncState | null = null

/** What this host last applied, or never-synced when it has not been pushed to. */
export function getHostSettingsReplication(
  holdings: HostSettingsReplicationHoldings = defaultHoldings
): { revision: number | null; state: HostSettingsSyncState } {
  const record = holdings.read()
  if (lastState !== null) {
    return { revision: record.revision, state: lastState }
  }
  return {
    revision: record.revision,
    state:
      record.revision === null
        ? { kind: 'neverSynced' }
        : { kind: 'synced', revision: record.revision, syncedAt: record.syncedAt ?? 0 }
  }
}

/** @internal — a fresh host process, and the boundary between test cases. */
export function resetHostSettingsReplication(): void {
  lastState = null
}

/**
 * Apply what the main sent.
 *
 * Why the payload is re-checked rather than trusted: it crosses a wire and arrives through a socket
 * this build does not fully control, so an unknown version is refused by name instead of applied as a
 * best guess, and the revision of a refused payload is never recorded.
 *
 * Why the first caller is pinned: every paired desktop holds `accounts-admin`, so without a pin a second
 * one could send a removal list and delete credentials the first configured. The pin is taken from the
 * first snapshot — the push that establishes the relationship — and an owner/local caller (no
 * fingerprint) is always allowed, because that is the user at this machine.
 */
export function applyHostSettingsReplication(
  payload: HostSettingsIncomingPayload,
  options: {
    registry?: HostSettingsCredentialRegistry
    now?: number
    holdings?: HostSettingsReplicationHoldings
    /** From the RPC context: which paired caller this is, when the transport could name one. */
    callerFingerprint?: string
  } = {}
): HostSettingsReplicationApplyResult {
  const holdings = options.holdings ?? defaultHoldings
  const record = holdings.read()
  const { callerFingerprint } = options

  if (
    callerFingerprint !== undefined &&
    record.mainFingerprint !== null &&
    record.mainFingerprint !== callerFingerprint &&
    // Why a snapshot may replace the pin: the fingerprint is derived from the pairing token, and every
    // new pairing offer mints a fresh one — so re-pairing the same laptop, or replacing it, changes the
    // fingerprint. Refusing that forever left a host nothing could ever configure again, silently, which
    // is worse than the problem the pin solves. A snapshot is the push that establishes a relationship;
    // a *delta* from a different caller is still refused, so a second paired client cannot delete what
    // the first configured merely by syncing.
    payload.baseRevision !== null
  ) {
    return { decision: 'refusedNotTheMain' }
  }

  const decision = decideHostSettingsPayload(record.revision, payload)
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
  // Why rebuilt rather than used in place: the schema accepts any integer version so an unknown one is
  // refused by name, and this is the point where the version is known to be this build's.
  const contractPayload: HostSettingsReplicationPayload = {
    version: HOST_SETTINGS_REPLICATION_PAYLOAD_VERSION,
    baseRevision: payload.baseRevision,
    revision: payload.revision,
    upserts: payload.upserts,
    removals: payload.removals,
    unreadable: payload.unreadable
  }

  // Why a snapshot clears what replication previously put here, and nothing else: the snapshot is
  // authoritative over the set it owns, which is how a removal reaches a host that restarted and no
  // longer has a revision for the delta that carried it. The host's own stores may also hold
  // credentials the user entered on this machine, and those are not in this list.
  //
  // Why `unreadable` is excluded: the main still holds those and could not read them for now, so
  // treating them as absent would delete a working credential on every host because a keyring on one
  // machine was locked.
  const incoming = new Set(contractPayload.upserts.map((credential) => credential.id))
  const unreadable = new Set(contractPayload.unreadable ?? [])
  const stranded =
    contractPayload.baseRevision === null
      ? record.ids.filter((id) => !incoming.has(id) && !unreadable.has(id))
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
    record.ids
      .filter((id) => !removed.has(id))
      .concat(
        // Why an unverified removal is recorded as held: the host demonstrably still has it, and without
        // this the record would stop naming it — so when the main's own ledger later stops naming it too,
        // nothing would ever look for it again.
        Object.entries(report.outcomes)
          .filter(([, outcome]) => outcome === 'removalUnverified')
          .map(([id]) => id)
      )
      .concat(
        contractPayload.upserts
          // Why these outcomes do not count as held: the host did not take the main's copy, so this is
          // not a replicated holding — it may not be there at all, or it may be the user's own value,
          // which a later removal must not delete.
          .filter((credential) => {
            const outcome = report.outcomes[credential.id]
            return (
              outcome !== undefined &&
              outcome !== 'removed' &&
              outcome !== 'refusedUnknownKind' &&
              outcome !== 'refusedWeakerProtection' &&
              outcome !== 'keptHostValue'
            )
          })
          .map((credential) => credential.id)
      )
  )

  holdings.write({
    ids: [...stillHeld],
    revision: contractPayload.revision,
    syncedAt: state.kind === 'neverSynced' || state.kind === 'failed' ? null : state.syncedAt,
    // Why the pin follows a snapshot: see the refusal above. A delta never moves it.
    mainFingerprint:
      contractPayload.baseRevision === null && callerFingerprint !== undefined
        ? callerFingerprint
        : record.mainFingerprint
  })

  lastState = state
  return { decision: 'applied', report, state }
}

export { EMPTY_HOST_SETTINGS_REPLICATION_RECORD }
