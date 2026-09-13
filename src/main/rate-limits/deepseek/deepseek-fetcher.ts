import { net } from 'electron'
import type { ProviderRateLimits } from '../../../shared/rate-limit-types'
import { makeDeepSeekError, makeDeepSeekUnavailable } from './deepseek-fetcher-data'
import { parseDeepSeekBalanceResponse } from './deepseek-fetcher-parse'

// Why: DeepSeek's balance endpoint sits outside /v1 (plural `/balance_infos`
// is the only path the docs publish).
const DEEPSEEK_BALANCE_URL = 'https://api.deepseek.com/user/balance'
const API_TIMEOUT_MS = 10_000

export type FetchDeepSeekRateLimitsOptions = { apiKey: string }

/**
 * Read-only DeepSeek prepaid balance. Never throws: every failure path returns
 * an error/unavailable snapshot, which is what the status bar renders.
 */
export async function fetchDeepSeekRateLimits(
  options: FetchDeepSeekRateLimitsOptions
): Promise<ProviderRateLimits> {
  // Why: guard a runtime undefined too — the settings read feeding this call
  // is not type-checked at the call site.
  const apiKey = typeof options.apiKey === 'string' ? options.apiKey.trim() : ''
  if (!apiKey) {
    return makeDeepSeekUnavailable('DeepSeek API key not configured')
  }
  try {
    // Why: plain net.fetch on the default session stays behind Orca's proxy
    // guard; a Bearer header needs no cookie jar.
    const response = await net.fetch(DEEPSEEK_BALANCE_URL, {
      headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(API_TIMEOUT_MS)
    })
    return await parseDeepSeekBalanceResponse(response)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'DeepSeek balance request failed'
    return makeDeepSeekError(message, 'network')
  }
}
