import type { ProviderRateLimits } from '../../../shared/rate-limit-types'
import {
  buildDeepSeekCredits,
  makeDeepSeekError,
  type DeepSeekBalanceResponse
} from './deepseek-fetcher-data'

// Why: split out of deepseek-fetcher.ts so the transport file stays a thin
// fetch + catch. Pure Response → ProviderRateLimits translation; no I/O.

function classifyDeepSeekHttpError(response: Response): ProviderRateLimits | null {
  if (response.status === 401 || response.status === 403) {
    return makeDeepSeekError(
      `DeepSeek API key rejected (HTTP ${response.status})`,
      'missing-credentials'
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
  const httpError = classifyDeepSeekHttpError(response)
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
    return makeDeepSeekError(message, 'parse')
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
