import { describe, expect, it } from 'vitest'
import { classifyClaudeOAuthUsageError } from './claude-usage-error-classification'
import { ClaudeUsageRequestError, OAuthUsageError } from './claude-oauth-usage-error'

describe('classifyClaudeOAuthUsageError', () => {
  it('treats OAuth unauthorized as a token the stored refresh token may repair', () => {
    expect(
      classifyClaudeOAuthUsageError(new OAuthUsageError('Invalid OAuth token', 401, true))
    ).toMatchObject({ failureKind: 'stale-token', shouldAttemptCredentialRefresh: true })
  })

  it('treats a non-scope 403 as the same refused token', () => {
    expect(
      classifyClaudeOAuthUsageError(new OAuthUsageError('Access denied', 403, true))
    ).toMatchObject({ failureKind: 'stale-token', shouldAttemptCredentialRefresh: true })
  })

  it('never spends a refresh token on a rate limit', () => {
    expect(
      classifyClaudeOAuthUsageError(new OAuthUsageError('Claude usage is rate limited', 429, true))
    ).toMatchObject({ failureKind: 'rate-limited', shouldAttemptCredentialRefresh: false })
  })

  it('classifies missing OAuth scope as an actionable state no refresh can fix', () => {
    expect(
      classifyClaudeOAuthUsageError(
        new OAuthUsageError("missing required scope 'user:profile'", 403, true)
      )
    ).toMatchObject({ failureKind: 'missing-scope', shouldAttemptCredentialRefresh: false })
  })

  it('treats network-shaped failures as retryable without touching the login', () => {
    expect(
      classifyClaudeOAuthUsageError(
        new ClaudeUsageRequestError(new Error('fetch failed: ENOTFOUND'))
      )
    ).toMatchObject({ failureKind: 'network', shouldAttemptCredentialRefresh: false })
  })

  it("classifies Electron's proxy failure as network and a malformed body as parse", () => {
    expect(
      classifyClaudeOAuthUsageError(
        new ClaudeUsageRequestError(new Error('net::ERR_PROXY_CONNECTION_FAILED'))
      ).failureKind
    ).toBe('network')
    expect(
      classifyClaudeOAuthUsageError(
        new ClaudeUsageRequestError(new SyntaxError('Unexpected token'))
      ).failureKind
    ).toBe('parse')
  })

  it('leaves an error from mapping a response unclassified', () => {
    expect(
      classifyClaudeOAuthUsageError(
        new TypeError("Cannot read properties of null (reading 'five_hour')")
      ).failureKind
    ).toBe('unknown')
  })
})
