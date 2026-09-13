import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const netFetchMock = vi.hoisted(() => vi.fn())

// Why: net.fetch on the default session is what the proxy guard covers, so the
// mock only needs that one surface.
vi.mock('electron', () => ({ net: { fetch: netFetchMock } }))

import { fetchFireworksRateLimits } from './fireworks-fetcher'

const API_BASE = 'https://api.fireworks.ai'
const FROZEN_NOW = Date.parse('2026-07-04T12:00:00.000Z')
const ZERO_USD = { currencyCode: 'USD', units: '0', nanos: 0 }

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  })
}

function htmlResponse(body: string, status = 200): Response {
  return new Response(body, { status, headers: { 'content-type': 'text/html' } })
}

function accountsResponse(entry: unknown): Response {
  return jsonResponse({ accounts: [entry] })
}

function lineItem(units: string, nanos: number, currencyCode = 'USD'): unknown {
  return { category: 'Text Completion', totalCost: { currencyCode, units, nanos } }
}

function callUrl(index: number): URL {
  return new URL(String(netFetchMock.mock.calls[index]?.[0]))
}

function callAuthorizationHeader(index: number): unknown {
  return netFetchMock.mock.calls[index]?.[1]?.headers?.Authorization
}

describe('fetchFireworksRateLimits', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(FROZEN_NOW))
    netFetchMock.mockReset()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('discovers the account id, then sums the rated spend for the current month', async () => {
    netFetchMock
      .mockResolvedValueOnce(accountsResponse({ name: 'accounts/acct-123' }))
      .mockResolvedValueOnce(
        jsonResponse({
          lineItems: [lineItem('12', 340_000_000), lineItem('3', 660_000_000)],
          usageBuckets: []
        })
      )

    const result = await fetchFireworksRateLimits({ apiKey: 'fw-key-discovery' })

    expect(result).toEqual({
      provider: 'fireworks',
      session: null,
      weekly: null,
      credits: {
        kind: 'spend',
        amount: { currencyCode: 'USD', units: '16', nanos: 0 },
        period: 'current-month'
      },
      updatedAt: FROZEN_NOW,
      error: null,
      status: 'ok',
      usageMetadata: { source: 'web' }
    })

    expect(String(netFetchMock.mock.calls[0]?.[0])).toBe(`${API_BASE}/v1/accounts?pageSize=200`)
    expect(netFetchMock.mock.calls[0]?.[1]).toMatchObject({
      method: 'GET',
      headers: { Authorization: 'Bearer fw-key-discovery', Accept: 'application/json' }
    })

    const spendUrl = callUrl(1)
    expect(spendUrl.origin).toBe(API_BASE)
    expect(spendUrl.pathname).toBe('/v1/accounts/acct-123/billing/summary')
    expect(spendUrl.searchParams.get('startTime')).toBe('2026-07-01T00:00:00.000Z')
    expect(spendUrl.searchParams.get('endTime')).toBe('2026-08-01T00:00:00.000Z')
    expect(spendUrl.searchParams.get('granularity')).toBe('DAILY')
    expect(callAuthorizationHeader(1)).toBe('Bearer fw-key-discovery')
  })

  it('reuses the discovered account id on the next poll instead of re-discovering', async () => {
    netFetchMock
      .mockResolvedValueOnce(accountsResponse({ name: 'accounts/acct-cached' }))
      .mockResolvedValueOnce(jsonResponse({ lineItems: [lineItem('1', 0)] }))
      .mockResolvedValueOnce(jsonResponse({ lineItems: [lineItem('2', 0)] }))

    const first = await fetchFireworksRateLimits({ apiKey: 'fw-key-cache' })
    const second = await fetchFireworksRateLimits({ apiKey: 'fw-key-cache' })

    expect(first.credits?.amount).toEqual({ currencyCode: 'USD', units: '1', nanos: 0 })
    expect(second.credits?.amount).toEqual({ currencyCode: 'USD', units: '2', nanos: 0 })
    expect(netFetchMock).toHaveBeenCalledTimes(3)
    expect(callUrl(1).pathname).toBe('/v1/accounts/acct-cached/billing/summary')
    expect(callUrl(2).pathname).toBe('/v1/accounts/acct-cached/billing/summary')
  })

  it('skips discovery entirely when accountIdOverride is set', async () => {
    netFetchMock.mockResolvedValueOnce(jsonResponse({ lineItems: [lineItem('0', 250_000_000)] }))

    const result = await fetchFireworksRateLimits({
      apiKey: 'fw-key-override',
      accountIdOverride: 'acct-manual'
    })

    expect(result.status).toBe('ok')
    expect(result.credits).toEqual({
      kind: 'spend',
      amount: { currencyCode: 'USD', units: '0', nanos: 250_000_000 },
      period: 'current-month'
    })
    expect(netFetchMock).toHaveBeenCalledTimes(1)
    expect(callUrl(0).pathname).toBe('/v1/accounts/acct-manual/billing/summary')
  })

  it('treats a blank accountIdOverride as absent and still discovers', async () => {
    netFetchMock
      .mockResolvedValueOnce(accountsResponse({ name: 'accounts/acct-blank' }))
      .mockResolvedValueOnce(jsonResponse({ lineItems: [] }))

    const result = await fetchFireworksRateLimits({
      apiKey: 'fw-key-blank',
      accountIdOverride: '  '
    })

    expect(result.status).toBe('ok')
    expect(String(netFetchMock.mock.calls[0]?.[0])).toContain('/v1/accounts?pageSize=200')
    expect(callUrl(1).pathname).toBe('/v1/accounts/acct-blank/billing/summary')
  })

  it('strips the accounts/ prefix from the name and percent-encodes the id in the path', async () => {
    netFetchMock
      .mockResolvedValueOnce(accountsResponse({ name: 'accounts/xyz-987' }))
      .mockResolvedValueOnce(jsonResponse({ lineItems: [] }))

    await fetchFireworksRateLimits({ apiKey: 'fw-key-name' })

    expect(callUrl(1).pathname).toBe('/v1/accounts/xyz-987/billing/summary')
  })

  it('falls back to accountId when name carries no id', async () => {
    netFetchMock
      .mockResolvedValueOnce(accountsResponse({ name: 'accounts/', accountId: 'from-account-id' }))
      .mockResolvedValueOnce(jsonResponse({ lineItems: [] }))

    await fetchFireworksRateLimits({ apiKey: 'fw-key-fallback' })

    expect(callUrl(1).pathname).toBe('/v1/accounts/from-account-id/billing/summary')
  })

  it('takes the first usable account across a page of malformed entries', async () => {
    netFetchMock
      .mockResolvedValueOnce(
        jsonResponse({
          accounts: [null, 'invalid', { displayName: 'no id here' }, { name: 'accounts/real' }]
        })
      )
      .mockResolvedValueOnce(jsonResponse({ lineItems: [] }))

    const result = await fetchFireworksRateLimits({ apiKey: 'fw-key-scan' })

    expect(result.status).toBe('ok')
    expect(callUrl(1).pathname).toBe('/v1/accounts/real/billing/summary')
  })

  // Why: 0.1 ten times is 0.9999999999999999 under float math; integer nanos keep it exact.
  it('sums repeated 0.1 line items exactly instead of drifting like float math', async () => {
    netFetchMock
      .mockResolvedValueOnce(accountsResponse({ name: 'accounts/acct-drift' }))
      .mockResolvedValueOnce(
        jsonResponse({ lineItems: Array.from({ length: 10 }, () => lineItem('0', 100_000_000)) })
      )

    const result = await fetchFireworksRateLimits({ apiKey: 'fw-key-drift' })

    expect(result.credits?.amount).toEqual({ currencyCode: 'USD', units: '1', nanos: 0 })
  })

  it('carries nanos across line items when the sum exceeds one unit', async () => {
    netFetchMock
      .mockResolvedValueOnce(accountsResponse({ name: 'accounts/acct-carry' }))
      .mockResolvedValueOnce(
        jsonResponse({
          lineItems: [
            lineItem('0', 700_000_000),
            lineItem('0', 700_000_000),
            lineItem('0', 700_000_000)
          ]
        })
      )

    const result = await fetchFireworksRateLimits({ apiKey: 'fw-key-carry' })

    expect(result.credits?.amount).toEqual({ currencyCode: 'USD', units: '2', nanos: 100_000_000 })
  })

  it('returns a zero USD spend for an account with an empty lineItems array', async () => {
    netFetchMock
      .mockResolvedValueOnce(accountsResponse({ name: 'accounts/acct-new' }))
      .mockResolvedValueOnce(jsonResponse({ lineItems: [], usageBuckets: [] }))

    const result = await fetchFireworksRateLimits({ apiKey: 'fw-key-empty' })

    expect(result.status).toBe('ok')
    expect(result.error).toBeNull()
    expect(result.credits).toEqual({
      kind: 'spend',
      amount: ZERO_USD,
      period: 'current-month'
    })
  })

  // Why: proto3 JSON omits an empty repeated field, so a no-usage account can answer with no
  // `lineItems` key at all — that is zero spend, not a malformed payload.
  it('returns a zero USD spend when the response omits lineItems entirely', async () => {
    netFetchMock
      .mockResolvedValueOnce(accountsResponse({ name: 'accounts/acct-omitted' }))
      .mockResolvedValueOnce(jsonResponse({}))

    const result = await fetchFireworksRateLimits({ apiKey: 'fw-key-omitted' })

    expect(result.status).toBe('ok')
    expect(result.credits?.amount).toEqual(ZERO_USD)
  })

  // Why: usageBuckets subdivide the same range as the top-level lineItems, so summing both
  // would report every cost twice.
  it('reads only top-level lineItems and never adds usageBuckets into the total', async () => {
    netFetchMock
      .mockResolvedValueOnce(accountsResponse({ name: 'accounts/acct-buckets' }))
      .mockResolvedValueOnce(
        jsonResponse({
          lineItems: [lineItem('5', 0)],
          usageBuckets: [
            { startTime: '2026-07-01T00:00:00Z', lineItems: [lineItem('2', 500_000_000)] },
            { startTime: '2026-07-02T00:00:00Z', lineItems: [lineItem('2', 500_000_000)] }
          ]
        })
      )

    const result = await fetchFireworksRateLimits({ apiKey: 'fw-key-buckets' })

    expect(result.credits?.amount).toEqual({ currencyCode: 'USD', units: '5', nanos: 0 })
  })

  it('keeps the account currency when Fireworks rates costs in CNY', async () => {
    netFetchMock
      .mockResolvedValueOnce(accountsResponse({ name: 'accounts/acct-cny' }))
      .mockResolvedValueOnce(jsonResponse({ lineItems: [lineItem('9', 990_000_000, 'CNY')] }))

    const result = await fetchFireworksRateLimits({ apiKey: 'fw-key-cny' })

    expect(result.status).toBe('ok')
    expect(result.credits).toEqual({
      kind: 'spend',
      amount: { currencyCode: 'CNY', units: '9', nanos: 990_000_000 },
      period: 'current-month'
    })
  })

  it.each([401, 403])('classifies HTTP %i as a missing-credentials error', async (status) => {
    netFetchMock
      .mockResolvedValueOnce(accountsResponse({ name: `accounts/acct-${status}` }))
      .mockResolvedValueOnce(jsonResponse({ message: 'unauthorized' }, status))

    const result = await fetchFireworksRateLimits({ apiKey: `fw-key-${status}` })

    expect(result.status).toBe('error')
    expect(result.credits).toBeNull()
    expect(result.session).toBeNull()
    expect(result.weekly).toBeNull()
    expect(result.usageMetadata).toEqual({ failureKind: 'missing-credentials', source: 'web' })
    expect(result.error).toMatch(/API key/i)
    expect(result.error).toContain(String(status))
  })

  it('classifies a non-2xx discovery failure as a server error', async () => {
    netFetchMock.mockResolvedValueOnce(jsonResponse({ message: 'boom' }, 500))

    const result = await fetchFireworksRateLimits({ apiKey: 'fw-key-500' })

    expect(result.status).toBe('error')
    expect(result.usageMetadata).toEqual({ failureKind: 'server', source: 'web' })
    expect(result.error).toContain('500')
    expect(result.credits).toBeNull()
  })

  it('classifies a transport throw as a network error', async () => {
    netFetchMock.mockRejectedValueOnce(new Error('socket hang up'))

    const result = await fetchFireworksRateLimits({ apiKey: 'fw-key-network' })

    expect(result.status).toBe('error')
    expect(result.usageMetadata).toEqual({ failureKind: 'network', source: 'web' })
    expect(result.error).toContain('socket hang up')
  })

  it('classifies a timeout rejection as a network error', async () => {
    netFetchMock.mockRejectedValueOnce(new DOMException('The operation timed out.', 'TimeoutError'))

    const result = await fetchFireworksRateLimits({ apiKey: 'fw-key-timeout' })

    expect(result.status).toBe('error')
    expect(result.usageMetadata).toEqual({ failureKind: 'network', source: 'web' })
    expect(result.error).toContain('timed out')
  })

  it.each(['', '   '])(
    'returns unavailable without any request when the api key is %j',
    async (apiKey) => {
      const result = await fetchFireworksRateLimits({ apiKey })

      expect(result.status).toBe('unavailable')
      expect(result.provider).toBe('fireworks')
      expect(result.credits).toBeNull()
      expect(result.session).toBeNull()
      expect(result.weekly).toBeNull()
      expect(result.error).toMatch(/not configured/i)
      expect(result.usageMetadata).toEqual({ failureKind: 'missing-credentials', source: 'web' })
      expect(netFetchMock).not.toHaveBeenCalled()
    }
  )

  it.each([{ accounts: [] }, {}])(
    'errors with a clear message when discovery finds no account (%#)',
    async (payload) => {
      netFetchMock.mockResolvedValueOnce(jsonResponse(payload))

      // Why: a failed discovery is never cached, so both cases can share a key.
      const result = await fetchFireworksRateLimits({ apiKey: 'fw-key-no-account' })

      expect(result.status).toBe('error')
      expect(result.usageMetadata).toEqual({ failureKind: 'usage-unavailable', source: 'web' })
      expect(result.error).toMatch(/no account/i)
      expect(netFetchMock).toHaveBeenCalledTimes(1)
    }
  )

  it('classifies a malformed totalCost as a parse error', async () => {
    netFetchMock
      .mockResolvedValueOnce(accountsResponse({ name: 'accounts/acct-malformed' }))
      .mockResolvedValueOnce(jsonResponse({ lineItems: [{ category: 'Text', totalCost: 1200 }] }))

    const result = await fetchFireworksRateLimits({ apiKey: 'fw-key-malformed' })

    expect(result.status).toBe('error')
    expect(result.credits).toBeNull()
    expect(result.usageMetadata).toEqual({ failureKind: 'parse', source: 'web' })
    expect(result.error).toMatch(/totalCost/)
  })

  it('classifies a line item with a non-integer nanos as a parse error', async () => {
    netFetchMock
      .mockResolvedValueOnce(accountsResponse({ name: 'accounts/acct-nanos' }))
      .mockResolvedValueOnce(
        jsonResponse({
          lineItems: [{ totalCost: { currencyCode: 'USD', units: '1', nanos: 1.5 } }]
        })
      )

    const result = await fetchFireworksRateLimits({ apiKey: 'fw-key-nanos' })

    expect(result.status).toBe('error')
    expect(result.usageMetadata).toEqual({ failureKind: 'parse', source: 'web' })
  })

  it('classifies a non-array lineItems field as a parse error', async () => {
    netFetchMock
      .mockResolvedValueOnce(accountsResponse({ name: 'accounts/acct-shape' }))
      .mockResolvedValueOnce(jsonResponse({ lineItems: { totalCost: { units: '1' } } }))

    const result = await fetchFireworksRateLimits({ apiKey: 'fw-key-shape' })

    expect(result.status).toBe('error')
    expect(result.usageMetadata).toEqual({ failureKind: 'parse', source: 'web' })
  })

  it('classifies a non-JSON body as a parse error without throwing', async () => {
    netFetchMock
      .mockResolvedValueOnce(accountsResponse({ name: 'accounts/acct-html' }))
      .mockResolvedValueOnce(htmlResponse('<html><body>gateway error</body></html>'))

    const result = await fetchFireworksRateLimits({ apiKey: 'fw-key-html' })

    expect(result.status).toBe('error')
    expect(result.usageMetadata).toEqual({ failureKind: 'parse', source: 'web' })
    expect(result.error).toMatch(/could not be parsed/i)
  })

  it('drops a stale cached account id after a 404 so the next poll rediscovers', async () => {
    netFetchMock
      .mockResolvedValueOnce(accountsResponse({ name: 'accounts/stale-id' }))
      .mockResolvedValueOnce(jsonResponse({ message: 'not found' }, 404))
      .mockResolvedValueOnce(accountsResponse({ name: 'accounts/fresh-id' }))
      .mockResolvedValueOnce(jsonResponse({ lineItems: [lineItem('4', 0)] }))

    const stale = await fetchFireworksRateLimits({ apiKey: 'fw-key-stale' })
    const fresh = await fetchFireworksRateLimits({ apiKey: 'fw-key-stale' })

    expect(stale.status).toBe('error')
    expect(stale.usageMetadata).toEqual({ failureKind: 'server', source: 'web' })
    expect(fresh.status).toBe('ok')
    expect(fresh.credits?.amount).toEqual({ currencyCode: 'USD', units: '4', nanos: 0 })
    expect(callUrl(1).pathname).toBe('/v1/accounts/stale-id/billing/summary')
    expect(callUrl(3).pathname).toBe('/v1/accounts/fresh-id/billing/summary')
  })
})
