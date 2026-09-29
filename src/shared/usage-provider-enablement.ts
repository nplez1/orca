/**
 * Which usage providers the user switched off.
 *
 * A disabled provider is neither queried (no usage/rate-limit poll) nor read from
 * installed tooling (no cursor-agent Keychain, `~/.codex/auth.json`, `gh` CLI,
 * Grok/Gemini/OpenCode auth files). Persisting the disabled set — rather than the
 * enabled set — keeps "enabled" the default for every provider a profile predates.
 *
 * Provider ids match `ProviderRateLimits['provider']` so the set can be handed
 * straight to the rate-limit service. `kimi` and `antigravity` are deliberately
 * absent: they have no provider section in Settings and no standalone switch.
 */
export const USAGE_PROVIDER_IDS = [
  'claude',
  'codex',
  'gemini',
  'opencode-go',
  'minimax',
  'deepseek',
  'fireworks',
  'copilot',
  'grok',
  'cursor'
] as const

export type DisableableUsageProviderId = (typeof USAGE_PROVIDER_IDS)[number]

const USAGE_PROVIDER_ID_SET: ReadonlySet<string> = new Set(USAGE_PROVIDER_IDS)

export function isDisableableUsageProviderId(value: unknown): value is DisableableUsageProviderId {
  return typeof value === 'string' && USAGE_PROVIDER_ID_SET.has(value)
}

/** Drops unknown ids and duplicates from a stored or hand-edited profile value. */
export function normalizeDisabledUsageProviders(value: unknown): DisableableUsageProviderId[] {
  if (!Array.isArray(value)) {
    return []
  }
  const disabled = new Set<DisableableUsageProviderId>()
  for (const entry of value) {
    if (isDisableableUsageProviderId(entry)) {
      disabled.add(entry)
    }
  }
  // Canonical order keeps persisted profiles byte-stable across toggles.
  return USAGE_PROVIDER_IDS.filter((providerId) => disabled.has(providerId))
}

export function isUsageProviderDisabled(
  disabled: readonly string[] | null | undefined,
  providerId: DisableableUsageProviderId
): boolean {
  return disabled?.includes(providerId) ?? false
}

export function withUsageProviderDisabled(
  disabled: readonly DisableableUsageProviderId[] | null | undefined,
  providerId: DisableableUsageProviderId,
  providerDisabled: boolean
): DisableableUsageProviderId[] {
  const next = new Set(disabled ?? [])
  if (providerDisabled) {
    next.add(providerId)
  } else {
    next.delete(providerId)
  }
  return USAGE_PROVIDER_IDS.filter((id) => next.has(id))
}
