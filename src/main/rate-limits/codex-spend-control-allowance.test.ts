import { beforeEach, describe, expect, it, vi } from 'vitest'

const { readFileMock } = vi.hoisted(() => ({ readFileMock: vi.fn() }))

vi.mock('node:fs/promises', () => ({ readFile: readFileMock }))

import type { ProviderRateLimits } from '../../shared/rate-limit-types'
import {
  fetchCodexRateLimitsViaBackend,
  supplementCodexSessionWindow
} from './codex-backend-usage-client'

// Why: invented stand-in for the account's reset instant; the backend reports Unix
// seconds and Orca stores Unix ms, so every assertion below pins that conversion.
const RESET_AT_SECONDS = 1_786_543_200
const RESET_AT_MS = RESET_AT_SECONDS * 1000

/**
 * Business/enterprise payload: `rate_limit` null, the monthly cap in `spend_control`.
 * Key names and the string-vs-number types mirror the real response — limit/used are
 * decimal strings, the percentages and reset_at are numbers.
 */
function spendControlPayload(individualLimit: Record<string, unknown> = {}) {
  return {
    plan_type: 'business',
    rate_limit: null,
    spend_control: {
      reached: false,
      individual_limit: {
        limit: '65000',
        used: '13650.318487562185',
        remaining: '51349.681512437815',
        used_percent: 21,
        remaining_percent: 79,
        reset_at: RESET_AT_SECONDS,
        reset_after_seconds: 1_438_428,
        source: 'group_based_spend_controls',
        unit: 'credit',
        ...individualLimit
      }
    }
  }
}

function backendRequest(payload: unknown) {
  return vi.fn(async (): Promise<Response> => {
    return new Response(JSON.stringify(payload), { status: 200 })
  })
}

async function fetchBackend(payload: unknown): Promise<ProviderRateLimits> {
  const result = await fetchCodexRateLimitsViaBackend(backendRequest(payload))
  if (!result) {
    throw new Error('expected the backend mapper to return a result')
  }
  return result
}

function windowlessLimits(overrides: Partial<ProviderRateLimits> = {}): ProviderRateLimits {
  return {
    provider: 'codex',
    session: null,
    weekly: null,
    updatedAt: 1,
    error: null,
    status: 'ok',
    ...overrides
  }
}

describe('Codex spend-control allowance for windowless plans', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    readFileMock.mockResolvedValue(
      JSON.stringify({ tokens: { access_token: 'access-token', account_id: 'account-id' } })
    )
  })

  it('maps a windowless business spend control to a monthly allowance', async () => {
    const request = backendRequest(spendControlPayload())
    const result = await fetchCodexRateLimitsViaBackend(request)

    expect(result).not.toBeNull()
    expect(result?.session).toBeNull()
    expect(result?.weekly).toBeNull()
    expect(result?.planType).toBe('business')
    expect(result?.monthly).toEqual({
      usedPercent: 21,
      windowMinutes: 43_200,
      resetsAt: RESET_AT_MS,
      resetDescription: null
    })
    expect(result?.allowance).toEqual({
      unit: { kind: 'count', label: 'credit' },
      used: 13650.318487562185,
      limit: 65000,
      resetsAt: RESET_AT_MS
    })
    // The backend reports reset_at in Unix seconds; Orca stores Unix ms.
    expect(result?.monthly?.resetsAt).toBe(RESET_AT_SECONDS * 1000)
    expect(result?.allowance?.resetsAt).toBe(RESET_AT_SECONDS * 1000)
    // limit/used arrive as decimal strings and must come out as numbers.
    expect(typeof result?.allowance?.used).toBe('number')
    expect(typeof result?.allowance?.limit).toBe('number')
    expect(request).toHaveBeenCalledWith(
      'https://chatgpt.com/backend-api/wham/usage',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer access-token' })
      })
    )
  })

  it('derives the percentage from remaining_percent when used_percent is absent', async () => {
    const result = await fetchBackend(
      spendControlPayload({ used_percent: undefined, remaining_percent: 63 })
    )

    expect(result.monthly?.usedPercent).toBe(37)
    expect(result.allowance?.used).toBe(13650.318487562185)
  })

  it('passes an already-millisecond reset timestamp through unchanged', async () => {
    const result = await fetchBackend(spendControlPayload({ reset_at: RESET_AT_MS }))

    expect(result.monthly?.resetsAt).toBe(RESET_AT_MS)
    expect(result.allowance?.resetsAt).toBe(RESET_AT_MS)
    expect(result.monthly?.resetsAt).not.toBe(RESET_AT_MS * 1000)
  })

  it.each([{ resetAt: 0 }, { resetAt: -1 }])(
    'treats reset_at $resetAt as no reset at all',
    async ({ resetAt }) => {
      const result = await fetchBackend(spendControlPayload({ reset_at: resetAt }))

      expect(result.monthly?.resetsAt).toBeNull()
      expect(result.allowance?.resetsAt).toBeNull()
      expect(result.monthly?.usedPercent).toBe(21)
    }
  )

  it('keeps a windowed plan on its session and weekly bars', async () => {
    const spendControl = spendControlPayload().spend_control
    const result = await fetchBackend({
      plan_type: 'plus',
      rate_limit: {
        primary_window: { used_percent: 41, limit_window_seconds: 18_000, reset_at: 1_786_000_000 },
        secondary_window: {
          used_percent: 53,
          limit_window_seconds: 604_800,
          reset_at: 1_786_500_000
        }
      },
      // Present but must be ignored: the gate keys off the presence of a window.
      spend_control: spendControl
    })

    expect(result.session?.usedPercent).toBe(41)
    expect(result.session?.windowMinutes).toBe(300)
    expect(result.weekly?.usedPercent).toBe(53)
    expect(result.weekly?.windowMinutes).toBe(10_080)
    expect(result.monthly).toBeUndefined()
    expect(result.allowance).toBeUndefined()
    expect(Object.hasOwn(result, 'monthly')).toBe(false)
    expect(Object.hasOwn(result, 'allowance')).toBe(false)
  })

  it.each([
    { name: 'null', spendControl: null },
    { name: 'missing individual_limit', spendControl: { reached: true } },
    { name: 'null individual_limit', spendControl: { reached: false, individual_limit: null } }
  ])('reports no allowance when spend_control is $name', async ({ spendControl }) => {
    const result = await fetchBackend({
      plan_type: 'business',
      rate_limit: null,
      spend_control: spendControl
    })

    expect(result.status).toBe('ok')
    expect(result.planType).toBe('business')
    expect(Object.hasOwn(result, 'monthly')).toBe(false)
    expect(Object.hasOwn(result, 'allowance')).toBe(false)
  })

  it.each([
    { name: 'missing', unit: undefined, label: 'credits' },
    { name: 'blank', unit: '   ', label: 'credits' },
    { name: 'padded', unit: '  credit  ', label: 'credit' }
  ])('labels a $name unit as $label', async ({ unit, label }) => {
    const result = await fetchBackend(spendControlPayload({ unit }))

    expect(result.allowance?.unit).toEqual({ kind: 'count', label })
  })

  it.each([
    { name: 'the limit is unparsable', override: { limit: 'lots' } },
    { name: 'used is empty', override: { used: '' } },
    { name: 'the limit is null', override: { limit: null } },
    { name: 'the limit is an object', override: { limit: {} } }
  ])('drops the allowance when $name', async ({ override }) => {
    const result = await fetchBackend(spendControlPayload(override))

    expect(result.status).toBe('ok')
    expect(result.monthly?.usedPercent).toBe(21)
    expect(result.allowance).toBeUndefined()
  })

  it('adds monthly, allowance and planType to a windowless snapshot', async () => {
    const limits = windowlessLimits()
    const merged = await supplementCodexSessionWindow(limits, backendRequest(spendControlPayload()))

    expect(merged).not.toBe(limits)
    expect(merged.session).toBeNull()
    expect(merged.weekly).toBeNull()
    expect(merged.monthly).toEqual({
      usedPercent: 21,
      windowMinutes: 43_200,
      resetsAt: RESET_AT_MS,
      resetDescription: null
    })
    expect(merged.allowance).toEqual({
      unit: { kind: 'count', label: 'credit' },
      used: 13650.318487562185,
      limit: 65000,
      resetsAt: RESET_AT_MS
    })
    expect(merged.planType).toBe('business')
    expect(merged.updatedAt).toBeGreaterThan(limits.updatedAt)
  })

  it('returns a snapshot that already has a session window untouched', async () => {
    const limits = windowlessLimits({
      session: { usedPercent: 12, windowMinutes: 300, resetsAt: null, resetDescription: null }
    })
    const request = backendRequest(spendControlPayload())
    const merged = await supplementCodexSessionWindow(limits, request)

    expect(merged).toBe(limits)
    expect(request).not.toHaveBeenCalled()
  })

  it('returns the snapshot untouched when the signal is already aborted', async () => {
    const limits = windowlessLimits()
    const request = backendRequest(spendControlPayload())
    const merged = await supplementCodexSessionWindow(limits, request, {
      signal: AbortSignal.abort()
    })

    expect(merged).toBe(limits)
    expect(request).not.toHaveBeenCalled()
  })

  it('leaves updatedAt alone when the backend response is not ok', async () => {
    const limits = windowlessLimits({ updatedAt: 4_242 })
    const request = vi.fn(async (): Promise<Response> => new Response('', { status: 503 }))
    const merged = await supplementCodexSessionWindow(limits, request)

    expect(merged).toBe(limits)
    expect(merged.updatedAt).toBe(4_242)
    expect(request).toHaveBeenCalledTimes(1)
    expect(merged.monthly).toBeUndefined()
  })

  it('leaves updatedAt alone when the backend request rejects', async () => {
    const limits = windowlessLimits({ updatedAt: 4_242 })
    const request = vi.fn(async (): Promise<Response> => {
      throw new Error('backend unreachable')
    })
    const merged = await supplementCodexSessionWindow(limits, request)

    expect(merged).toBe(limits)
    expect(merged.updatedAt).toBe(4_242)
  })

  it('leaves updatedAt alone when the payload carries no plan type', async () => {
    const limits = windowlessLimits({ updatedAt: 4_242 })
    const merged = await supplementCodexSessionWindow(limits, backendRequest({ rate_limit: null }))

    expect(merged).toBe(limits)
    expect(merged.updatedAt).toBe(4_242)
  })

  it('adopts the backend plan type alone as contributed data', async () => {
    const limits = windowlessLimits({ updatedAt: 4_242 })
    const merged = await supplementCodexSessionWindow(
      limits,
      backendRequest({ plan_type: 'business', rate_limit: null })
    )

    expect(merged).not.toBe(limits)
    expect(merged.planType).toBe('business')
    expect(merged.updatedAt).toBeGreaterThan(4_242)
    expect(merged.monthly).toBeUndefined()
    expect(merged.allowance).toBeUndefined()
  })
})
