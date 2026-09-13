import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { netFetchMock } = vi.hoisted(() => ({ netFetchMock: vi.fn() }))

// Why: the fetcher must use the default session's net.fetch (proxy guard); the
// mock exposes no `session` so a partition-based transport would fail loudly.
vi.mock('electron', () => ({ net: { fetch: netFetchMock } }))

import { fetchDeepSeekRateLimits } from './deepseek-fetcher'

const DEEPSEEK_URL = 'https://api.deepseek.com/user/balance'
const API_KEY = 'sk-deepseek-test-key'
const FIXED_NOW = new Date('2026-07-04T12:00:00.000Z').getTime()

function makeResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  })
}

function makeBalancePayload(args: { isAvailable?: unknown; balanceInfos: unknown }): unknown {
  return { is_available: args.isAvailable ?? true, balance_infos: args.balanceInfos }
}

const USD_INFO = {
  currency: 'USD',
  total_balance: '42.10',
  granted_balance: '5.00',
  topped_up_balance: '37.10'
}

describe('fetchDeepSeekRateLimits', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(FIXED_NOW)
    netFetchMock.mockReset()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('maps a USD balance response to exact credits and sends a Bearer request', async () => {
    netFetchMock.mockResolvedValueOnce(
      makeResponse(makeBalancePayload({ balanceInfos: [USD_INFO] }))
    )

    const result = await fetchDeepSeekRateLimits({ apiKey: API_KEY })

    expect(result).toEqual({
      provider: 'deepseek',
      session: null,
      weekly: null,
      credits: {
        kind: 'balance',
        amount: { currencyCode: 'USD', units: '42', nanos: 100_000_000 },
        items: [
          { key: 'granted', amount: { currencyCode: 'USD', units: '5', nanos: 0 } },
          { key: 'topped-up', amount: { currencyCode: 'USD', units: '37', nanos: 100_000_000 } }
        ],
        available: true
      },
      updatedAt: FIXED_NOW,
      error: null,
      status: 'ok',
      usageMetadata: { source: 'web' }
    })

    expect(netFetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = netFetchMock.mock.calls[0]
    expect(url).toBe(DEEPSEEK_URL)
    expect(init.headers).toEqual({
      Authorization: `Bearer ${API_KEY}`,
      Accept: 'application/json'
    })
    expect(init.signal).toBeInstanceOf(AbortSignal)
  })

  it('keeps a CNY-only account in CNY', async () => {
    netFetchMock.mockResolvedValueOnce(
      makeResponse(
        makeBalancePayload({
          balanceInfos: [
            {
              currency: 'CNY',
              total_balance: '100.00',
              granted_balance: '0.00',
              topped_up_balance: '100.00'
            }
          ]
        })
      )
    )

    const result = await fetchDeepSeekRateLimits({ apiKey: API_KEY })

    expect(result.status).toBe('ok')
    expect(result.credits).toEqual({
      kind: 'balance',
      amount: { currencyCode: 'CNY', units: '100', nanos: 0 },
      items: [
        { key: 'granted', amount: { currencyCode: 'CNY', units: '0', nanos: 0 } },
        { key: 'topped-up', amount: { currencyCode: 'CNY', units: '100', nanos: 0 } }
      ],
      available: true
    })
  })

  it('prefers the USD headline when several currencies are returned', async () => {
    const cnyInfo = {
      currency: 'CNY',
      total_balance: '700.00',
      granted_balance: '0.00',
      topped_up_balance: '700.00'
    }
    netFetchMock.mockResolvedValueOnce(
      makeResponse(makeBalancePayload({ balanceInfos: [cnyInfo, USD_INFO] }))
    )

    const result = await fetchDeepSeekRateLimits({ apiKey: API_KEY })

    expect(result.credits).toEqual({
      kind: 'balance',
      amount: { currencyCode: 'USD', units: '42', nanos: 100_000_000 },
      items: [
        { key: 'granted', amount: { currencyCode: 'USD', units: '5', nanos: 0 } },
        { key: 'topped-up', amount: { currencyCode: 'USD', units: '37', nanos: 100_000_000 } }
      ],
      available: true
    })
  })

  it('passes an unknown currency code through verbatim', async () => {
    netFetchMock.mockResolvedValueOnce(
      makeResponse(
        makeBalancePayload({
          balanceInfos: [
            {
              currency: 'JPY',
              total_balance: '5000',
              granted_balance: '0',
              topped_up_balance: '5000'
            }
          ]
        })
      )
    )

    const result = await fetchDeepSeekRateLimits({ apiKey: API_KEY })

    expect(result.status).toBe('ok')
    expect(result.credits?.amount).toEqual({ currencyCode: 'JPY', units: '5000', nanos: 0 })
    expect(result.credits?.items?.[1]).toEqual({
      key: 'topped-up',
      amount: { currencyCode: 'JPY', units: '5000', nanos: 0 }
    })
  })

  it('skips an unreadable entry and falls back to the next currency', async () => {
    netFetchMock.mockResolvedValueOnce(
      makeResponse(
        makeBalancePayload({
          balanceInfos: [
            { currency: 'USD', total_balance: 'n/a' },
            { currency: 'CNY', total_balance: '88.5', granted_balance: '8.5' }
          ]
        })
      )
    )

    const result = await fetchDeepSeekRateLimits({ apiKey: API_KEY })

    expect(result.status).toBe('ok')
    expect(result.credits?.amount).toEqual({ currencyCode: 'CNY', units: '88', nanos: 500_000_000 })
    expect(result.credits?.items).toEqual([
      { key: 'granted', amount: { currencyCode: 'CNY', units: '8', nanos: 500_000_000 } }
    ])
  })

  it('keeps an exhausted-but-configured account visible with status ok', async () => {
    netFetchMock.mockResolvedValueOnce(
      makeResponse(
        makeBalancePayload({
          isAvailable: false,
          balanceInfos: [
            {
              currency: 'USD',
              total_balance: '0.00',
              granted_balance: '0.00',
              topped_up_balance: '0.00'
            }
          ]
        })
      )
    )

    const result = await fetchDeepSeekRateLimits({ apiKey: API_KEY })

    expect(result.status).toBe('ok')
    expect(result.error).toBeNull()
    expect(result.credits).toEqual({
      kind: 'balance',
      amount: { currencyCode: 'USD', units: '0', nanos: 0 },
      items: [
        { key: 'granted', amount: { currencyCode: 'USD', units: '0', nanos: 0 } },
        { key: 'topped-up', amount: { currencyCode: 'USD', units: '0', nanos: 0 } }
      ],
      available: false
    })
  })

  it('treats a missing is_available flag as available', async () => {
    netFetchMock.mockResolvedValueOnce(makeResponse({ balance_infos: [USD_INFO] }))

    const result = await fetchDeepSeekRateLimits({ apiKey: API_KEY })

    expect(result.status).toBe('ok')
    expect(result.credits?.available).toBe(true)
  })

  it('drops an unreadable breakdown item without losing the headline', async () => {
    netFetchMock.mockResolvedValueOnce(
      makeResponse(
        makeBalancePayload({
          balanceInfos: [
            {
              currency: 'USD',
              total_balance: '42.10',
              granted_balance: 'lots',
              topped_up_balance: '37.10'
            }
          ]
        })
      )
    )

    const result = await fetchDeepSeekRateLimits({ apiKey: API_KEY })

    expect(result.status).toBe('ok')
    expect(result.credits?.amount).toEqual({ currencyCode: 'USD', units: '42', nanos: 100_000_000 })
    expect(result.credits?.items).toEqual([
      { key: 'topped-up', amount: { currencyCode: 'USD', units: '37', nanos: 100_000_000 } }
    ])
  })

  it('treats non-string amounts as unreadable', async () => {
    netFetchMock.mockResolvedValueOnce(
      makeResponse(
        makeBalancePayload({
          balanceInfos: [
            { currency: 'USD', total_balance: 42.1, granted_balance: 5, topped_up_balance: 37 }
          ]
        })
      )
    )

    const result = await fetchDeepSeekRateLimits({ apiKey: API_KEY })

    expect(result.status).toBe('error')
    expect(result.usageMetadata?.failureKind).toBe('parse')
    expect(result.credits).toBeUndefined()
  })

  it.each([
    ['garbage amount', { currency: 'USD', total_balance: 'not-a-number' }],
    ['missing total', { currency: 'USD', granted_balance: '5.00' }],
    ['missing currency', { total_balance: '42.10' }],
    ['non-object entry', 'USD'],
    ['empty balance_infos', undefined]
  ])('classifies %s as a parse failure', async (_label, info) => {
    netFetchMock.mockResolvedValueOnce(
      makeResponse(makeBalancePayload({ balanceInfos: info === undefined ? [] : [info] }))
    )

    const result = await fetchDeepSeekRateLimits({ apiKey: API_KEY })

    expect(result.status).toBe('error')
    expect(result.usageMetadata?.failureKind).toBe('parse')
    expect(result.error).toMatch(/no readable balance/i)
  })

  it.each([null, 'invalid', 42, []])(
    'rejects invalid payload %j as a parse error',
    async (payload) => {
      netFetchMock.mockResolvedValueOnce(makeResponse(payload))

      const result = await fetchDeepSeekRateLimits({ apiKey: API_KEY })

      expect(result.status).toBe('error')
      expect(result.usageMetadata?.failureKind).toBe('parse')
    }
  )

  it('reports a non-JSON body as a parse failure', async () => {
    // Why: a real Response makes `.json()` throw the way production does, instead
    // of a hand-rolled stub that has to be asserted into the Response shape.
    netFetchMock.mockResolvedValueOnce(
      new Response('<html>nope</html>', {
        status: 200,
        headers: { 'content-type': 'text/html' }
      })
    )

    const result = await fetchDeepSeekRateLimits({ apiKey: API_KEY })

    expect(result.status).toBe('error')
    expect(result.usageMetadata?.failureKind).toBe('parse')
    // Why: JSON.parse's wording varies by Node version, so assert it surfaced an
    // error text rather than a specific engine message.
    expect(result.error).toBeTruthy()
  })

  it.each([401, 403])('classifies HTTP %i as missing-credentials', async (status) => {
    netFetchMock.mockResolvedValueOnce(makeResponse({}, status))

    const result = await fetchDeepSeekRateLimits({ apiKey: API_KEY })

    expect(result).toMatchObject({
      provider: 'deepseek',
      session: null,
      weekly: null,
      status: 'error',
      error: `DeepSeek API key rejected (HTTP ${status})`,
      usageMetadata: { failureKind: 'missing-credentials', source: 'web' }
    })
  })

  it('classifies HTTP 500 as a server failure', async () => {
    netFetchMock.mockResolvedValueOnce(makeResponse({}, 500))

    const result = await fetchDeepSeekRateLimits({ apiKey: API_KEY })

    expect(result.status).toBe('error')
    expect(result.usageMetadata?.failureKind).toBe('server')
    expect(result.error).toMatch(/500/)
  })

  it('classifies a transport throw as a network failure', async () => {
    netFetchMock.mockRejectedValueOnce(new Error('socket hang up'))

    const result = await fetchDeepSeekRateLimits({ apiKey: API_KEY })

    expect(result.status).toBe('error')
    expect(result.usageMetadata?.failureKind).toBe('network')
    expect(result.error).toBe('socket hang up')
  })

  it('classifies a timeout abort as a network failure', async () => {
    const timeoutError = new DOMException('The operation timed out.', 'TimeoutError')
    netFetchMock.mockRejectedValueOnce(timeoutError)

    const result = await fetchDeepSeekRateLimits({ apiKey: API_KEY })

    expect(result.status).toBe('error')
    expect(result.usageMetadata?.failureKind).toBe('network')
  })

  it('treats a rejected non-Error value as a network failure', async () => {
    netFetchMock.mockRejectedValueOnce('boom')

    const result = await fetchDeepSeekRateLimits({ apiKey: API_KEY })

    expect(result.status).toBe('error')
    expect(result.usageMetadata?.failureKind).toBe('network')
    expect(result.error).toBe('DeepSeek balance request failed')
  })

  it.each(['', '   '])('returns unavailable for a blank apiKey %j', async (apiKey) => {
    const result = await fetchDeepSeekRateLimits({ apiKey })

    expect(result).toEqual({
      provider: 'deepseek',
      session: null,
      weekly: null,
      updatedAt: FIXED_NOW,
      error: 'DeepSeek API key not configured',
      status: 'unavailable',
      usageMetadata: { failureKind: 'missing-credentials', source: 'web' }
    })
    expect(netFetchMock).not.toHaveBeenCalled()
  })

  it('trims the api key before sending it', async () => {
    netFetchMock.mockResolvedValueOnce(
      makeResponse(makeBalancePayload({ balanceInfos: [USD_INFO] }))
    )

    await fetchDeepSeekRateLimits({ apiKey: `  ${API_KEY}  ` })

    expect(netFetchMock.mock.calls[0][1].headers.Authorization).toBe(`Bearer ${API_KEY}`)
  })
})
