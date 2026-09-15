import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { UsageRateLimitFailureKind } from '../../../shared/rate-limit-types'

type GhResult = { stdout: string; stderr: string }
type GhCallOptions = { env?: NodeJS.ProcessEnv }

const { ghExecFileAsyncMock } = vi.hoisted(() => ({
  ghExecFileAsyncMock: vi.fn<(args: string[], options?: GhCallOptions) => Promise<GhResult>>()
}))

// Why: `gh` is the whole transport for these two endpoints, so mocking that one
// surface keeps the suite off the real GitHub billing API and off the real CLI.
vi.mock('../../git/command-runner/gh-exec-file', () => ({
  ghExecFileAsync: ghExecFileAsyncMock
}))

import { fetchCopilotRateLimits } from './copilot-fetcher'

const GITHUB_API_VERSION = '2026-03-10'
const ENTERPRISE = 'acme-corp'
const TOKEN = 'ghp_enterprise_billing_token'
// A mid-month instant, so the next-month boundary is unambiguous.
const FROZEN_NOW = Date.parse('2026-07-04T12:00:00.000Z')
const NEXT_MONTH_START = Date.UTC(2026, 7, 1)

const HTTP_STATUS_TEXT: Record<number, string> = {
  400: 'Bad Request',
  401: 'Bad credentials',
  403: 'Resource protected by enterprise policy',
  404: 'Not Found',
  500: 'Server Error',
  503: 'Service Unavailable'
}

function ghOk(payload: unknown): GhResult {
  return { stdout: JSON.stringify(payload), stderr: '' }
}

/** A gh rejection shaped like the real one: the API status lives inside stderr. */
function ghHttpError(status: number): Error & { stderr: string } {
  const text = `gh: ${HTTP_STATUS_TEXT[status] ?? 'Error'} (HTTP ${status})`
  return Object.assign(new Error(text), { stderr: text })
}

function ghEnoent(): Error & { code: string } {
  return Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' })
}

function ghCliError(stderr: string): Error & { stderr: string } {
  return Object.assign(new Error(stderr), { stderr })
}

function aiCreditBudget(amount: unknown): Record<string, unknown> {
  return {
    id: 'budget-ai-credits',
    budget_type: 'BundlePricing',
    budget_product_skus: ['ai_credits'],
    budget_scope: 'enterprise',
    budget_amount: amount,
    prevent_further_usage: true,
    budget_alerting: { will_alert: true, alert_recipients: ['billing-manager'] }
  }
}

function otherBudget(sku: string, amount: number): Record<string, unknown> {
  return { budget_type: 'ProductPricing', budget_product_skus: [sku], budget_amount: amount }
}

function usageItem(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    product: 'Copilot',
    sku: 'Copilot AI Credits',
    model: 'GPT-5',
    unitType: 'credits',
    pricePerUnit: 0.01,
    grossQuantity: 0,
    grossAmount: 0,
    discountQuantity: 0,
    discountAmount: 0,
    netQuantity: 0,
    netAmount: 0,
    ...overrides
  }
}

function budgetPage(budgets: unknown[], hasNextPage = false): unknown {
  return { budgets, has_next_page: hasNextPage, total_count: budgets.length }
}

function usagePage(items: unknown[]): unknown {
  return {
    timePeriod: { year: 2026, month: 7 },
    enterprise: 'GitHub',
    usageItems: items
  }
}

function userEntitlement(overrides: Record<string, unknown> = {}): unknown {
  return {
    quota_reset_date_utc: '2026-08-01T00:00:00.000Z',
    quota_snapshots: {
      premium_interactions: {
        credits_used: 264_518,
        entitlement: 1_000_000
      }
    },
    ...overrides
  }
}

function primeOk(budgets: unknown[], items: unknown[]): void {
  ghExecFileAsyncMock
    .mockResolvedValueOnce(ghOk(budgetPage(budgets)))
    .mockResolvedValueOnce(ghOk(usagePage(items)))
}

function budgetArgs(page: number): string[] {
  return [
    'api',
    `/enterprises/${ENTERPRISE}/settings/billing/budgets?per_page=100&page=${page}`,
    '-H',
    `X-GitHub-Api-Version: ${GITHUB_API_VERSION}`
  ]
}

function usageArgs(year: number, month: number): string[] {
  return [
    'api',
    `/enterprises/${ENTERPRISE}/settings/billing/ai_credit/usage?year=${year}&month=${month}`,
    '-H',
    `X-GitHub-Api-Version: ${GITHUB_API_VERSION}`
  ]
}

function callArgs(index: number): string[] | undefined {
  return ghExecFileAsyncMock.mock.calls[index]?.[0]
}

function callOptions(index: number): GhCallOptions | undefined {
  return ghExecFileAsyncMock.mock.calls[index]?.[1]
}

function requestOptions(): { token: string; enterpriseSlug: string } {
  return { token: TOKEN, enterpriseSlug: ENTERPRISE }
}

describe('fetchCopilotRateLimits', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(FROZEN_NOW))
    ghExecFileAsyncMock.mockReset()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('converts the dollar budget into the AI credits the usage report prices', async () => {
    primeOk(
      [aiCreditBudget(10_000)],
      [
        usageItem({ netQuantity: 250_000, netAmount: 2_500 }),
        usageItem({ netQuantity: 150_000, netAmount: 1_500 })
      ]
    )

    const result = await fetchCopilotRateLimits(requestOptions())

    expect(result).toEqual({
      provider: 'copilot',
      session: null,
      weekly: null,
      monthly: {
        usedPercent: 40,
        windowMinutes: 43_200,
        resetsAt: NEXT_MONTH_START,
        resetDescription: null
      },
      allowance: {
        unit: { kind: 'count', label: 'AI credits' },
        used: 400_000,
        limit: 1_000_000,
        resetsAt: NEXT_MONTH_START
      },
      updatedAt: FROZEN_NOW,
      error: null,
      status: 'ok',
      usageMetadata: { source: 'web' }
    })
    // 10,000 dollars at the documented 0.01 price lands on exactly one million credits.
    expect(result.allowance?.limit).toBe(1_000_000)
    expect(result.allowance?.unit).toEqual({ kind: 'count', label: 'AI credits' })
  })

  it('reads the budget then this month’s usage, through gh, with the documented argv', async () => {
    primeOk([aiCreditBudget(10_000)], [usageItem({ netQuantity: 1, netAmount: 0.01 })])

    await fetchCopilotRateLimits(requestOptions())

    expect(ghExecFileAsyncMock).toHaveBeenCalledTimes(2)
    expect(callArgs(0)).toEqual(budgetArgs(1))
    expect(callArgs(1)).toEqual(usageArgs(2026, 7))
  })

  it('passes the stored credential to gh as GH_TOKEN', async () => {
    primeOk([aiCreditBudget(10_000)], [usageItem({ netQuantity: 1, netAmount: 0.01 })])

    await fetchCopilotRateLimits(requestOptions())

    expect(callOptions(0)?.env?.GH_TOKEN).toBe(TOKEN)
    expect(callOptions(1)?.env?.GH_TOKEN).toBe(TOKEN)
  })

  it('sends no env override when nothing is stored, so gh uses its own sign-in', async () => {
    primeOk([aiCreditBudget(10_000)], [usageItem({ netQuantity: 1, netAmount: 0.01 })])

    const result = await fetchCopilotRateLimits({ token: '   ', enterpriseSlug: ENTERPRISE })

    expect(result.status).toBe('ok')
    expect(callOptions(0)).toEqual({})
    expect(callOptions(1)).toEqual({})
  })

  it('reads the GitHub CLI user entitlement without enterprise administration', async () => {
    ghExecFileAsyncMock.mockResolvedValueOnce(ghOk(userEntitlement()))

    const result = await fetchCopilotRateLimits({
      token: '',
      enterpriseSlug: '',
      source: 'user-entitlement'
    })

    expect(result).toEqual({
      provider: 'copilot',
      session: null,
      weekly: null,
      monthly: {
        usedPercent: 26.4518,
        windowMinutes: 43_200,
        resetsAt: Date.UTC(2026, 7, 1),
        resetDescription: null
      },
      allowance: {
        unit: { kind: 'count', label: 'AI credits' },
        used: 264_518,
        limit: 1_000_000,
        resetsAt: Date.UTC(2026, 7, 1)
      },
      updatedAt: FROZEN_NOW,
      error: null,
      status: 'ok',
      usageMetadata: { source: 'web' }
    })
    expect(callArgs(0)).toEqual([
      'api',
      '/copilot_internal/user',
      '-H',
      `X-GitHub-Api-Version: ${GITHUB_API_VERSION}`
    ])
    expect(callOptions(0)).toEqual({})
  })

  it('reports an unreadable user entitlement instead of inventing a quota', async () => {
    ghExecFileAsyncMock.mockResolvedValueOnce(ghOk({ quota_snapshots: {} }))

    const result = await fetchCopilotRateLimits({
      token: '',
      enterpriseSlug: '',
      source: 'user-entitlement'
    })

    expect(result.status).toBe('error')
    expect(result.usageMetadata).toEqual({ failureKind: 'parse', source: 'web' })
    expect(result.error).toMatch(/no usable premium-interaction entitlement/i)
  })

  it('encodes the enterprise slug into the API path', async () => {
    primeOk([aiCreditBudget(10_000)], [usageItem({ netQuantity: 1, netAmount: 0.01 })])

    await fetchCopilotRateLimits({ token: '', enterpriseSlug: 'acme corp' })

    expect(callArgs(0)?.[1]).toBe(
      '/enterprises/acme%20corp/settings/billing/budgets?per_page=100&page=1'
    )
    expect(callArgs(1)?.[1]).toBe(
      '/enterprises/acme%20corp/settings/billing/ai_credit/usage?year=2026&month=7'
    )
  })

  it('follows has_next_page to find the AI-credit budget', async () => {
    ghExecFileAsyncMock
      .mockResolvedValueOnce(ghOk(budgetPage([otherBudget('actions', 1_000)], true)))
      .mockResolvedValueOnce(ghOk(budgetPage([aiCreditBudget(10_000)])))
      .mockResolvedValueOnce(ghOk(usagePage([usageItem({ netQuantity: 100, netAmount: 1 })])))

    const result = await fetchCopilotRateLimits(requestOptions())

    expect(result.status).toBe('ok')
    expect(result.allowance?.limit).toBe(1_000_000)
    expect(callArgs(0)).toEqual(budgetArgs(1))
    expect(callArgs(1)).toEqual(budgetArgs(2))
    expect(callArgs(2)).toEqual(usageArgs(2026, 7))
  })

  it('bounds paging instead of following a pathological has_next_page forever', async () => {
    for (let page = 0; page < 5; page += 1) {
      ghExecFileAsyncMock.mockResolvedValueOnce(
        ghOk(budgetPage([otherBudget('actions', 1_000)], true))
      )
    }

    const result = await fetchCopilotRateLimits(requestOptions())

    expect(result.status).toBe('error')
    expect(result.error).toMatch(/no ai-credit budget/i)
    expect(ghExecFileAsyncMock).toHaveBeenCalledTimes(5)
    expect(callArgs(4)).toEqual(budgetArgs(5))
  })

  it('errors with a message naming the enterprise when no AI-credit budget exists', async () => {
    ghExecFileAsyncMock.mockResolvedValueOnce(
      ghOk(budgetPage([otherBudget('actions', 1_000), otherBudget('packages', 2_000)]))
    )

    const result = await fetchCopilotRateLimits(requestOptions())

    expect(result.status).toBe('error')
    expect(result.status).not.toBe('unavailable')
    expect(result.error).toContain(ENTERPRISE)
    expect(result.error).toMatch(/no ai-credit budget/i)
    expect(result.usageMetadata).toEqual({ failureKind: 'usage-unavailable', source: 'web' })
    expect(result.allowance).toBeUndefined()
    // The usage endpoint is pointless once the ceiling is known to be missing.
    expect(ghExecFileAsyncMock).toHaveBeenCalledTimes(1)
  })

  it('accepts the budget amount as a numeric string', async () => {
    primeOk([aiCreditBudget('10000')], [usageItem({ netQuantity: 100, netAmount: 1 })])

    const result = await fetchCopilotRateLimits(requestOptions())

    expect(result.status).toBe('ok')
    expect(result.allowance?.limit).toBe(1_000_000)
    expect(result.allowance?.used).toBe(100)
  })

  it.each([
    ['zero', 0],
    ['a non-numeric string', 'not-a-number'],
    ['null', null],
    ['an empty string', ''],
    ['an object', {}]
  ])('errors cleanly rather than dividing by %s budget_amount', async (_label, amount) => {
    ghExecFileAsyncMock.mockResolvedValueOnce(ghOk(budgetPage([aiCreditBudget(amount)])))

    const result = await fetchCopilotRateLimits(requestOptions())

    expect(result.status).toBe('error')
    expect(result.usageMetadata).toEqual({ failureKind: 'parse', source: 'web' })
    expect(result.error).toMatch(/no usable amount/i)
    expect(result.allowance).toBeUndefined()
    expect(result.monthly).toBeUndefined()
    expect(ghExecFileAsyncMock).toHaveBeenCalledTimes(1)
  })

  const HTTP_STATUS_CASES: [number, UsageRateLimitFailureKind, RegExp][] = [
    [401, 'stale-token', /rejected the token/i],
    [403, 'missing-scope', /enterprise billing permissions/i],
    [404, 'usage-unavailable', /check the enterprise slug/i],
    [500, 'server', /server error/i],
    [503, 'server', /server error/i]
  ]

  it.each(HTTP_STATUS_CASES)(
    'maps HTTP %i on the budget endpoint to failureKind %s',
    async (status, failureKind, messagePattern) => {
      ghExecFileAsyncMock.mockRejectedValueOnce(ghHttpError(status))

      const result = await fetchCopilotRateLimits(requestOptions())

      expect(result.status).toBe('error')
      expect(result.usageMetadata?.failureKind).toBe(failureKind)
      expect(result.error).toMatch(messagePattern)
      expect(ghExecFileAsyncMock).toHaveBeenCalledTimes(1)
    }
  )

  it.each(HTTP_STATUS_CASES)(
    'maps HTTP %i on the usage endpoint to failureKind %s',
    async (status, failureKind) => {
      ghExecFileAsyncMock
        .mockResolvedValueOnce(ghOk(budgetPage([aiCreditBudget(10_000)])))
        .mockRejectedValueOnce(ghHttpError(status))

      const result = await fetchCopilotRateLimits(requestOptions())

      expect(result.status).toBe('error')
      expect(result.usageMetadata?.failureKind).toBe(failureKind)
      expect(ghExecFileAsyncMock).toHaveBeenCalledTimes(2)
    }
  )

  it('recovers the status from gh stderr even when gh prints a JSON error body after it', async () => {
    ghExecFileAsyncMock.mockRejectedValueOnce(
      ghCliError('gh: Not Found (HTTP 404)\n{"message":"Not Found","status":"404"}')
    )

    const result = await fetchCopilotRateLimits(requestOptions())

    expect(result.usageMetadata?.failureKind).toBe('usage-unavailable')
    expect(result.error).toMatch(/check the enterprise slug/i)
  })

  it('falls back to usage-unavailable for an unmapped HTTP status', async () => {
    ghExecFileAsyncMock.mockRejectedValueOnce(ghHttpError(400))

    const result = await fetchCopilotRateLimits(requestOptions())

    expect(result.status).toBe('error')
    expect(result.usageMetadata?.failureKind).toBe('usage-unavailable')
    expect(result.error).toContain('400')
  })

  it('treats a gh failure with no HTTP status as a CLI error, not as a server error', async () => {
    ghExecFileAsyncMock.mockRejectedValueOnce(ghCliError('gh: could not connect to api.github.com'))

    const result = await fetchCopilotRateLimits(requestOptions())

    expect(result.status).toBe('error')
    expect(result.usageMetadata).toEqual({ failureKind: 'usage-unavailable', source: 'web' })
    expect(result.error).toContain('could not connect to api.github.com')
    expect(result.error).toContain('GitHub CLI')
  })

  it('survives a gh rejection that carries no Error object', async () => {
    ghExecFileAsyncMock.mockRejectedValueOnce('gh exploded')

    const result = await fetchCopilotRateLimits(requestOptions())

    expect(result.status).toBe('error')
    expect(result.usageMetadata?.failureKind).toBe('usage-unavailable')
    expect(result.error).toContain('gh exploded')
  })

  it.each([
    ['the budget endpoint', 0],
    ['the usage endpoint', 1]
  ])('reports a missing gh CLI as cli-unavailable on %s', async (_label, failureIndex) => {
    if (failureIndex === 1) {
      ghExecFileAsyncMock.mockResolvedValueOnce(ghOk(budgetPage([aiCreditBudget(10_000)])))
    }
    ghExecFileAsyncMock.mockRejectedValueOnce(ghEnoent())

    const result = await fetchCopilotRateLimits(requestOptions())

    expect(result.status).toBe('error')
    expect(result.usageMetadata).toEqual({ failureKind: 'cli-unavailable', source: 'web' })
    expect(result.error).toMatch(/install gh/i)
    expect(result.error).toContain('gh auth login')
  })

  it.each([
    ['the budget endpoint', 0],
    ['the usage endpoint', 1]
  ])(
    'reports unreadable JSON from %s as a parse error without throwing',
    async (_label, failureIndex) => {
      if (failureIndex === 1) {
        ghExecFileAsyncMock.mockResolvedValueOnce(ghOk(budgetPage([aiCreditBudget(10_000)])))
      }
      ghExecFileAsyncMock.mockResolvedValueOnce({
        stdout: '<html><body>gateway error</body></html>',
        stderr: ''
      })

      const result = await fetchCopilotRateLimits(requestOptions())

      expect(result.status).toBe('error')
      expect(result.usageMetadata).toEqual({ failureKind: 'parse', source: 'web' })
      expect(result.error).toMatch(/unreadable json/i)
    }
  )

  it('returns unavailable without any gh call when neither a token nor a slug is configured', async () => {
    const result = await fetchCopilotRateLimits({ token: '  ', enterpriseSlug: '  ' })

    expect(result.status).toBe('unavailable')
    expect(result.provider).toBe('copilot')
    expect(result.allowance).toBeUndefined()
    expect(result.monthly).toBeUndefined()
    expect(result.error).toMatch(/not configured/i)
    expect(result.usageMetadata).toEqual({ failureKind: 'missing-credentials', source: 'web' })
    expect(ghExecFileAsyncMock).not.toHaveBeenCalled()
  })

  it('returns unavailable without any gh call when only the enterprise slug is missing', async () => {
    const result = await fetchCopilotRateLimits({ token: TOKEN, enterpriseSlug: '  ' })

    expect(result.status).toBe('unavailable')
    expect(result.error).toContain('No GitHub enterprise selected')
    expect(result.usageMetadata).toEqual({ failureKind: 'missing-credentials', source: 'web' })
    expect(ghExecFileAsyncMock).not.toHaveBeenCalled()
  })

  it('rolls the reset over the year boundary in UTC', async () => {
    vi.setSystemTime(new Date(Date.parse('2026-12-31T23:30:00.000Z')))
    primeOk([aiCreditBudget(10_000)], [usageItem({ netQuantity: 1, netAmount: 0.01 })])

    const result = await fetchCopilotRateLimits(requestOptions())

    expect(result.allowance?.resetsAt).toBe(Date.UTC(2027, 0, 1))
    expect(result.monthly?.resetsAt).toBe(Date.UTC(2027, 0, 1))
    // The usage query follows the frozen clock, not the reset boundary.
    expect(callArgs(1)).toEqual(usageArgs(2026, 12))
  })

  const GARBAGE_BUDGET_PAYLOADS: [string, string, UsageRateLimitFailureKind][] = [
    ['a null budget body', 'null', 'usage-unavailable'],
    ['an array where the budget object belongs', '[]', 'usage-unavailable'],
    ['a string where the budget object belongs', '"not-an-object"', 'usage-unavailable'],
    ['a null budgets field', '{"budgets":null}', 'usage-unavailable'],
    ['a string budgets field', '{"budgets":"nope"}', 'usage-unavailable'],
    ['nulls and scalars inside budgets', '{"budgets":[null,7,"x",[]]}', 'usage-unavailable'],
    [
      'non-string entries inside the SKU list',
      '{"budgets":[{"budget_product_skus":[null,5],"budget_amount":100}]}',
      'usage-unavailable'
    ]
  ]

  it.each(GARBAGE_BUDGET_PAYLOADS)(
    'never throws and reports usage-unavailable for %s',
    async (_label, stdout, failureKind) => {
      ghExecFileAsyncMock.mockResolvedValueOnce({ stdout, stderr: '' })

      const result = await fetchCopilotRateLimits(requestOptions())

      expect(result.provider).toBe('copilot')
      expect(result.status).toBe('error')
      expect(result.usageMetadata?.failureKind).toBe(failureKind)
      expect(result.updatedAt).toBe(FROZEN_NOW)
      expect(ghExecFileAsyncMock).toHaveBeenCalledTimes(1)
    }
  )

  const GARBAGE_USAGE_PAYLOADS: string[] = [
    'null',
    '[]',
    '"not-an-object"',
    '{"usageItems":null}',
    '{"usageItems":"nope"}',
    '{"usageItems":[null,7,"x",[]]}',
    '{"usageItems":[{"netQuantity":"abc","netAmount":{},"pricePerUnit":[]}]}'
  ]

  it.each(GARBAGE_USAGE_PAYLOADS)(
    'still returns a snapshot when the usage report is %s',
    async (stdout) => {
      ghExecFileAsyncMock
        .mockResolvedValueOnce(ghOk(budgetPage([aiCreditBudget(5_000)])))
        .mockResolvedValueOnce({ stdout, stderr: '' })

      const result = await fetchCopilotRateLimits(requestOptions())

      expect(result.status).toBe('ok')
      expect(result.error).toBeNull()
      // No price is reported, so the readout stays in dollars.
      expect(result.allowance).toEqual({
        unit: { kind: 'money', currencyCode: 'USD' },
        used: 0,
        limit: 5_000,
        resetsAt: NEXT_MONTH_START
      })
      expect(result.monthly?.usedPercent).toBe(0)
      expect(result.updatedAt).toBe(FROZEN_NOW)
    }
  )
})
