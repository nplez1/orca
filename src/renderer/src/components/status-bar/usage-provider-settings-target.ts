import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type { ProviderRateLimits } from '../../../../shared/rate-limit-types'

export function getUsageProviderAccountsSectionId(
  provider: ProviderRateLimits['provider']
): string | null {
  switch (provider) {
    case 'claude':
      return 'accounts-claude'
    case 'codex':
      return 'accounts-codex'
    case 'gemini':
      return 'accounts-gemini'
    case 'opencode-go':
      return 'accounts-opencode-go'
    case 'minimax':
      return 'accounts-minimax'
    case 'grok':
      return 'accounts-grok'
    case 'cursor':
      return 'accounts-cursor'
    case 'deepseek':
      return 'accounts-deepseek'
    case 'fireworks':
      return 'accounts-fireworks'
    case 'deepinfra':
      return 'accounts-deepinfra'
    case 'copilot':
      return 'accounts-copilot'
    case 'antigravity':
    case 'kimi':
      // fork-comment-ok: both have account sections now, but nothing in them signs in from this row.
      return null
    case 'zcode':
      return 'accounts-zcode'
  }
}

/** Whether a signed-out usage row is a Sign in shortcut to Settings instead of the provider's menu. */
export function usageRowSignInOpensSettings(
  provider: ProviderRateLimits['provider'],
  settings: Pick<GlobalSettings, 'activeRuntimeEnvironmentId' | 'claudeManagedAccounts'> | null
): boolean {
  if (getUsageProviderAccountsSectionId(provider) === null) {
    return false
  }
  // Saved local Claude accounts offer inline sign-in; remote rosters are absent from local settings and keep the shortcut.
  return !(
    provider === 'claude' &&
    !settings?.activeRuntimeEnvironmentId?.trim() &&
    (settings?.claudeManagedAccounts?.length ?? 0) > 0
  )
}
