import type { ProviderRateLimits } from '../../../shared/rate-limit-types'
import { parseUsageRetryAfterMs } from '../providers/usage-retry-after'
import { classifyThrownUsageRequestError } from '../providers/usage-request-failure-kind'
import {
  buildDeepSeekCredits,
  makeDeepSeekError,
  type DeepSeekBalanceResponse
} from './deepseek-fetcher-data'

// Why: split out of deepseek-fetcher.ts so the transport file stays a thin
// fetch + catch. Pure Response → ProviderRateLimits translation; no I/O.

function classifyDeepSeekHttpError(response: Response, nowMs: number): ProviderRateLimits | null {
  if (response.status === 401 || response.status === 403) {
    return makeDeepSeekError(
      `DeepSeek API key rejected (HTTP ${response.status})`,
      'missing-credentials'
    )
  }
  // Why: a 429 is the endpoint asking Orca to stop, so the poll gate needs the wait it asked for.
  if (response.status === 429) {
    const retryAfterMs = parseUsageRetryAfterMs(response.headers.get('retry-after'), nowMs)
    return makeDeepSeekError(
      'DeepSeek balance is rate limited right now',
      'rate-limited',
      retryAfterMs === null ? undefined : nowMs + retryAfterMs
    )
  }
  if (!response.ok) {
    return makeDeepSeekError(`DeepSeek balance request failed (HTTP ${response.status})`, 'server')
  }
  return null
}

export async function parseDeepSeekBalanceResponse(
  response: Response
): Promise<ProviderRateLimits> {
  const httpError = classifyDeepSeekHttpError(response, Date.now())
  if (httpError) {
    return httpError
  }
  let payload: DeepSeekBalanceResponse
  try {
    const value: unknown = await response.json()
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return makeDeepSeekError('Invalid DeepSeek balance response', 'parse')
    }
    payload = value
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Invalid DeepSeek balance response'
    // Why: an abort mid-body is a network failure, not an unreadable payload.
    return makeDeepSeekError(message, classifyThrownUsageRequestError(error))
  }
  const credits = buildDeepSeekCredits(payload)
  if (!credits) {
    return makeDeepSeekError('DeepSeek balance response had no readable balance', 'parse')
  }
  return {
    provider: 'deepseek',
    // Why: DeepSeek publishes no quota window and no usage history, so both
    // window slots stay null and only the balance headline is rendered.
    session: null,
    weekly: null,
    credits,
    updatedAt: Date.now(),
    error: null,
    status: 'ok',
    usageMetadata: { source: 'web' }
  }
}
