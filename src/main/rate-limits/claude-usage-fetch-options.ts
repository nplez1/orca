import type { NetworkProxySettings } from '../../shared/network-proxy'
import type { ClaudeRuntimeAuthPreparation } from '../claude-accounts/runtime-auth-service'

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
  signal?: AbortSignal
}
