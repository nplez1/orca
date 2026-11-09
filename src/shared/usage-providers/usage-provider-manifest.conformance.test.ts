import { describe, expect, it } from 'vitest'
import { createEmptyRateLimitState } from '../rate-limit-state-factory'
import type { ProviderRateLimits } from '../rate-limit-types'
import { StatusBarItem } from '../rpc-contract/client-ui-params'
import { DEFAULT_STATUS_BAR_ITEMS } from '../status-bar-defaults'
import type { StatusBarItem as StatusBarItemUnion } from '../ui-chrome-types'
import { USAGE_PROVIDER_IDS } from '../usage-provider-enablement'
import {
  FORK_USAGE_PROVIDER_IDS,
  USAGE_PROVIDER_MANIFEST,
  USAGE_PROVIDER_MANIFEST_IDS,
  isForkUsageProvider
} from './usage-provider-manifest'
import {
  USAGE_PROVIDER_BY_STATE_KEY,
  USAGE_PROVIDER_CONFIGURED_FLAGS,
  disabledUsageProviderFlagOverrides,
  isUsageProviderSignInLocalOnly,
  usageProviderConfiguredFlagDefaults,
  usageProviderPendingNeedsSetup,
  usageProviderPendingReadout
} from './usage-provider-readouts'

/**
 * Why this file exists: the manifest is the fork's one place to classify a usage
 * provider, and a type can only prove the halves it can see. These are the rest —
 * the zod enum, the default status bar, the enablement list, the snapshot slots and
 * the presence flags. Each was an independent hand-written list that a provider
 * upstream adds would have slipped past silently.
 */

/** The status bar items that are not usage providers. */
const NON_PROVIDER_STATUS_BAR_ITEMS = new Set<string>(['ssh', 'resource-usage', 'ports'])

// Why: `DEFAULT_STATUS_BAR_ITEMS` is typed `StatusBarItem[]`, so the only way a zod
// member the TypeScript union lacks can surface is by assigning the zod tuple here.
const ALL_STATUS_BAR_ITEMS: readonly StatusBarItemUnion[] = StatusBarItem.options

const sorted = (values: Iterable<string>): string[] => [...values].sort()

/**
 * The readout skeleton each provider must publish before its first reading, with
 * the placeholder values spelled out rather than read back from the manifest.
 */
const EXPECTED_PENDING_READOUT: Record<ProviderRateLimits['provider'], object> = {
  claude: {},
  codex: {},
  gemini: { buckets: [] },
  antigravity: { buckets: [] },
  'opencode-go': { monthly: null },
  kimi: {},
  minimax: {},
  deepseek: { credits: null },
  fireworks: { credits: null },
  deepinfra: { credits: null },
  copilot: { monthly: null, allowance: null },
  grok: {},
  cursor: { buckets: [] },
  zcode: {},
  muse: {}
}

const allFlagsPresent = (): Record<string, boolean> =>
  Object.fromEntries(USAGE_PROVIDER_CONFIGURED_FLAGS.map((flag) => [flag, true]))

describe('USAGE_PROVIDER_MANIFEST', () => {
  it('classifies exactly the providers whose usage can be switched off', () => {
    expect(sorted(USAGE_PROVIDER_MANIFEST_IDS)).toEqual(sorted(USAGE_PROVIDER_IDS))
  })

  it('classifies exactly the providers the status bar can meter', () => {
    const statusBarProviders = DEFAULT_STATUS_BAR_ITEMS.filter(
      (item) => !NON_PROVIDER_STATUS_BAR_ITEMS.has(item)
    )
    expect(sorted(USAGE_PROVIDER_MANIFEST_IDS)).toEqual(sorted(statusBarProviders))
  })

  it('classifies exactly the provider members of the wire StatusBarItem enum', () => {
    // Why both directions: a provider missing from the enum is one the renderer rejects,
    // and a zod member the TypeScript union lacks is the same failure the other way.
    expect(sorted(ALL_STATUS_BAR_ITEMS)).toEqual(
      sorted([...USAGE_PROVIDER_MANIFEST_IDS, ...NON_PROVIDER_STATUS_BAR_ITEMS])
    )
    expect(sorted(StatusBarItem.options)).toEqual(sorted(DEFAULT_STATUS_BAR_ITEMS))
  })

  it('classifies exactly the snapshot slots of the empty rate-limit state', () => {
    const slots = Object.entries(createEmptyRateLimitState())
      .filter(([, value]) => value === null)
      .map(([key]) => key)
    expect(
      sorted(USAGE_PROVIDER_MANIFEST_IDS.map((id) => USAGE_PROVIDER_MANIFEST[id].stateKey))
    ).toEqual(sorted(slots))
  })

  it('maps each slot back to its own provider, so a slot cannot name another', () => {
    const entries = Object.entries(USAGE_PROVIDER_BY_STATE_KEY)
    expect(sorted(entries.map(([slot]) => slot))).toEqual(
      sorted(USAGE_PROVIDER_MANIFEST_IDS.map((id) => USAGE_PROVIDER_MANIFEST[id].stateKey))
    )
    for (const [slot, providerId] of entries) {
      expect(USAGE_PROVIDER_MANIFEST[providerId].stateKey).toBe(slot)
    }
  })

  it('classifies every presence flag the empty state publishes, and only those', () => {
    const stateFlags = Object.entries(createEmptyRateLimitState())
      .filter(([, value]) => typeof value === 'boolean')
      .map(([key]) => key)
    expect(sorted(USAGE_PROVIDER_CONFIGURED_FLAGS)).toEqual(sorted(stateFlags))
    // Why: a flag claimed by two providers would make one switch clear the other's.
    expect(new Set(USAGE_PROVIDER_CONFIGURED_FLAGS).size).toBe(
      USAGE_PROVIDER_CONFIGURED_FLAGS.length
    )
  })

  it('derives the fork set from `owner`, and agrees with `isForkUsageProvider`', () => {
    for (const providerId of FORK_USAGE_PROVIDER_IDS) {
      expect(USAGE_PROVIDER_MANIFEST[providerId].owner).toBe('fork')
      expect(isForkUsageProvider(providerId)).toBe(true)
    }
    expect(FORK_USAGE_PROVIDER_IDS).toEqual(
      USAGE_PROVIDER_MANIFEST_IDS.filter(
        (providerId) => USAGE_PROVIDER_MANIFEST[providerId].owner === 'fork'
      )
    )
    expect(isForkUsageProvider('claude')).toBe(false)
  })
})

describe('usageProviderPendingReadout', () => {
  it('gives each provider the readout skeleton its first reading fills', () => {
    for (const providerId of USAGE_PROVIDER_MANIFEST_IDS) {
      expect(usageProviderPendingReadout(providerId), providerId).toEqual(
        EXPECTED_PENDING_READOUT[providerId]
      )
    }
  })

  it('marks only the providers whose read is gated by an enable switch', () => {
    // Why: an unset switch publishes no snapshot at all, and treating that as a fetch
    // in flight is what would hold the setup CTA back forever.
    const gated = USAGE_PROVIDER_MANIFEST_IDS.filter((providerId) =>
      usageProviderPendingNeedsSetup(providerId)
    )
    expect(sorted(gated)).toEqual(['antigravity'])
  })
})

describe('disabledUsageProviderFlagOverrides', () => {
  it('clears exactly the switched-off provider flags', () => {
    for (const providerId of USAGE_PROVIDER_MANIFEST_IDS) {
      const overrides = disabledUsageProviderFlagOverrides(new Set([providerId]))
      expect(Object.keys(overrides).sort(), providerId).toEqual(
        [...USAGE_PROVIDER_MANIFEST[providerId].configuredFlags].sort()
      )
      expect(Object.values(overrides).every((value) => value === false)).toBe(true)
    }
  })

  it('clears every flag when every provider is off', () => {
    const overrides = disabledUsageProviderFlagOverrides(new Set(USAGE_PROVIDER_MANIFEST_IDS))
    expect(sorted(Object.keys(overrides))).toEqual(sorted(USAGE_PROVIDER_CONFIGURED_FLAGS))
  })
})

describe('usageProviderConfiguredFlagDefaults', () => {
  it('reads an omission from an older host as not configured', () => {
    const defaults = usageProviderConfiguredFlagDefaults({ minimaxCookieConfigured: true })
    expect(sorted(Object.keys(defaults))).toEqual(sorted(USAGE_PROVIDER_CONFIGURED_FLAGS))
    expect(defaults.minimaxCookieConfigured).toBe(true)
    expect(defaults.minimaxApiKeyConfigured).toBe(false)
    expect(defaults.copilotTokenConfigured).toBe(false)
  })
})

describe('isUsageProviderSignInLocalOnly', () => {
  it('names the providers whose credential replication does not carry', () => {
    // Why three: MiniMax's session cookie, and Fireworks' and Copilot's structured
    // payloads. Every other key is either on a host-settings port or the CLI's own.
    const localOnly = USAGE_PROVIDER_MANIFEST_IDS.filter((providerId) =>
      isUsageProviderSignInLocalOnly(allFlagsPresent(), providerId)
    )
    expect(sorted(localOnly)).toEqual(['copilot', 'fireworks', 'minimax'])
  })

  it('is false for a provider whose key replicates', () => {
    expect(isUsageProviderSignInLocalOnly({ zcodePlanApiKeyConfigured: true }, 'zcode')).toBe(false)
    expect(isUsageProviderSignInLocalOnly({ deepseekApiKeyConfigured: true }, 'deepseek')).toBe(
      false
    )
  })

  it('is false for a local-only credential the user has not set', () => {
    expect(isUsageProviderSignInLocalOnly({}, 'fireworks')).toBe(false)
  })
})
