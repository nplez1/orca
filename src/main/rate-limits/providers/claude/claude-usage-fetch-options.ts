import type { ProviderRateLimits } from '../../../../shared/agent-usage/rate-limits/rate-limit-types'
import type { NetworkProxySettings } from '../../../../shared/network/network-proxy'
import type { ClaudeRuntimeAuthPreparation } from '../../../claude-accounts/runtime-auth/runtime-auth-types'

export type ClaudeRateLimitFetchOptions = {
  authPreparation?: ClaudeRuntimeAuthPreparation
  allowPtyFallback?: boolean
  allowUsagePanelSupplement?: boolean
  /** Open Retry-After on the usage endpoint: the probe may answer, the endpoint must not be asked. */
  usageEndpointRetryAtMs?: number | null
  networkProxySettings?: NetworkProxySettings
  signal?: AbortSignal
}

export type ClaudeManagedAccountUsageOptions = {
  allowUsagePanelSupplement?: boolean
  networkProxySettings?: NetworkProxySettings
  /** One cycle's reads by login home, so accounts sharing a login are read once. */
  readsByHome?: Map<string, Promise<ProviderRateLimits>>
  signal?: AbortSignal
}
