import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setMainHttpClient } from '../../network/http-client'

const { netFetchMock } = vi.hoisted(() => ({ netFetchMock: vi.fn() }))

// Why: the fetcher reads the host HTTP port, whose desktop client is the default
// session's net.fetch (proxy guard included). Installing the port keeps that contract
// and lets the module load under the runtime, where Electron is absent.
setMainHttpClient({ fetch: netFetchMock, proxySession: () => null })

import { fetchDeepInfraRateLimits } from './deepinfra-fetcher'

const CHECKLIST_URL = 'https://api.deepinfra.com/payment/checklist'
const API_KEY = 'sk-deepinfra-test-key'
const FIXED_NOW = new Date('2026-11-01T12:00:00.000Z').getTime()

function makeResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  })
}

// Why: the live shape, trimmed to the fields this readout consumes.
const CHECKLIST = {
  stripe_balance: -20,
  recent: 0.57,
  suspended: false,
  overdue_invoices: 0,
  limit: null,
  billing_type: 'balance'
}

describe('fetchDeepInfraRateLimits', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(FIXED_NOW)
    netFetchMock.mockReset()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('reports remaining dollars as credit minus usage since the last invoice', async () => {
    netFetchMock.mockResolvedValueOnce(makeResponse(CHECKLIST))

    const result = await fetchDeepInfraRateLimits({ apiKey: API_KEY })

    expect(result).toEqual({
      provider: 'deepinfra',
      session: null,
      weekly: null,
      credits: {
        kind: 'balance',
        amount: { currencyCode: 'USD', units: '19', nanos: 430_000_000 },
        items: [
          {
            key: 'unbilled',
            amount: { currencyCode: 'USD', units: '0', nanos: 570_000_000 }
          }
        ],
        available: true
      },
      updatedAt: FIXED_NOW,
      error: null,
      status: 'ok',
      usageMetadata: { source: 'web' }
    })
    expect(netFetchMock).toHaveBeenCalledWith(
      CHECKLIST_URL,
      expect.objectContaining({
        method: 'GET',
        headers: { Authorization: `Bearer ${API_KEY}`, Accept: 'application/json' }
      })
    )
  })

  it('trims the key before sending it', async () => {
    netFetchMock.mockResolvedValueOnce(makeResponse(CHECKLIST))

    await fetchDeepInfraRateLimits({ apiKey: `  ${API_KEY}  ` })

    expect(netFetchMock).toHaveBeenCalledWith(
      CHECKLIST_URL,
      expect.objectContaining({
        headers: { Authorization: `Bearer ${API_KEY}`, Accept: 'application/json' }
      })
    )
  })

  it('reports an unconfigured key as unavailable, without a request', async () => {
    const result = await fetchDeepInfraRateLimits({ apiKey: '   ' })

    expect(result.status).toBe('unavailable')
    expect(result.provider).toBe('deepinfra')
    expect(result.error).toContain('not configured')
    expect(netFetchMock).not.toHaveBeenCalled()
  })

  it('marks the account exhausted but keeps the reading visible', async () => {
    netFetchMock.mockResolvedValueOnce(
      makeResponse({ stripe_balance: 0, recent: 1.25, suspended: false })
    )

    const result = await fetchDeepInfraRateLimits({ apiKey: API_KEY })

    expect(result.status).toBe('ok')
    expect(result.credits?.amount).toEqual({
      currencyCode: 'USD',
      units: '-1',
      nanos: -250_000_000
    })
    expect(result.credits?.available).toBe(false)
  })

  it('treats a suspended account as unavailable to spend even with credit left', async () => {
    netFetchMock.mockResolvedValueOnce(
      makeResponse({ stripe_balance: -50, recent: 0, suspended: true })
    )

    const result = await fetchDeepInfraRateLimits({ apiKey: API_KEY })

    expect(result.credits?.available).toBe(false)
  })

  it('reads absent amounts as zero, which is what a fresh account answers', async () => {
    netFetchMock.mockResolvedValueOnce(makeResponse({}))

    const result = await fetchDeepInfraRateLimits({ apiKey: API_KEY })

    expect(result.status).toBe('ok')
    expect(result.credits?.amount).toEqual({ currencyCode: 'USD', units: '0', nanos: 0 })
    // Why no item: zero unbilled usage has nothing to break out.
    expect(result.credits?.items).toEqual([])
  })

  it('reports a rejected key as a credential failure', async () => {
    netFetchMock.mockResolvedValueOnce(makeResponse({ detail: 'nope' }, 401))

    const result = await fetchDeepInfraRateLimits({ apiKey: API_KEY })

    expect(result.status).toBe('error')
    expect(result.usageMetadata?.failureKind).toBe('missing-credentials')
    expect(result.error).toContain('401')
  })

  it('reports a server failure with its status', async () => {
    netFetchMock.mockResolvedValueOnce(makeResponse({}, 503))

    const result = await fetchDeepInfraRateLimits({ apiKey: API_KEY })

    expect(result.status).toBe('error')
    expect(result.usageMetadata?.failureKind).toBe('server')
    expect(result.error).toContain('503')
  })

  it('reports an unreadable amount as a parse failure instead of guessing', async () => {
    netFetchMock.mockResolvedValueOnce(makeResponse({ stripe_balance: 'twenty', recent: 0.57 }))

    const result = await fetchDeepInfraRateLimits({ apiKey: API_KEY })

    expect(result.status).toBe('error')
    expect(result.usageMetadata?.failureKind).toBe('parse')
  })

  it('reports a non-object payload as a parse failure', async () => {
    netFetchMock.mockResolvedValueOnce(makeResponse([1, 2, 3]))

    const result = await fetchDeepInfraRateLimits({ apiKey: API_KEY })

    expect(result.status).toBe('error')
    expect(result.usageMetadata?.failureKind).toBe('parse')
  })

  it('reports a transport failure as a network failure', async () => {
    netFetchMock.mockRejectedValueOnce(new Error('socket hang up'))

    const result = await fetchDeepInfraRateLimits({ apiKey: API_KEY })

    expect(result.status).toBe('error')
    expect(result.usageMetadata?.failureKind).toBe('network')
    expect(result.error).toContain('socket hang up')
  })
})
