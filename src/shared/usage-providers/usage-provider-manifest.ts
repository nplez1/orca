import type { ProviderRateLimits, RateLimitState } from '../rate-limit-types'

/** The `RateLimitState` slot holding one provider's snapshot. */
export type ProviderSlotKey = {
  [K in keyof RateLimitState]-?: RateLimitState[K] extends ProviderRateLimits | null ? K : never
}[keyof RateLimitState]

/** A `RateLimitState` boolean that publishes "this credential is present on this machine". */
export type UsageProviderConfiguredFlag = {
  [K in keyof RateLimitState]-?: RateLimitState[K] extends boolean | undefined ? K : never
}[keyof RateLimitState]

/**
 * A readout field a provider's snapshot carries even before its first reading.
 *
 * Why a skeleton rather than a per-provider builder: the disabled and pending
 * snapshots are the same shape, and both must not change the bar's layout when the
 * real reading lands. Declaring the fields here is what makes them one shape.
 */
export type UsageProviderReadout = 'monthly' | 'buckets' | 'credits' | 'allowance'

/**
 * Where a provider's credential lives, and therefore whether a paired host can use it.
 *
 * - `replicated`: the host-settings port with this `portKind` sends it to a paired host.
 * - `local-only`: a store on this machine that replication does not carry, with the reason.
 * - `tool-owned`: the installed CLI keeps the login; Orca reads it and never writes it.
 */
export type UsageProviderCredential =
  | {
      kind: 'replicated'
      /** Host-settings port that carries it; the conformance test proves the kind exists. */
      portKind: string
      /** Path under `src/main`, without the extension, so the census can claim the file. */
      storeModule: string
      flag?: UsageProviderConfiguredFlag
    }
  | {
      kind: 'local-only'
      /** Path under `src/main`, without the extension, so the census can claim the file. */
      storeModule: string
      flag?: UsageProviderConfiguredFlag
      reason: string
    }
  | {
      kind: 'tool-owned'
      /** Set when the CLI keeps its login in a store module this repo owns. */
      storeModule?: string
      flag?: UsageProviderConfiguredFlag
      reason: string
    }

export type UsageProviderManifestEntry = {
  /** `fork` providers are the ones this fork added; the status bar renders them itself. */
  owner: 'upstream' | 'fork'
  stateKey: ProviderSlotKey
  /** Every presence flag main publishes for this provider; empty when it has no key of its own. */
  configuredFlags: readonly UsageProviderConfiguredFlag[]
  pendingReadout: readonly UsageProviderReadout[]
  /**
   * A null slot reads as "not asked" until this provider is set up, rather than as
   * "asked, no answer yet". Set where an explicit enable switch gates the read.
   */
  pendingNeedsSetup?: true
  credentials: readonly UsageProviderCredential[]
}

/**
 * The fork's contract with upstream about usage providers.
 *
 * Why this file exists: a provider upstream adds in a sync must fail `pnpm tc` or a
 * test until someone classifies it — its enablement switch, its credential
 * replication, its status-bar wiring and its "key configured" flag. Without one
 * place to classify it, each of those is an ad-hoc list a new provider slips past
 * silently. `usage-provider-manifest.conformance.test.ts` and
 * `usage-provider-credential-census.test.ts` are the half a type cannot check.
 *
 * Adding a provider means: an entry here, a row in the census for any new store, and
 * `USAGE_PROVIDER_IDS` in `../usage-provider-enablement.ts`.
 */
export const USAGE_PROVIDER_MANIFEST = {
  claude: {
    owner: 'upstream',
    stateKey: 'claude',
    // Why no flag: account selection is an account-service concern, not a key presence.
    configuredFlags: [],
    pendingReadout: [],
    credentials: [
      {
        kind: 'tool-owned',
        storeModule: 'claude-accounts/claude-oauth-credential-store',
        reason: 'Claude Code owns the login; the account service owns selection and refresh.'
      }
    ]
  },
  codex: {
    owner: 'upstream',
    stateKey: 'codex',
    configuredFlags: [],
    pendingReadout: [],
    credentials: [
      { kind: 'tool-owned', reason: 'The Codex CLI keeps its own auth.json in its runtime home.' }
    ]
  },
  gemini: {
    owner: 'upstream',
    stateKey: 'gemini',
    configuredFlags: [],
    pendingReadout: ['buckets'],
    credentials: [
      { kind: 'tool-owned', reason: 'The Gemini CLI keeps the OAuth token it was signed in with.' }
    ]
  },
  antigravity: {
    owner: 'upstream',
    stateKey: 'antigravity',
    configuredFlags: [],
    pendingReadout: ['buckets'],
    // Why: agy is read only while `antigravityUsageConfigured` is set, so an unset
    // switch publishes no snapshot at all — which must not read as a fetch in flight.
    pendingNeedsSetup: true,
    credentials: [
      {
        kind: 'local-only',
        storeModule: 'antigravity/native-account-store',
        // Why: the vault holds each account's credential string, so it is Orca's own
        // encrypted store rather than the CLI's login — and no port carries it.
        reason: 'Encrypted account vault this build owns; replication has no port for it.'
      },
      { kind: 'tool-owned', reason: 'agy keeps the native login this reads.' }
    ]
  },
  'opencode-go': {
    owner: 'upstream',
    stateKey: 'opencodeGo',
    configuredFlags: ['opencodeGoApiKeyConfigured'],
    pendingReadout: ['monthly'],
    credentials: [
      {
        kind: 'replicated',
        portKind: 'api-key:opencode-go',
        storeModule: 'opencode/opencode-go-api-key-store',
        flag: 'opencodeGoApiKeyConfigured'
      },
      {
        kind: 'tool-owned',
        reason: 'A key from the OpenCode environment or its own CLI store is read, never copied.'
      }
    ]
  },
  kimi: {
    owner: 'upstream',
    stateKey: 'kimi',
    configuredFlags: [],
    pendingReadout: [],
    credentials: [{ kind: 'tool-owned', reason: 'Kimi reads the CLI home resolved per runtime.' }]
  },
  minimax: {
    owner: 'upstream',
    stateKey: 'minimax',
    configuredFlags: ['minimaxCookieConfigured', 'minimaxApiKeyConfigured'],
    pendingReadout: [],
    credentials: [
      {
        kind: 'replicated',
        portKind: 'api-key:minimax',
        storeModule: 'minimax/minimax-api-key-store',
        flag: 'minimaxApiKeyConfigured'
      },
      {
        kind: 'local-only',
        storeModule: 'minimax/minimax-cookie-store',
        flag: 'minimaxCookieConfigured',
        // Why: a browser session cookie is a web login, not a key the port contract can seal and
        // re-issue; replicating it would hand a host a session the user never signed in for.
        reason: 'A session cookie is a web login, not a sealable API key.'
      }
    ]
  },
  deepseek: {
    owner: 'fork',
    stateKey: 'deepseek',
    configuredFlags: ['deepseekApiKeyConfigured'],
    pendingReadout: ['credits'],
    credentials: [
      {
        kind: 'replicated',
        portKind: 'api-key:deepseek',
        storeModule: 'deepseek/deepseek-api-key-store',
        flag: 'deepseekApiKeyConfigured'
      }
    ]
  },
  fireworks: {
    owner: 'fork',
    stateKey: 'fireworks',
    configuredFlags: ['fireworksApiKeyConfigured'],
    pendingReadout: ['credits'],
    credentials: [
      {
        kind: 'local-only',
        storeModule: 'fireworks/fireworks-credentials-store',
        flag: 'fireworksApiKeyConfigured',
        // Why: the store is one envelope holding the key beside an optional account id, so it needs
        // its own replication adapter rather than the single-key port factory.
        reason: 'Structured payload (key plus account id); needs its own replication adapter.'
      }
    ]
  },
  deepinfra: {
    owner: 'fork',
    stateKey: 'deepinfra',
    configuredFlags: ['deepinfraApiKeyConfigured'],
    pendingReadout: ['credits'],
    credentials: [
      {
        kind: 'replicated',
        portKind: 'api-key:deepinfra',
        storeModule: 'deepinfra/deepinfra-api-key-store',
        flag: 'deepinfraApiKeyConfigured'
      }
    ]
  },
  copilot: {
    owner: 'fork',
    stateKey: 'copilot',
    configuredFlags: ['copilotTokenConfigured'],
    pendingReadout: ['monthly', 'allowance'],
    credentials: [
      {
        kind: 'local-only',
        storeModule: 'copilot-credentials/copilot-credentials-store',
        flag: 'copilotTokenConfigured',
        reason:
          'Structured payload (token plus enterprise slug); needs its own replication adapter.'
      },
      {
        kind: 'tool-owned',
        reason: 'A token borrowed from the gh CLI is read in place and never written by Orca.'
      }
    ]
  },
  grok: {
    owner: 'upstream',
    stateKey: 'grok',
    configuredFlags: ['grokAuthConfigured'],
    pendingReadout: [],
    credentials: [
      {
        kind: 'tool-owned',
        flag: 'grokAuthConfigured',
        reason: 'The Grok CLI auth file is read in place, and only while Grok is enabled.'
      }
    ]
  },
  cursor: {
    owner: 'upstream',
    stateKey: 'cursor',
    configuredFlags: ['cursorAuthConfigured'],
    pendingReadout: ['buckets'],
    credentials: [
      {
        kind: 'tool-owned',
        flag: 'cursorAuthConfigured',
        reason: 'Cursor keeps its login in the OS keychain and the IDE database.'
      }
    ]
  },
  zcode: {
    owner: 'upstream',
    stateKey: 'zcode',
    configuredFlags: ['zcodePlanApiKeyConfigured'],
    pendingReadout: [],
    credentials: [
      {
        kind: 'replicated',
        portKind: 'zcode-plan',
        storeModule: 'zcode/zcode-plan-api-key-store',
        flag: 'zcodePlanApiKeyConfigured'
      }
    ]
  },
  muse: {
    owner: 'upstream',
    stateKey: 'muse',
    configuredFlags: [],
    pendingReadout: [],
    credentials: [{ kind: 'tool-owned', reason: 'Muse usage is read from the installed CLI.' }]
  }
} as const satisfies Record<ProviderRateLimits['provider'], UsageProviderManifestEntry>

export type ManifestUsageProviderId = keyof typeof USAGE_PROVIDER_MANIFEST

type ManifestEntry = (typeof USAGE_PROVIDER_MANIFEST)[ManifestUsageProviderId]

// Why: a provider added to the union without an entry here, or an entry for a
// provider the union does not have, is already a `satisfies` error above. These
// three cover the other direction — a slot, a flag or a provider id that reaches
// the wire without anyone classifying it.
type ManifestStateKey = ManifestEntry['stateKey']
type UncoveredStateSlot = Exclude<ProviderSlotKey, ManifestStateKey>
const everyProviderSlotIsClassified: [UncoveredStateSlot] extends [never] ? true : never = true

type ManifestConfiguredFlag = ManifestEntry['configuredFlags'][number]
type UncoveredConfiguredFlag = Exclude<UsageProviderConfiguredFlag, ManifestConfiguredFlag>
const everyConfiguredFlagIsClassified: [UncoveredConfiguredFlag] extends [never] ? true : never =
  true

type UnknownConfiguredFlag = Exclude<ManifestConfiguredFlag, UsageProviderConfiguredFlag>
const everyManifestFlagExists: [UnknownConfiguredFlag] extends [never] ? true : never = true

void everyProviderSlotIsClassified
void everyConfiguredFlagIsClassified
void everyManifestFlagExists

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: `Object.keys` is typed `string[]`, and the object's own keys are exactly this union.
export const USAGE_PROVIDER_MANIFEST_IDS = Object.keys(
  USAGE_PROVIDER_MANIFEST
) as readonly ManifestUsageProviderId[]

/** Providers this fork added. The status bar renders them itself, from `FORK_USAGE_PROVIDERS`. */
export type ForkUsageProviderId = {
  [K in ManifestUsageProviderId]: (typeof USAGE_PROVIDER_MANIFEST)[K]['owner'] extends 'fork'
    ? K
    : never
}[ManifestUsageProviderId]

export const FORK_USAGE_PROVIDER_IDS: readonly ForkUsageProviderId[] =
  USAGE_PROVIDER_MANIFEST_IDS.filter(
    (providerId): providerId is ForkUsageProviderId =>
      USAGE_PROVIDER_MANIFEST[providerId].owner === 'fork'
  )

/** The `RateLimitState` slots the fork's providers occupy. */
export type ForkUsageStateKey = (typeof USAGE_PROVIDER_MANIFEST)[ForkUsageProviderId]['stateKey']

const FORK_USAGE_PROVIDER_ID_SET: ReadonlySet<string> = new Set(FORK_USAGE_PROVIDER_IDS)

export function isForkUsageProvider(provider: string): provider is ForkUsageProviderId {
  return FORK_USAGE_PROVIDER_ID_SET.has(provider)
}
