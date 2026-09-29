import type { ProviderRateLimits } from '../../../../shared/rate-limit-types'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { USAGE_PROVIDER_IDS } from '../../../../shared/usage-provider-enablement'
import { hasCreditsData } from './provider-credits-format'

export type UsageProviderSettings = Pick<
  GlobalSettings,
  | 'codexManagedAccounts'
  | 'claudeManagedAccounts'
  | 'opencodeSessionCookie'
  | 'geminiCliOAuthEnabled'
> & {
  /** Widened to string so any provider id (including Kimi/Antigravity) can be checked. */
  disabledUsageProviders?: readonly string[]
  // Why: Antigravity has no separate persisted usage credential in Orca. The
  // checked status-bar item is the durable user signal; StatusBar only sets
  // this after PATH detection says the agent is available. Durability further
  // requires geminiCliOAuthEnabled — the snapshot mirrors the Gemini fetch,
  // which never yields data while that opt-in is off.
  antigravityUsageConfigured: boolean
  // Why: MiniMax/Grok sign-in live on disk, not in settings; main sets these each poll.
  minimaxCookieConfigured: boolean
  minimaxApiKeyConfigured: boolean
  // Why: the OpenCode Go key can live in OPENCODE_API_KEY or in OpenCode's own
  // store, neither of which the renderer can see; main reports presence.
  opencodeGoApiKeyConfigured: boolean
  grokAuthConfigured: boolean
  cursorAuthConfigured: boolean
  // Why: DeepSeek/Fireworks credentials are API keys stored outside GlobalSettings;
  // main derives these booleans each poll and the renderer never sees the key.
  deepseekApiKeyConfigured: boolean
  fireworksApiKeyConfigured: boolean
  // Why: the Copilot token and enterprise slug also live outside GlobalSettings.
  copilotTokenConfigured: boolean
}

type UsageProviderSnapshots = {
  claude: ProviderRateLimits | null | undefined
  codex: ProviderRateLimits | null | undefined
  gemini: ProviderRateLimits | null | undefined
  opencodeGo: ProviderRateLimits | null | undefined
  kimi: ProviderRateLimits | null | undefined
  antigravity: ProviderRateLimits | null | undefined
  minimax: ProviderRateLimits | null | undefined
  grok: ProviderRateLimits | null | undefined
  cursor: ProviderRateLimits | null | undefined
  zcode?: ProviderRateLimits | null
  deepseek: ProviderRateLimits | null | undefined
  fireworks: ProviderRateLimits | null | undefined
  copilot: ProviderRateLimits | null | undefined
}

type UsageProviderId = ProviderRateLimits['provider']

// Why: credits count as usage data — DeepSeek/Fireworks publish no window at all,
// so without this term every window-shaped caller reads them as "no data" and
// hides a configured, funded account behind the invisible-bar state.
function hasUsageData(provider: ProviderRateLimits): boolean {
  return Boolean(
    provider.session ||
    provider.weekly ||
    provider.fableWeekly ||
    provider.monthly ||
    (provider.buckets && provider.buckets.length > 0) ||
    // Why: an allowance-only plan (no percentage window) must still count as data, or
    // a configured enterprise account reads as "No usage data" again.
    provider.allowance ||
    hasCreditsData(provider)
  )
}

function isProviderSnapshotPending(provider: ProviderRateLimits | null | undefined): boolean {
  return provider == null || (provider.status === 'fetching' && !hasUsageData(provider))
}

// Why: a provider that returns `unavailable` is explicitly not configured
// (Gemini OAuth off, OpenCode Go cookie unset, Claude on API-key billing). Its
// fetch object is non-null, so a bare `!== null` check still renders a "--"
// bar for a provider the user never set up. `error` is kept visible on purpose
// — that's a *configured* provider failing transiently, and hiding it would
// make the bar flap on every refresh hiccup.
export function isProviderConfigured(
  provider: ProviderRateLimits | null | undefined
): provider is ProviderRateLimits {
  // Why: renderer HMR can briefly run against an older main process whose rate-limit
  // payload predates newer provider keys, so missing snapshots arrive as undefined.
  if (provider == null || provider.status === 'unavailable') {
    return false
  }
  if (provider.status === 'fetching' && !hasUsageData(provider)) {
    return false
  }
  return true
}

export function hasUsageProviderSettings(
  settings: Partial<UsageProviderSettings> | null | undefined
): boolean {
  if (!settings) {
    return false
  }
  // Why: a switched-off provider's durable setup must not count, or the status
  // bar keeps a pending bar for a provider the user explicitly disabled.
  return USAGE_PROVIDER_IDS.some((providerId) =>
    hasUsageProviderSettingsForProvider(providerId, settings)
  )
}

/** A provider the user switched off never shows a usage bar, however configured. */
export function isUsageProviderDisabledForBar(
  providerId: UsageProviderId,
  settings: Partial<UsageProviderSettings> | null | undefined
): boolean {
  return settings?.disabledUsageProviders?.includes(providerId) ?? false
}

export function hasUsageProviderSettingsForProvider(
  providerId: UsageProviderId,
  settings: Partial<UsageProviderSettings> | null | undefined
): boolean {
  if (!settings || isUsageProviderDisabledForBar(providerId, settings)) {
    return false
  }
  if (providerId === 'claude') {
    return (settings.claudeManagedAccounts?.length ?? 0) > 0
  }
  if (providerId === 'codex') {
    return (settings.codexManagedAccounts?.length ?? 0) > 0
  }
  if (providerId === 'gemini') {
    return settings.geminiCliOAuthEnabled === true
  }
  if (providerId === 'opencode-go') {
    return (
      Boolean(settings.opencodeSessionCookie?.trim()) ||
      settings.opencodeGoApiKeyConfigured === true
    )
  }
  if (providerId === 'antigravity') {
    // Why: the Antigravity snapshot mirrors the Gemini fetch, which stays
    // 'unavailable' until the user opts into Gemini CLI OAuth. Without that
    // gate the default-on checked item would pin a permanently dead bar.
    return settings.antigravityUsageConfigured === true && settings.geminiCliOAuthEnabled === true
  }
  if (providerId === 'minimax') {
    return settings.minimaxCookieConfigured === true || settings.minimaxApiKeyConfigured === true
  }
  if (providerId === 'grok') {
    return settings.grokAuthConfigured === true
  }
  if (providerId === 'cursor') {
    return settings.cursorAuthConfigured === true
  }
  if (providerId === 'deepseek') {
    return settings.deepseekApiKeyConfigured === true
  }
  if (providerId === 'fireworks') {
    return settings.fireworksApiKeyConfigured === true
  }
  if (providerId === 'copilot') {
    return settings.copilotTokenConfigured === true
  }
  return false
}

function createPendingProviderSnapshot(providerId: UsageProviderId): ProviderRateLimits {
  return {
    provider: providerId,
    session: null,
    weekly: null,
    ...(providerId === 'opencode-go' ? { monthly: null } : {}),
    // Why antigravity joins these: it reports one pool per model group, so its pending skeleton
    // has to be bucket-shaped too or the segment changes shape once the first reading lands.
    ...(providerId === 'gemini' || providerId === 'cursor' || providerId === 'antigravity'
      ? { buckets: [] }
      : {}),
    // Why: DeepSeek/Fireworks have no windows; their readout is the credits field.
    ...(providerId === 'deepseek' || providerId === 'fireworks' ? { credits: null } : {}),
    // Why: Copilot reports a monthly allowance rather than a quota window.
    ...(providerId === 'copilot' ? { monthly: null, allowance: null } : {}),
    updatedAt: 0,
    error: null,
    status: 'fetching'
  }
}

export function getVisibleUsageProvider(
  providerId: UsageProviderId,
  provider: ProviderRateLimits | null | undefined,
  settings: Partial<UsageProviderSettings> | null | undefined
): ProviderRateLimits | null {
  // Why: disabled must win over a live or in-flight snapshot, or a stale bar
  // lingers until the next cycle lands an `unavailable` result.
  if (isUsageProviderDisabledForBar(providerId, settings)) {
    return null
  }
  if (isProviderConfigured(provider)) {
    return provider
  }
  if (!hasUsageProviderSettingsForProvider(providerId, settings)) {
    return null
  }
  return provider ?? createPendingProviderSnapshot(providerId)
}

export function isUsageEmptyState(
  providers: UsageProviderSnapshots,
  settings: Partial<UsageProviderSettings> | null | undefined
): boolean {
  // Why: settings are the durable source for managed accounts. Until they
  // hydrate, avoid showing a setup CTA that can contradict connected accounts.
  if (!settings) {
    return false
  }
  // Why: system-default Claude/Codex accounts have no persisted account row;
  // their first durable signal is the usage snapshot, so wait for snapshots to
  // settle before teaching the user to connect an account.
  const antigravitySnapshotPending =
    hasUsageProviderSettingsForProvider('antigravity', settings) &&
    isProviderSnapshotPending(providers.antigravity)
  // Why: a disabled provider's null snapshot is not "pending" — it will never
  // settle, so it must not hold the setup CTA back forever.
  const pendingForBar = (
    providerId: UsageProviderId,
    provider: ProviderRateLimits | null | undefined
  ): boolean =>
    !isUsageProviderDisabledForBar(providerId, settings) && isProviderSnapshotPending(provider)
  if (
    pendingForBar('claude', providers.claude) ||
    pendingForBar('codex', providers.codex) ||
    pendingForBar('gemini', providers.gemini) ||
    pendingForBar('opencode-go', providers.opencodeGo) ||
    pendingForBar('kimi', providers.kimi) ||
    antigravitySnapshotPending ||
    pendingForBar('minimax', providers.minimax) ||
    pendingForBar('grok', providers.grok) ||
    pendingForBar('cursor', providers.cursor) ||
    (providers.zcode !== undefined && pendingForBar('zcode', providers.zcode)) ||
    pendingForBar('deepseek', providers.deepseek) ||
    pendingForBar('fireworks', providers.fireworks) ||
    pendingForBar('copilot', providers.copilot)
  ) {
    return false
  }
  return (
    !hasUsageProviderSettings(settings) &&
    !isProviderConfigured(providers.claude) &&
    !isProviderConfigured(providers.codex) &&
    !isProviderConfigured(providers.gemini) &&
    !isProviderConfigured(providers.opencodeGo) &&
    !isProviderConfigured(providers.kimi) &&
    !isProviderConfigured(providers.antigravity) &&
    !isProviderConfigured(providers.minimax) &&
    !isProviderConfigured(providers.grok) &&
    !isProviderConfigured(providers.cursor) &&
    !isProviderConfigured(providers.zcode) &&
    !isProviderConfigured(providers.deepseek) &&
    !isProviderConfigured(providers.fireworks) &&
    !isProviderConfigured(providers.copilot)
  )
}
