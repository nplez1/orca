import type { ProviderRateLimits } from '../../../shared/rate-limit-types'
import {
  buildDeepInfraCredits,
  makeDeepInfraError,
  makeDeepInfraSuccess,
  type DeepInfraChecklist
} from './deepinfra-fetcher-data'

// Why: split out of deepinfra-fetcher.ts so the transport file stays a thin
// fetch + catch. Pure Response -> ProviderRateLimits translation; no I/O.

function classifyDeepInfraHttpError(response: Response): ProviderRateLimits | null {
  if (response.status === 401 || response.status === 403) {
    return makeDeepInfraError(
      `DeepInfra rejected the API key (HTTP ${response.status}) — check it in Settings.`,
      'missing-credentials'
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
  const httpError = classifyDeepInfraHttpError(response)
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
    return makeDeepInfraError(message, 'parse')
  }
  const credits = buildDeepInfraCredits(payload)
  if (!credits) {
    return makeDeepInfraError('DeepInfra billing response had no readable balance', 'parse')
  }
  return makeDeepInfraSuccess(credits)
}
