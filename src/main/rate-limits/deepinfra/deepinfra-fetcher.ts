import { getMainHttpClient } from '../../network/http-client'
import type { ProviderRateLimits } from '../../../shared/rate-limit-types'
import {
  DEEPINFRA_API_BASE_URL,
  DEEPINFRA_CHECKLIST_PATH,
  DEEPINFRA_REQUEST_TIMEOUT_MS,
  makeDeepInfraError,
  makeDeepInfraUnavailable
} from './deepinfra-fetcher-data'
import { parseDeepInfraChecklistResponse } from './deepinfra-fetcher-parse'

export type FetchDeepInfraRateLimitsOptions = { apiKey: string }

/**
 * DeepInfra's remaining credit balance, from the billing checklist the dashboard
 * itself reads. Never throws: every failure path returns an error/unavailable
 * snapshot, which is what the status bar renders.
 */
export async function fetchDeepInfraRateLimits(
  options: FetchDeepInfraRateLimitsOptions
): Promise<ProviderRateLimits> {
  // Why: guard a runtime undefined too — the settings read feeding this call
  // is not type-checked at the call site.
  const apiKey = typeof options.apiKey === 'string' ? options.apiKey.trim() : ''
  if (!apiKey) {
    return makeDeepInfraUnavailable('DeepInfra API key not configured')
  }
  try {
    // Why: the host HTTP port, not Electron directly — the runtime and orcad load this
    // module too, and only the desktop build has Chromium's network stack.
    const response = await getMainHttpClient().fetch(
      `${DEEPINFRA_API_BASE_URL}${DEEPINFRA_CHECKLIST_PATH}`,
      {
        method: 'GET',
        headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
        signal: AbortSignal.timeout(DEEPINFRA_REQUEST_TIMEOUT_MS)
      }
    )
    return await parseDeepInfraChecklistResponse(response)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'DeepInfra billing request failed'
    return makeDeepInfraError(message, 'network')
  }
}
