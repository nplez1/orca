import type { UsageRateLimitFailureKind } from '../../shared/rate-limit-types'
import { ClaudeUsageRequestError, OAuthUsageError } from './claude-oauth-usage-error'

export type ClaudeUsageErrorClassification = {
  failureKind: UsageRateLimitFailureKind
  /** The usage endpoint refused the token: exchanging the stored refresh token may repair it. */
  shouldAttemptCredentialRefresh: boolean
}

export function classifyClaudeOAuthUsageError(error: unknown): ClaudeUsageErrorClassification {
  if (error instanceof OAuthUsageError) {
    if (error.status === 429) {
      return { failureKind: 'rate-limited', shouldAttemptCredentialRefresh: false }
    }
    if (error.status === 401) {
      return recoverableAuth('stale-token')
    }
    if (error.status === 403) {
      return error.message.includes('user:profile')
        ? { failureKind: 'missing-scope', shouldAttemptCredentialRefresh: false }
        : recoverableAuth('stale-token')
    }
    if (error.status >= 500) {
      return { failureKind: 'server', shouldAttemptCredentialRefresh: false }
    }
    return { failureKind: 'usage-unavailable', shouldAttemptCredentialRefresh: false }
  }

  if (error instanceof ClaudeUsageRequestError) {
    return { failureKind: error.failureKind, shouldAttemptCredentialRefresh: false }
  }
  return { failureKind: 'unknown', shouldAttemptCredentialRefresh: false }
}

function recoverableAuth(failureKind: UsageRateLimitFailureKind): ClaudeUsageErrorClassification {
  return { failureKind, shouldAttemptCredentialRefresh: true }
}
