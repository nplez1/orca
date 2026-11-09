import type { ProviderRateLimits } from '../../../shared/rate-limit-types'
import { parseUsageRetryAfterMs } from '../usage-retry-after'
import { classifyThrownUsageRequestError } from '../usage-request-failure-kind'
import {
  buildDeepInfraCredits,
  makeDeepInfraError,
  makeDeepInfraSuccess,
  type DeepInfraChecklist
} from './deepinfra-fetcher-data'

// Why: split out of deepinfra-fetcher.ts so the transport file stays a thin
// fetch + catch. Pure Response -> ProviderRateLimits translation; no I/O.

function classifyDeepInfraHttpError(response: Response, nowMs: number): ProviderRateLimits | null {
  if (response.status === 401 || response.status === 403) {
    return makeDeepInfraError(
      `DeepInfra rejected the API key (HTTP ${response.status}) — check it in Settings.`,
      'missing-credentials'
    )
  }
  // Why: a 429 is the endpoint asking Orca to stop, so the poll gate needs the wait it asked for.
  if (response.status === 429) {
    const retryAfterMs = parseUsageRetryAfterMs(response.headers.get('retry-after'), nowMs)
    return makeDeepInfraError(
      'DeepInfra billing is rate limited right now',
      'rate-limited',
      retryAfterMs === null ? undefined : nowMs + retryAfterMs
    )
  }
  if (!response.ok) {
    return makeDeepInfraError(
      `DeepInfra billing request failed (HTTP ${response.status})`,
      'server'
    )
  }
  return null
}

export async function parseDeepInfraChecklistResponse(
  response: Response
): Promise<ProviderRateLimits> {
  const httpError = classifyDeepInfraHttpError(response, Date.now())
  if (httpError) {
    return httpError
  }
  let payload: DeepInfraChecklist
  try {
    const value: unknown = await response.json()
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return makeDeepInfraError('Invalid DeepInfra billing response', 'parse')
    }
    payload = value
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Invalid DeepInfra billing response'
    // Why: an abort mid-body is a network failure, not an unreadable payload.
    return makeDeepInfraError(message, classifyThrownUsageRequestError(error))
  }
  const credits = buildDeepInfraCredits(payload)
  if (!credits) {
    return makeDeepInfraError('DeepInfra billing response had no readable balance', 'parse')
  }
  return makeDeepInfraSuccess(credits)
}
