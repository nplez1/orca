import type { ProviderRateLimits, UsageRateLimitMetadata } from '../../shared/rate-limit-types'
import {
  refreshClaudeOAuthCredentials,
  type ClaudeOAuthRefreshOutcome
} from '../claude-accounts/claude-oauth-token-refresh'
import {
  readClaudeOAuthCredentials,
  type ClaudeOAuthCredentialReadResult,
  resolveClaudeOAuthCredentialReadOptions
} from './claude-oauth-credentials'
import { fetchClaudeOAuthUsage } from './claude-oauth-usage-request'
import { classifyClaudeOAuthUsageError } from './claude-usage-error-classification'
import { OAuthUsageError } from './claude-oauth-usage-error'
import type { ClaudeRateLimitFetchOptions } from './claude-usage-fetch-options'
import { abortedClaudeRateLimitResult, makeClaudeUsageResult } from './claude-usage-result'
import { CLAUDE_PROFILE_MISSING_MESSAGE } from '../../shared/claude-profile-routing'
import {
  claudeUsageEndpointGatedResult,
  openEndpointRetryAtMs,
  readActiveClaudeUsageFromProbe
} from './fork/claude-active-usage-probe'

const SIGN_IN_AGAIN = 'Sign in again to use this account.'

/**
 * Usage observes the account and never refreshes on a timer.
 *
 * A server-rejected token is the one signal that a stored refresh token is worth spending, and
 * the exchange is the only way usage recovers on a machine where Claude itself never runs.
 */
export async function fetchActiveClaudeRateLimits(
  options?: ClaudeRateLimitFetchOptions
): Promise<ProviderRateLimits> {
  const usageError = options?.authPreparation?.usageError
  if (usageError) {
    return makeClaudeUsageResult('error', usageError, {
      failureKind:
        usageError === CLAUDE_PROFILE_MISSING_MESSAGE ? 'missing-credentials' : 'usage-unavailable',
      attemptedSources: []
    })
  }
  if (options?.signal?.aborted) {
    return abortedClaudeRateLimitResult()
  }
  const credentials = await readClaudeOAuthCredentials(
    resolveClaudeOAuthCredentialReadOptions(options?.authPreparation)
  )
  const metadata = {
    credentialSource: credentials.source,
    authProvenance: options?.authPreparation?.provenance ?? 'system'
  }
  // fork-comment-ok: fork-only source ordering; see LOCAL-PATCHES.md `local(usage)`.
  // Why the endpoint is asked before the CLI probe: the endpoint is the sanctioned source and the
  // only one carrying `fableWeekly` / `extraUsage` / `monthly`, so a healthy endpoint must not be
  // shadowed. The probe answers when the endpoint cannot — held by its own Retry-After, or refused.
  const gatedRetryAtMs = openEndpointRetryAtMs(options)
  // Why the login check: an API-key account has no plan, so a turn spent here would be billed for a
  // reading it cannot produce.
  if (gatedRetryAtMs !== null && (credentials.token || credentials.hasRefreshableCredentials)) {
    const probed = await readActiveClaudeUsageFromProbe(options, undefined, credentials.token)
    if (probed) {
      return probed
    }
    if (options?.signal?.aborted) {
      return abortedClaudeRateLimitResult()
    }
  }
  if (options?.signal?.aborted) {
    return abortedClaudeRateLimitResult()
  }
  // System Default without login may be an API-key/non-Claude user, not a signed-out account.
  if (
    !credentials.token &&
    !credentials.unavailable &&
    !credentials.hasRefreshableCredentials &&
    metadata.authProvenance === 'system'
  ) {
    return makeClaudeUsageResult('unavailable', 'No subscription plan — API key billing', {
      ...metadata,
      failureKind: 'missing-credentials',
      attemptedSources: []
    })
  }
  if (credentials.unavailable) {
    return makeClaudeUsageResult('error', 'Claude usage is unavailable.', {
      ...metadata,
      failureKind: 'keychain-unavailable',
      attemptedSources: []
    })
  }
  if (credentials.token) {
    return readClaudeUsage(credentials.token, credentials, metadata, options)
  }
  if (!credentials.hasRefreshableCredentials) {
    return makeClaudeUsageResult('error', SIGN_IN_AGAIN, {
      ...metadata,
      failureKind: 'missing-credentials',
      attemptedSources: []
    })
  }
  const refreshGateMs = endpointRetryAtMs(options)
  if (refreshGateMs !== null) {
    return claudeUsageEndpointGatedResult(metadata, refreshGateMs)
  }
  // Why: a stored refresh token is the login; exchange it before asking for a sign-in.
  const outcome = await refreshStoredClaudeLogin(credentials, null)
  if (options?.signal?.aborted) {
    return abortedClaudeRateLimitResult()
  }
  if (outcome.status !== 'refreshed') {
    return refreshFailureResult(outcome, metadata)
  }
  return readClaudeUsage(outcome.accessToken, credentials, metadata, options, outcome.exchanged)
}

/** Fetch usage, and on a refused token spend the stored refresh token before reporting failure. */
async function readClaudeUsage(
  token: string,
  credentials: ClaudeOAuthCredentialReadResult,
  metadata: UsageRateLimitMetadata,
  options: ClaudeRateLimitFetchOptions | undefined,
  refreshedAlready = false
): Promise<ProviderRateLimits> {
  const gatedRetryAtMs = endpointRetryAtMs(options)
  if (gatedRetryAtMs !== null) {
    return claudeUsageEndpointGatedResult(metadata, gatedRetryAtMs)
  }
  try {
    return await fetchClaudeOAuthUsage(token, options?.signal)
  } catch (error) {
    if (options?.signal?.aborted) {
      return abortedClaudeRateLimitResult()
    }
    const classification = classifyClaudeOAuthUsageError(error)
    // Why skip on a refreshable refusal: the probe would be handed the token that was just refused,
    // and the CLI prefers an env token over its own keychain login, so it would fail for 15 s before
    // the refresh that actually fixes the account. The refreshed token is probed on the retry.
    if (!classification.shouldAttemptCredentialRefresh) {
      // fork-comment-ok: the CLI reports the plan windows without the endpoint (local(usage)).
      const probed = await readActiveClaudeUsageFromProbe(options, undefined, token)
      if (probed) {
        return probed
      }
      if (options?.signal?.aborted) {
        return abortedClaudeRateLimitResult()
      }
      return usageFailureResult(error, classification.failureKind, metadata)
    }
    // Why: a token this poll already spent is not spent again.
    if (refreshedAlready) {
      return signInRequiredResult(metadata)
    }
    const outcome = await refreshStoredClaudeLogin(credentials, token)
    if (options?.signal?.aborted) {
      return abortedClaudeRateLimitResult()
    }
    if (outcome.status !== 'refreshed') {
      return refreshFailureResult(outcome, metadata)
    }
    return readClaudeUsage(outcome.accessToken, credentials, metadata, options, outcome.exchanged)
  }
}

function endpointRetryAtMs(options: ClaudeRateLimitFetchOptions | undefined): number | null {
  // fork-comment-ok: an open Retry-After gates the endpoint request only, never the CLI probe.
  const retryAtMs = options?.usageEndpointRetryAtMs
  return retryAtMs && retryAtMs > Date.now() ? retryAtMs : null
}

function refreshStoredClaudeLogin(
  credentials: ClaudeOAuthCredentialReadResult,
  refusedAccessToken: string | null
): Promise<ClaudeOAuthRefreshOutcome> {
  return credentials.refreshTarget
    ? refreshClaudeOAuthCredentials(credentials.refreshTarget, refusedAccessToken)
    : Promise.resolve({ status: 'no-refresh-token' })
}

/** The stored login cannot renew itself any more: say whose move it is. */
function signInRequiredResult(metadata: UsageRateLimitMetadata): ProviderRateLimits {
  // Why the split: System Default has no account to re-select, so the only cure is Claude itself,
  // which is the calm copy the status bar already renders for it.
  return metadata.authProvenance === 'system'
    ? makeClaudeUsageResult('error', 'Claude usage updates the next time Claude runs.', {
        ...metadata,
        failureKind: 'stale-token',
        attemptedSources: ['oauth']
      })
    : makeClaudeUsageResult('error', SIGN_IN_AGAIN, {
        ...metadata,
        failureKind: 'missing-credentials',
        attemptedSources: ['oauth']
      })
}

/** The refresh did not produce a token: say whose move it is. */
function refreshFailureResult(
  outcome: Exclude<ClaudeOAuthRefreshOutcome, { status: 'refreshed' }>,
  metadata: UsageRateLimitMetadata
): ProviderRateLimits {
  // Why: a refused grant or an absent one is dead — only a fresh sign-in can renew the login.
  if (outcome.status === 'rejected' || outcome.status === 'no-refresh-token') {
    return signInRequiredResult(metadata)
  }
  // Why: a throttle or outage leaves the same login worth retrying on the next poll.
  return makeClaudeUsageResult('error', 'Claude usage is waiting for its sign-in to refresh.', {
    ...metadata,
    failureKind: 'refreshable-credentials-without-token',
    attemptedSources: ['oauth']
  })
}

function usageFailureResult(
  error: unknown,
  failureKind: ReturnType<typeof classifyClaudeOAuthUsageError>['failureKind'],
  metadata: UsageRateLimitMetadata
): ProviderRateLimits {
  // Why: the 429 wait gates the poll, and both messages tell the user why usage is missing.
  const retryAfterMs = error instanceof OAuthUsageError ? error.retryAfterMs : null
  const message =
    (failureKind === 'rate-limited' || failureKind === 'missing-scope') &&
    error instanceof OAuthUsageError
      ? error.message
      : 'Claude usage is unavailable.'
  return makeClaudeUsageResult('error', message, {
    ...metadata,
    failureKind,
    attemptedSources: ['oauth'],
    ...(retryAfterMs ? { retryAtMs: Date.now() + retryAfterMs } : {})
  })
}
