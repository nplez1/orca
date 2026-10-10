import type { SecretAtRestProtection } from './secret-at-rest-protection'

/**
 * The wire contract for host settings replication.
 *
 * Shape: the main pushes snapshot-or-delta, keyed on a revision. A host applies a delta only when
 * its own revision is the delta's base, so a host that was offline for a week asks for a snapshot
 * instead of replaying a queue it cannot order. (`docs/reference/host-settings-replication.md`.)
 *
 * Why the payload is opaque: each credential family has its own on-disk envelope, and the contract
 * must not grow a field per provider. The adapter registered for a `kind` owns the payload's shape,
 * and the two ends are the same build, so a `kind` an adapter does not know is refused by name
 * rather than half-applied.
 */

export const HOST_SETTINGS_REPLICATION_RUNTIME_CAPABILITY = 'host.settings.replicate.v1' as const

export const HOST_SETTINGS_REPLICATION_PAYLOAD_VERSION = 1

/** A credential the main wants a paired host to hold, in the form its adapter owns. */
export type ReplicatedHostCredential = {
  /** Stable across hosts, and the key revocation works from: `jira:<siteId>`, `api-key:deepseek`. */
  id: string
  /** Selects the receiving adapter. */
  kind: string
  /** Human label for "which host holds which credential" and for a refusal the user has to read. */
  label: string
  /** How the value sits on the sending host, so the receiver can refuse a downgrade. */
  protection: SecretAtRestProtection
  /**
   * The `replicatedOnlyIfEmpty` disposition. Required rather than optional so a producer has to make
   * the call from the field's disposition instead of inheriting "overwrite" by omission.
   */
  onlyIfEmpty: boolean
  payload: string
}

/**
 * One push. `baseRevision: null` means "apply all of this, it is a snapshot" — which is also what a
 * host asks for when it has never synced.
 */
export type HostSettingsReplicationPayload = {
  version: typeof HOST_SETTINGS_REPLICATION_PAYLOAD_VERSION
  baseRevision: number | null
  revision: number
  upserts: ReplicatedHostCredential[]
  /** Credential ids the main no longer holds, so the host must drop them. */
  removals: string[]
}

/** Whether a host may apply a payload as it stands, or has to ask for a snapshot first. */
export type HostSettingsPayloadDecision =
  | { kind: 'apply' }
  /** The host's revision is not this delta's base, so it needs a snapshot instead. */
  | { kind: 'needsSnapshot'; reason: 'revisionGap' | 'unknownBase' }
  /** A payload version this build does not know; a snapshot would not help. */
  | { kind: 'unsupportedVersion' }

/**
 * What the receiver did with one item. Every path is named so a silent overwrite and a silent
 * protection downgrade are both unrepresentable: the main can show the refusal instead of assuming
 * the host now holds the credential.
 */
export type HostSettingsApplyOutcome =
  /** The host now holds the main's value. */
  | 'applied'
  /** `replicatedOnlyIfEmpty` met a host that had its own value; nothing was overwritten. */
  | 'keptHostValue'
  /** The value is sealed and this host cannot seal; replicating would store it as plaintext. */
  | 'refusedWeakerProtection'
  /** No adapter is registered for the payload's `kind`. */
  | 'refusedUnknownKind'
  | 'removed'
  /** Deletion could not be proven against the host's own store, so it is not reported as gone. */
  | 'removalUnverified'

export type HostSettingsApplyReport = {
  revision: number
  outcomes: Record<string, HostSettingsApplyOutcome>
}

/**
 * What a paired host can say about its own replication state, before and after its first sync.
 *
 * Why `neverSynced` is its own case rather than an empty credential list: "not synced" and "you
 * have no integrations" look identical to a reader otherwise, and the second one is a lie.
 *
 * Why `partial` is not folded into `synced`: a refused credential means the host did not receive
 * everything the main holds, and reporting that as a clean sync is how a silently downgraded or
 * missing credential goes unnoticed.
 */
export type HostSettingsSyncState =
  | { kind: 'neverSynced' }
  | { kind: 'synced'; revision: number; syncedAt: number }
  | { kind: 'partial'; revision: number; syncedAt: number; refusals: string[] }
  | { kind: 'failed'; reason: string; failedAt: number }

/** Whether a host holds a replicated copy at all — the gate for "not synced" in the UI. */
export function hostSettingsHasSynced(state: HostSettingsSyncState): boolean {
  return state.kind === 'synced'
}
