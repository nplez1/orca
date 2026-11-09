import type { ProviderRateLimits, RateLimitState } from '../rate-limit-types'
import {
  USAGE_PROVIDER_MANIFEST,
  USAGE_PROVIDER_MANIFEST_IDS,
  type ManifestUsageProviderId,
  type UsageProviderConfiguredFlag,
  type UsageProviderManifestEntry
} from './usage-provider-manifest'

/**
 * What a provider publishes before, and instead of, a live reading.
 *
 * Why separate from the manifest table: these are the derivations every consumer
 * needs, and keeping them beside a 250-line data literal pushed the file past the
 * `max-lines` budget. The table answers "what is this provider"; this answers
 * "what shape does its slot take, and which flags does it own".
 */

/** Whether a null slot for this provider means "not asked" rather than "no answer yet". */
export function usageProviderPendingNeedsSetup(providerId: ManifestUsageProviderId): boolean {
  const entry: UsageProviderManifestEntry = USAGE_PROVIDER_MANIFEST[providerId]
  return entry.pendingNeedsSetup === true
}

/**
 * The snapshot skeleton a provider shows before its first reading lands, and the
 * one a switched-off provider resolves to. Shared so the two cannot drift apart.
 */
export function usageProviderPendingReadout(
  providerId: ManifestUsageProviderId
): Partial<ProviderRateLimits> {
  const readout: Partial<ProviderRateLimits> = {}
  for (const field of USAGE_PROVIDER_MANIFEST[providerId].pendingReadout) {
    // Why an empty array: a bucket-backed provider lays out its pools from the list, so a
    // missing key would shift the row when the first real reading arrives.
    Object.assign(readout, { [field]: field === 'buckets' ? [] : null })
  }
  return readout
}

const indexBy = <K extends string, V>(entries: readonly (readonly [K, V])[]): Record<K, V> =>
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: `Object.fromEntries` widens the key to `string`; the tuples the callers pass already carry the key type.
  Object.fromEntries(entries) as Record<K, V>

/**
 * Provider id to its `RateLimitState` slot, so a consumer keyed by provider cannot
 * disagree with the entry that declares the slot.
 */
export const USAGE_PROVIDER_STATE_KEYS = indexBy(
  USAGE_PROVIDER_MANIFEST_IDS.map(
    (providerId) => [providerId, USAGE_PROVIDER_MANIFEST[providerId].stateKey] as const
  )
)

/** Every presence flag a switched-off provider must stop publishing. */
export function usageProviderConfiguredFlags(
  providerId: ManifestUsageProviderId
): readonly UsageProviderConfiguredFlag[] {
  return USAGE_PROVIDER_MANIFEST[providerId].configuredFlags
}

/** Every presence flag this build publishes, in manifest order. */
export const USAGE_PROVIDER_CONFIGURED_FLAGS: readonly UsageProviderConfiguredFlag[] =
  USAGE_PROVIDER_MANIFEST_IDS.flatMap((providerId) =>
    usageProviderConfiguredFlags(providerId).slice()
  )

/**
 * Presence flags for a snapshot that arrived from another host.
 *
 * Why every flag rather than the ones a host happened to send: an older host omits
 * the flags it predates, and a viewer must read an omission as "not configured"
 * rather than `undefined` leaking into a truthiness check.
 */
export function usageProviderConfiguredFlagDefaults(
  source: Partial<Pick<RateLimitState, UsageProviderConfiguredFlag>>
): Partial<Pick<RateLimitState, UsageProviderConfiguredFlag>> {
  const defaults: Partial<Pick<RateLimitState, UsageProviderConfiguredFlag>> = {}
  for (const flag of USAGE_PROVIDER_CONFIGURED_FLAGS) {
    defaults[flag] = source[flag] === true
  }
  return defaults
}

/** Slot key to provider id, so a consumer keyed by slot cannot disagree with the manifest. */
export const USAGE_PROVIDER_BY_STATE_KEY = indexBy(
  USAGE_PROVIDER_MANIFEST_IDS.map(
    (providerId) => [USAGE_PROVIDER_MANIFEST[providerId].stateKey, providerId] as const
  )
)

/**
 * Why: main derives these flags by reading credential files, so a switched-off
 * provider has to publish `false` without its store being touched. Spreading this
 * last makes that hold for a flag added later, not only the ones written by hand.
 */
export function disabledUsageProviderFlagOverrides(
  disabled: ReadonlySet<ManifestUsageProviderId>
): Partial<Pick<RateLimitState, UsageProviderConfiguredFlag>> {
  const overrides: Partial<Pick<RateLimitState, UsageProviderConfiguredFlag>> = {}
  for (const providerId of disabled) {
    for (const flag of usageProviderConfiguredFlags(providerId)) {
      overrides[flag] = false
    }
  }
  return overrides
}

/**
 * Whether this device holds a credential the owning host cannot use, so the
 * placeholder must say "sign in again here" rather than "not set up".
 *
 * Why read the manifest rather than name providers: replication moved several keys
 * onto ports, so a hand-written list goes stale in the direction that matters —
 * claiming a host cannot use a key it now receives.
 */
export function isUsageProviderSignInLocalOnly(
  local: Partial<Pick<RateLimitState, UsageProviderConfiguredFlag>>,
  providerId: ManifestUsageProviderId
): boolean {
  return USAGE_PROVIDER_MANIFEST[providerId].credentials.some(
    (credential) =>
      credential.kind === 'local-only' &&
      credential.flag !== undefined &&
      local[credential.flag] === true
  )
}
