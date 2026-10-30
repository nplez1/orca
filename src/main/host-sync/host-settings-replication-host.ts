import {
  HOST_SETTINGS_REPLICATION_PAYLOAD_VERSION,
  type HostSettingsReplicationApplyResult,
  type HostSettingsReplicationPayload,
  type HostSettingsSyncState
} from '../../shared/host-settings-replication'
import { HOST_SETTINGS_CREDENTIAL_REGISTRY } from './host-settings-credential-ports'
import type {
  HostSettingsCredentialPort,
  HostSettingsCredentialRegistry
} from './host-settings-credential-port'
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
 *
 * Why the pin is NOT a trust boundary: a refused caller can send a snapshot instead of a delta, which is
 * accepted while the pin is unverifiable and, in doing so, deletes every credential replication owns and
 * re-pins the host to that caller. See docs/reference/host-settings-replication.md § "What the pin does
 * not do". It refuses an accidental second writer, not a malicious paired desktop — pairing already
 * implies command execution on this host, so nothing here can be the boundary.
 */
export function applyHostSettingsReplication(
  payload: HostSettingsIncomingPayload,
  options: {
    registry?: HostSettingsCredentialRegistry
    now?: number
    holdings?: HostSettingsReplicationHoldings
    /** From the RPC context: which paired caller this is, when the transport could name one. */
    callerFingerprint?: string
    /** From the RPC context: the paired device row, which survives a re-pair of that device. */
    callerDeviceId?: string
    /** From the RPC context: whether a pairing row this host recorded still exists. */
    isPairedDeviceAlive?: (deviceId: string) => boolean
  } = {}
): HostSettingsReplicationApplyResult {
  const holdings = options.holdings ?? defaultHoldings
  const record = holdings.read()
  const { callerFingerprint, callerDeviceId } = options

  // Why removing the pairing is the escape hatch: every pairing mints a fresh device row and token, so
  // a re-pair of the same laptop is indistinguishable from another machine by both identities. What the
  // host can check is whether the row its pin names is still there — and the user can remove that row
  // on this host, which is explicit and visible rather than a silent takeover by whoever reconnects.
  //
  // Why an unrecorded row also frees the pin: a record written by a build before this one has no device
  // id, so nothing can be verified; the next snapshot stamps one, and the pin is enforced from then on.
  const pinVerified =
    record.mainFingerprint !== null &&
    record.mainDeviceId !== null &&
    (options.isPairedDeviceAlive?.(record.mainDeviceId) ?? true)

  const isPinnedCaller =
    callerFingerprint !== undefined && record.mainFingerprint === callerFingerprint

  if (callerFingerprint !== undefined && record.mainFingerprint !== null && !isPinnedCaller) {
    // Why a delta is always refused: a delta cannot establish a relationship in the first place, so the
    // only thing it can do here is delete what the pinned machine put on this host.
    if (payload.baseRevision !== null) {
      return { decision: 'refusedNotTheMain' }
    }
    if (pinVerified) {
      console.warn(
        '[host-settings] refused a snapshot from a different paired machine; remove the stale pairing on this host to hand it over'
      )
      return { decision: 'refusedNotTheMain' }
    }
    // Why this branch is the honest limit of the pin: an unverifiable pin admits the snapshot, which
    // clears what replication owns and stamps this caller as the new main. It is deliberate — a host
    // whose pairing row is gone has no other way to be adopted — and it is not a security boundary.
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
    // Why the record rather than the payload: it is the only list of what replication put here, and a
    // value on the host that is not in it is the user's own — see `applyHostSettingsPayload`.
    replicatedIds: [...record.ids, ...recoverReplicatedIds(registry, contractPayload, record)],
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

  const establishesAuthority = contractPayload.baseRevision === null
  holdings.write({
    ids: [...stillHeld],
    revision: contractPayload.revision,
    syncedAt: state.kind === 'neverSynced' || state.kind === 'failed' ? null : state.syncedAt,
    // Why the pin follows a snapshot: see the refusal above. A delta never moves it.
    mainFingerprint: !establishesAuthority ? record.mainFingerprint : (callerFingerprint ?? null),
    // Why the local owner clears the pin: a caller with no fingerprint is the user at this machine, so
    // configuring the host here is how they take it back from a desktop that has since gone away — the
    // one escape hatch left when the pinned device no longer exists to re-pair.
    mainDeviceId: !establishesAuthority
      ? record.mainDeviceId
      : callerFingerprint === undefined
        ? null
        : (callerDeviceId ?? record.mainDeviceId)
  })

  lastState = state
  return { decision: 'applied', report, state }
}

export { EMPTY_HOST_SETTINGS_REPLICATION_RECORD }

/**
 * Ids this host already holds with the main's exact value, when the holdings record says it never synced.
 *
 * Why: a corrupt or unwritten holdings file makes every value on the host look like the user's own, so
 * the host keeps a credential the main can no longer rotate or revoke — silently and for good. An
 * identical value is the one piece of evidence that this is replication's copy rather than the user's.
 */
function recoverReplicatedIds(
  registry: HostSettingsCredentialRegistry,
  payload: HostSettingsReplicationPayload,
  record: { ids: readonly string[]; revision: number | null }
): string[] {
  if (record.ids.length > 0 || record.revision !== null) {
    return []
  }
  const heldById = new Map<string, string>()
  const listed = new Set<HostSettingsCredentialPort>()
  const recovered: string[] = []
  for (const credential of payload.upserts) {
    const port = registry.forCredentialId(credential.id)
    if (!port || port.kind !== credential.kind) {
      continue
    }
    if (!listed.has(port)) {
      listed.add(port)
      try {
        for (const held of port.list()) {
          heldById.set(held.id, held.payload)
        }
      } catch {
        // A family this host cannot read proves nothing either way, which is the safe answer here.
      }
    }
    if (heldById.get(credential.id) === credential.payload) {
      recovered.push(credential.id)
    }
  }
  return recovered
}
