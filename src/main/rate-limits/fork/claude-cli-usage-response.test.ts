import { describe, expect, it } from 'vitest'
import { mapClaudeCliRateLimitInfo, mapClaudeCliUsageResponse } from './claude-cli-usage-response'

// Shape captured from `claude` 2.1.316's get_usage control reply on a Max 5x seat.
function cliReply(overrides: Record<string, unknown> = {}): unknown {
  return {
    session: { total_cost_usd: 0, model_usage: {} },
    subscription_type: 'max',
    rate_limits_available: true,
    behaviors: null,
    rate_limits: {
      five_hour: { utilization: 5, resets_at: '2026-11-01T01:09:59.695700+00:00' },
      seven_day: { utilization: 7, resets_at: '2026-11-05T15:59:59.695723+00:00' },
      seven_day_opus: null,
      seven_day_sonnet: null,
      extra_usage: { is_enabled: false, monthly_limit: null, used_credits: null },
      limits: [
        {
          kind: 'session',
          group: 'session',
          percent: 5,
          resets_at: '2026-11-01T01:09:59.695700+00:00',
          is_active: false
        },
        {
          kind: 'weekly_all',
          group: 'weekly',
          percent: 7,
          resets_at: '2026-11-05T15:59:59.695723+00:00',
          is_active: true
        },
        {
          kind: 'weekly_scoped',
          group: 'weekly',
          percent: 12,
          resets_at: '2026-11-05T16:00:00+00:00',
          scope: { model: { id: null, display_name: 'Fable' }, surface: null },
          is_active: false
        }
      ],
      spend: { used: { amount_minor: 0, currency: 'USD', exponent: 2 }, limit: null, percent: 0 },
      ...overrides
    }
  }
}

describe('mapClaudeCliUsageResponse', () => {
  it('maps the plan windows, the Fable weekly window and the spend balance', () => {
    const mapped = mapClaudeCliUsageResponse(cliReply())

    expect(mapped).not.toBeNull()
    expect(mapped?.status).toBe('ok')
    expect(mapped?.provider).toBe('claude')
    expect(mapped?.session?.usedPercent).toBe(5)
    expect(mapped?.session?.windowMinutes).toBe(300)
    expect(mapped?.weekly?.usedPercent).toBe(7)
    expect(mapped?.weekly?.windowMinutes).toBe(10_080)
    expect(mapped?.fableWeekly?.usedPercent).toBe(12)
    expect(mapped?.monthly).toBeNull()
    expect(mapped?.usageMetadata?.source).toBe('cli')
  })

  it('reads the Fable window from model_scoped when a reply carries no limits array', () => {
    const mapped = mapClaudeCliUsageResponse(
      cliReply({
        limits: null,
        model_scoped: [
          { display_name: 'Fable', utilization: 21, resets_at: '2026-11-05T16:00:00+00:00' }
        ]
      })
    )

    expect(mapped?.fableWeekly?.usedPercent).toBe(21)
  })

  it('treats a session with no plan limits as no reading at all', () => {
    expect(
      mapClaudeCliUsageResponse({
        subscription_type: null,
        rate_limits_available: false,
        rate_limits: null
      })
    ).toBeNull()
  })

  it('returns null for payloads this fork cannot trust', () => {
    expect(mapClaudeCliUsageResponse(null)).toBeNull()
    expect(mapClaudeCliUsageResponse('rate limited')).toBeNull()
    expect(mapClaudeCliUsageResponse({ rate_limits_available: true, rate_limits: null })).toBeNull()
    expect(mapClaudeCliUsageResponse({ rate_limits_available: true, rate_limits: {} })).toBeNull()
    expect(
      mapClaudeCliUsageResponse({
        rate_limits_available: true,
        rate_limits: { five_hour: { utilization: null }, seven_day: { util: 4 } }
      })
    ).toBeNull()
  })

  it('reports the enterprise spend cap as the monthly window when no plan windows exist', () => {
    const mapped = mapClaudeCliUsageResponse(
      cliReply({
        five_hour: null,
        seven_day: null,
        limits: [],
        spend: {
          used: { amount_minor: 500, currency: 'USD', exponent: 2 },
          limit: { amount_minor: 1000, currency: 'USD', exponent: 2 },
          percent: 50
        }
      })
    )

    expect(mapped?.session).toBeNull()
    expect(mapped?.weekly).toBeNull()
    expect(mapped?.monthly?.usedPercent).toBe(50)
    expect(mapped?.monthly?.windowMinutes).toBe(43_200)
  })
})

describe('the CLI rate limit event a turn publishes', () => {
  // Captured from Claude CLI 2.1.319 `--output-format stream-json` on 2026-11-09.
  const event = {
    status: 'allowed',
    resetsAt: 1794232800,
    rateLimitType: 'five_hour',
    overageStatus: 'rejected',
    overageDisabledReason: 'org_level_disabled',
    isUsingOverage: false,
    unifiedWindows: {
      five_hour: { utilization: 0.02, resetsAt: 1794232800, status: 'allowed' },
      seven_day: { utilization: 0.15, resetsAt: 1794499200, status: 'allowed' }
    }
  }

  it('maps both plan windows from the event', () => {
    const mapped = mapClaudeCliRateLimitInfo(event)

    expect(mapped?.status).toBe('ok')
    expect(mapped?.session?.usedPercent).toBeCloseTo(2)
    expect(mapped?.session?.windowMinutes).toBe(300)
    expect(mapped?.session?.resetsAt).toBe(1_794_232_800_000)
    expect(mapped?.weekly?.usedPercent).toBeCloseTo(15)
    expect(mapped?.weekly?.resetsAt).toBe(1_794_499_200_000)
    expect(mapped?.usageMetadata?.source).toBe('cli')
  })

  it('reads the fraction as a fraction at the cap, not as a bare percentage', () => {
    const mapped = mapClaudeCliRateLimitInfo({
      unifiedWindows: { five_hour: { utilization: 1.05, resetsAt: 1794232800 } }
    })

    expect(mapped?.session?.usedPercent).toBe(100)
  })

  it('reports nothing when the event carries no window', () => {
    expect(mapClaudeCliRateLimitInfo({ status: 'allowed' })).toBeNull()
    expect(mapClaudeCliRateLimitInfo({ unifiedWindows: {} })).toBeNull()
    expect(mapClaudeCliRateLimitInfo(null)).toBeNull()
    expect(mapClaudeCliRateLimitInfo('allowed')).toBeNull()
  })
})
