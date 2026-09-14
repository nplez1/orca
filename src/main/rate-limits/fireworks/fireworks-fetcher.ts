import { net } from 'electron'
import type { ProviderRateLimits } from '../../../shared/rate-limit-types'
import {
  FIREWORKS_API_BASE_URL,
  FIREWORKS_REQUEST_TIMEOUT_MS,
  makeFireworksError,
  makeFireworksSuccess,
  makeFireworksUnavailable
} from './fireworks-fetcher-data'
import { parseFireworksAccountId, parseFireworksBillingSummary } from './fireworks-fetcher-parse'
import { fetchFireworksBalance } from './fireworks-balance-client'

// Why: metered usage (`GET /v1/accounts/{id}/billingUsage`) is deliberately not
// called — it caps each request at 31 days and only yields a token breakdown that
// no readout consumes. Rated spend comes from the billing summary instead.

// TODO(fireworks-usage-limits): GET /v1/accounts/{account_id}/usageLimits looks
// like it returns `used` plus `effective_*` limit fields and `exceeded_until`,
// which would allow a real percentage bar. Those field names are unverified, so
// probe the live response with a real key before putting any of it on this path.

// Why: Fireworks publishes no endpoint that maps an API key to a single account
// id, so the id is discovered once per key and reused; a poll cycle then costs
// one request instead of two.
const discoveredAccountIdsByApiKey = new Map<string, string>()

// Why: `pageSize` is capped at 200 (default 50). A key addresses one account, so
// the first page always contains it — no pagination walk.
const FIREWORKS_ACCOUNTS_PAGE_SIZE = 200

type FireworksJsonResult =
  | { status: 'ok'; payload: unknown }
  | { status: 'http-error'; httpStatus: number }
  | { status: 'parse-error' }
  | { status: 'network-error'; message: string }

type FireworksJsonFailure = Exclude<FireworksJsonResult, { status: 'ok' }>

export type FetchFireworksRateLimitsOptions = {
  apiKey: string
  /** User-supplied account ID; when set it always wins over discovery. */
  accountIdOverride?: string | null
}

function readErrorMessage(error: unknown): string {
  return error instanceof Error && error.message
    ? error.message
    : 'Fireworks billing request failed'
}

// Why: plain net.fetch on the default session, which Orca's proxy guard holds
// until the persisted proxy has been applied.
async function getFireworksJson(args: {
  path: string
  apiKey: string
}): Promise<FireworksJsonResult> {
  try {
    const response = await net.fetch(`${FIREWORKS_API_BASE_URL}${args.path}`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${args.apiKey}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(FIREWORKS_REQUEST_TIMEOUT_MS)
    })
    if (!response.ok) {
      return { status: 'http-error', httpStatus: response.status }
    }
    try {
      return { status: 'ok', payload: await response.json() }
    } catch {
      return { status: 'parse-error' }
    }
  } catch (error) {
    return { status: 'network-error', message: readErrorMessage(error) }
  }
}

function makeFireworksFailureResponse(failure: FireworksJsonFailure): ProviderRateLimits {
  if (failure.status === 'http-error') {
    if (failure.httpStatus === 401 || failure.httpStatus === 403) {
      return makeFireworksError(
        `Fireworks rejected the API key (HTTP ${failure.httpStatus}) — check it in Settings.`,
        'missing-credentials'
      )
    }
    return makeFireworksError(
      `Fireworks billing request failed (HTTP ${failure.httpStatus})`,
      'server'
    )
  }
  if (failure.status === 'parse-error') {
    return makeFireworksError('Fireworks returned a response that could not be parsed', 'parse')
  }
  return makeFireworksError(`Fireworks billing request failed: ${failure.message}`, 'network')
}

// Why: the summary endpoint requires an explicit range and aggregates by date
// only, so "current billing period" is the UTC calendar month Fireworks bills on.
function getCurrentBillingPeriod(now: number): { startTime: string; endTime: string } {
  const current = new Date(now)
  const year = current.getUTCFullYear()
  const month = current.getUTCMonth()
  return {
    startTime: new Date(Date.UTC(year, month, 1)).toISOString(),
    // Why: endTime is exclusive, so the first instant of the next month is the
    // end of the current billing period.
    endTime: new Date(Date.UTC(year, month + 1, 1)).toISOString()
  }
}

// Why: `granularity=DAILY` additionally returns per-day `usageBuckets`; they are
// deliberately unused (see parseFireworksBillingSummary) to avoid double counting.
function makeBillingSummaryPath(accountId: string, now: number): string {
  const period = getCurrentBillingPeriod(now)
  const query = new URLSearchParams({
    startTime: period.startTime,
    endTime: period.endTime,
    granularity: 'DAILY'
  })
  return `/v1/accounts/${encodeURIComponent(accountId)}/billing/summary?${query.toString()}`
}

type FireworksAccountResolution =
  | { status: 'ok'; accountId: string }
  | { status: 'error'; rateLimits: ProviderRateLimits }

async function resolveFireworksAccountId(args: {
  apiKey: string
  accountIdOverride: string | null
}): Promise<FireworksAccountResolution> {
  if (args.accountIdOverride) {
    return { status: 'ok', accountId: args.accountIdOverride }
  }
  const discovered = discoveredAccountIdsByApiKey.get(args.apiKey)
  if (discovered) {
    return { status: 'ok', accountId: discovered }
  }
  const result = await getFireworksJson({
    path: `/v1/accounts?pageSize=${FIREWORKS_ACCOUNTS_PAGE_SIZE}`,
    apiKey: args.apiKey
  })
  if (result.status !== 'ok') {
    return { status: 'error', rateLimits: makeFireworksFailureResponse(result) }
  }
  const accountId = parseFireworksAccountId(result.payload)
  if (!accountId) {
    return {
      status: 'error',
      rateLimits: makeFireworksError(
        'Fireworks listed no account for this API key — set the account ID in Settings.',
        'usage-unavailable'
      )
    }
  }
  discoveredAccountIdsByApiKey.set(args.apiKey, accountId)
  return { status: 'ok', accountId }
}

/**
 * Rated Fireworks spend for the current billing period.
 *
 * Never rejects: every failure path returns an error or unavailable snapshot so
 * one provider cannot abort the service's whole refresh cycle.
 */
export async function fetchFireworksRateLimits(
  options: FetchFireworksRateLimitsOptions
): Promise<ProviderRateLimits> {
  try {
    const apiKey = options.apiKey?.trim() ?? ''
    if (!apiKey) {
      return makeFireworksUnavailable('Fireworks API key not configured')
    }
    const accountIdOverride = options.accountIdOverride?.trim() || null
    const resolved = await resolveFireworksAccountId({ apiKey, accountIdOverride })
    if (resolved.status === 'error') {
      return resolved.rateLimits
    }
    const summaryPath = makeBillingSummaryPath(resolved.accountId, Date.now())
    // Why in parallel: the gateway balance is an extra round trip, and neither call
    // depends on the other's result, so serialising them would just add latency.
    const [result, balance] = await Promise.all([
      getFireworksJson({ path: summaryPath, apiKey }),
      // Why the catch: the balance readout is best-effort bonus data from an
      // internal API, so it must never be able to fail the whole provider.
      fetchFireworksBalance({ apiKey, accountId: resolved.accountId }).catch(() => null)
    ])
    if (result.status !== 'ok') {
      // Why: a cached id can go stale if the account is renamed or removed; drop
      // it so the next cycle rediscovers instead of failing forever.
      if (result.status === 'http-error' && result.httpStatus === 404) {
        discoveredAccountIdsByApiKey.delete(apiKey)
      }
      return makeFireworksFailureResponse(result)
    }
    const spend = parseFireworksBillingSummary(result.payload)
    if (spend.status === 'malformed') {
      return makeFireworksError(
        'Fireworks billing summary contained a line item without a usable totalCost',
        'parse'
      )
    }
    return makeFireworksSuccess(spend.amount, balance)
  } catch (error) {
    return makeFireworksError(readErrorMessage(error), 'unknown')
  }
}
