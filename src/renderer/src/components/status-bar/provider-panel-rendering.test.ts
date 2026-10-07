import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { createElement } from 'react'
import type * as ReactModule from 'react'
import type { ProviderRateLimits } from '../../../../shared/rate-limit-types'

vi.mock('@/lib/agent-catalog', async () => {
  const ReactActual = await vi.importActual<typeof ReactModule>('react')
  return {
    AgentIcon: ({ agent }: { agent: string }) =>
      ReactActual.createElement('span', { 'data-agent-icon': agent })
  }
})

vi.mock('@/i18n/i18n', () => ({
  getIntlLocale: () => 'en-US',
  translate: (_key: string, fallback: string, values?: Record<string, string>) => {
    let result = fallback
    for (const [key, value] of Object.entries(values ?? {})) {
      result = result.replace(`{{${key}}}`, value)
    }
    return result
  }
}))

import { ProviderPanel } from './tooltip'

function provider(overrides: Partial<ProviderRateLimits> = {}): ProviderRateLimits {
  return {
    provider: 'claude',
    session: null,
    weekly: null,
    updatedAt: 0,
    error: null,
    status: 'error',
    ...overrides
  }
}

const PROVIDER_IDS: ProviderRateLimits['provider'][] = [
  'claude',
  'codex',
  'gemini',
  'antigravity',
  'opencode-go',
  'kimi',
  'minimax',
  'grok',
  'zcode'
]

afterEach(() => {
  vi.useRealTimers()
})

describe('ProviderPanel extra-usage rendering', () => {
  it('renders the Claude usage-credits cap as a spent/limit meter plus balance', () => {
    const p = provider({
      status: 'ok',
      session: { usedPercent: 100, windowMinutes: 300, resetsAt: null, resetDescription: null },
      extraUsage: {
        balance: 10,
        unit: 'currency',
        currencyCode: 'EUR',
        enabled: true,
        disabledReason: null,
        spent: 50,
        spendLimit: 2000,
        spentPercent: 2.5,
        resetsAt: null
      }
    })

    const markup = renderToStaticMarkup(createElement(ProviderPanel, { p }))

    expect(markup).toContain('Usage credits')
    expect(markup).toContain('€2,000.00')
    expect(markup).toContain('€50.00')
    expect(markup).toContain('% used')
    expect(markup).toContain('Balance €10.00')
  })

  it('renders a legacy spend cap without presenting an unavailable balance as zero', () => {
    const p = provider({
      status: 'ok',
      session: { usedPercent: 100, windowMinutes: 300, resetsAt: null, resetDescription: null },
      extraUsage: {
        balance: null,
        unit: 'currency',
        currencyCode: 'EUR',
        enabled: true,
        disabledReason: null,
        spent: 50,
        spendLimit: 2000,
        spentPercent: 2.5,
        resetsAt: null
      }
    })

    const markup = renderToStaticMarkup(createElement(ProviderPanel, { p }))

    expect(markup).toContain('Usage credits')
    expect(markup).toContain('€50.00 / €2,000.00')
    expect(markup).not.toContain('Balance €0.00')
  })

  it('renders a known legacy cap without inventing spend, percent, balance, or a meter', () => {
    const p = provider({
      status: 'ok',
      extraUsage: {
        balance: null,
        unit: 'currency',
        currencyCode: 'EUR',
        enabled: true,
        disabledReason: null,
        spent: null,
        spendLimit: 2000,
        spentPercent: null,
        resetsAt: null
      }
    })

    const markup = renderToStaticMarkup(createElement(ProviderPanel, { p }))

    expect(markup).toContain('Usage credits')
    expect(markup).toContain('Limit €2,000.00')
    expect(markup).not.toContain('€0.00')
    expect(markup).not.toContain('% used')
    expect(markup).not.toContain('h-[6px]')
  })

  it('keeps a known cap as a caption when spend is unknown even if a percentage is present', () => {
    const p = provider({
      status: 'ok',
      extraUsage: {
        balance: null,
        unit: 'currency',
        currencyCode: 'EUR',
        enabled: true,
        disabledReason: null,
        spent: null,
        spendLimit: 2000,
        spentPercent: 10,
        resetsAt: null
      }
    })
    const markup = renderToStaticMarkup(createElement(ProviderPanel, { p }))
    expect(markup).toContain('Limit €2,000.00')
    expect(markup).not.toContain('€0.00')
    expect(markup).not.toContain('% used')
    expect(markup).not.toContain('h-[6px]')
  })

  it('renders a disabled, out-of-credits cap with a zero balance', () => {
    const p = provider({
      status: 'ok',
      session: { usedPercent: 100, windowMinutes: 300, resetsAt: null, resetDescription: null },
      extraUsage: {
        balance: 0,
        unit: 'currency',
        currencyCode: 'EUR',
        enabled: false,
        disabledReason: 'out_of_credits',
        spent: 0,
        spendLimit: 2000,
        spentPercent: 0,
        resetsAt: null
      }
    })

    const markup = renderToStaticMarkup(createElement(ProviderPanel, { p }))

    expect(markup).toContain('Usage credits')
    expect(markup).toContain('€0.00 / €2,000.00')
    expect(markup).toContain('Balance €0.00')
  })

  it('renders an uncapped OpenCode Go balance as a plain available amount', () => {
    const p = provider({
      provider: 'opencode-go',
      status: 'ok',
      session: { usedPercent: 20, windowMinutes: 300, resetsAt: null, resetDescription: null },
      extraUsage: {
        balance: 12.4,
        unit: 'currency',
        currencyCode: 'USD',
        enabled: true,
        disabledReason: null,
        spent: null,
        spendLimit: null,
        spentPercent: null,
        resetsAt: null
      }
    })

    const markup = renderToStaticMarkup(createElement(ProviderPanel, { p }))

    expect(markup).toContain('Zen balance')
    expect(markup).toContain('$12.40')
    expect(markup).toContain('available')
  })

  it.each([
    [0, '$0.00'],
    [-1.25, '-$1.25']
  ])('keeps a depleted Zen balance of %s visible in the popover', (balance, formatted) => {
    const p = provider({
      provider: 'opencode-go',
      status: 'ok',
      session: { usedPercent: 100, windowMinutes: 300, resetsAt: null, resetDescription: null },
      extraUsage: {
        balance,
        unit: 'currency',
        currencyCode: 'USD',
        enabled: true,
        disabledReason: null,
        spent: null,
        spendLimit: null,
        spentPercent: null,
        resetsAt: null
      }
    })

    const markup = renderToStaticMarkup(createElement(ProviderPanel, { p }))

    expect(markup).toContain('Zen balance')
    expect(markup).toContain(formatted)
    expect(markup).toContain('available')
  })

  it.each([
    ['refresh-failed', 'Refresh failed'],
    ['billing-unavailable', 'Unavailable'],
    ['api-key-source', 'Balance is not included in this usage response.']
  ])('shows an unknown Zen balance honestly for %s', (disabledReason, message) => {
    const p = provider({
      provider: 'opencode-go',
      status: 'ok',
      session: { usedPercent: 20, windowMinutes: 300, resetsAt: null, resetDescription: null },
      extraUsage: {
        balance: null,
        unit: 'currency',
        currencyCode: 'USD',
        enabled: false,
        disabledReason,
        spent: null,
        spendLimit: null,
        spentPercent: null,
        resetsAt: null
      }
    })

    const markup = renderToStaticMarkup(createElement(ProviderPanel, { p }))

    expect(markup).toContain('Zen balance')
    expect(markup).toContain(message)
    expect(markup).toContain('Session')
    expect(markup).not.toContain('$0.00')
    expect(markup).not.toMatch(/\$[\d,.]+ available/)
  })

  it('renders a Codex credit count as a plain "N credits available" line', () => {
    const p = provider({
      provider: 'codex',
      status: 'ok',
      session: { usedPercent: 20, windowMinutes: 300, resetsAt: null, resetDescription: null },
      extraUsage: {
        balance: 500,
        unit: 'credits',
        unlimited: false,
        enabled: true,
        disabledReason: null,
        resetsAt: null
      }
    })

    const markup = renderToStaticMarkup(createElement(ProviderPanel, { p }))

    expect(markup).toContain('Credits')
    expect(markup).toContain('500 credits available')
    // A credit count is not a currency amount.
    expect(markup).not.toContain('$500')
  })

  it('renders unlimited Codex credits as "Unlimited"', () => {
    const p = provider({
      provider: 'codex',
      status: 'ok',
      session: { usedPercent: 20, windowMinutes: 300, resetsAt: null, resetDescription: null },
      extraUsage: {
        balance: 0,
        unit: 'credits',
        unlimited: true,
        enabled: true,
        disabledReason: null,
        resetsAt: null
      }
    })

    const markup = renderToStaticMarkup(createElement(ProviderPanel, { p }))

    expect(markup).toContain('Unlimited')
  })

  it('omits the balance row when no extra usage is reported', () => {
    const p = provider({
      status: 'ok',
      session: { usedPercent: 40, windowMinutes: 300, resetsAt: null, resetDescription: null }
    })

    const markup = renderToStaticMarkup(createElement(ProviderPanel, { p }))

    expect(markup).not.toContain('Usage credits')
    expect(markup).not.toContain('Zen balance')
  })
})

describe('ProviderPanel reset rendering', () => {
  it('renders the Fable reset countdown when Claude reports a reset timestamp', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 6, 3, 20, 0))
    const p = provider({
      status: 'ok',
      session: null,
      weekly: null,
      fableWeekly: {
        usedPercent: 62,
        windowMinutes: 10080,
        resetsAt: Date.now() + (6 * 24 + 17) * 60 * 60_000,
        resetDescription: 'Jul 10 at 1:00 PM'
      }
    })

    const markup = renderToStaticMarkup(createElement(ProviderPanel, { p }))

    expect(markup).toContain('Fable')
    expect(markup).toContain('Resets in 6d 17h')
  })

  it('renders MiniMax session as usedPercent so the value matches the bar', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 6, 4, 15, 0))
    const p = provider({
      provider: 'minimax',
      status: 'ok',
      session: {
        usedPercent: 35,
        windowMinutes: 300,
        resetsAt: Date.now() + 2 * 60 * 60_000,
        resetDescription: null
      }
    })

    const markup = renderToStaticMarkup(createElement(ProviderPanel, { p }))

    // Why: bars show consumption (% used), matching harness meters (#7551).
    expect(markup).toContain('35%')
    expect(markup).toContain('% used')
    expect(markup).not.toContain('% left')
  })

  it('clamps MiniMax session to 100% used when usedPercent reports 100', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 6, 4, 15, 0))
    const p = provider({
      provider: 'minimax',
      status: 'ok',
      session: {
        usedPercent: 100,
        windowMinutes: 300,
        resetsAt: Date.now() + 2 * 60 * 60_000,
        resetDescription: null
      }
    })

    const markup = renderToStaticMarkup(createElement(ProviderPanel, { p }))

    expect(markup).toContain('100%')
    expect(markup).toContain('% used')
  })

  it('clamps over-100 usedPercent to 100% used in the panel', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 6, 4, 15, 0))
    const p = provider({
      provider: 'minimax',
      status: 'ok',
      session: {
        usedPercent: 140,
        windowMinutes: 300,
        resetsAt: Date.now() + 2 * 60 * 60_000,
        resetDescription: null
      }
    })

    const markup = renderToStaticMarkup(createElement(ProviderPanel, { p }))

    expect(markup).toContain('100%')
    expect(markup).toContain('width:100%')
    expect(markup).not.toContain('140%')
  })

  it.each(PROVIDER_IDS)('applies remaining copy and meter fill to %s', (providerId) => {
    const p = provider({
      provider: providerId,
      status: 'ok',
      session: {
        usedPercent: 25,
        windowMinutes: 300,
        resetsAt: null,
        resetDescription: null
      }
    })

    const markup = renderToStaticMarkup(
      createElement(ProviderPanel, { p, usagePercentageDisplay: 'remaining' })
    )

    expect(markup).toContain('75% left')
    expect(markup).toContain('width:75%')
    expect(markup).not.toContain('width:25%')
  })
})

describe('ProviderPanel credits', () => {
  function creditsProvider(overrides: Partial<ProviderRateLimits> = {}): ProviderRateLimits {
    return provider({
      provider: 'deepseek',
      status: 'ok',
      credits: {
        kind: 'balance',
        amount: { currencyCode: 'USD', units: '42', nanos: 100_000_000 },
        items: [
          { key: 'granted', amount: { currencyCode: 'USD', units: '10', nanos: 0 } },
          { key: 'topped-up', amount: { currencyCode: 'USD', units: '32', nanos: 100_000_000 } }
        ]
      },
      ...overrides
    })
  }

  it('renders the balance headline and the granted / topped-up breakdown', () => {
    const markup = renderToStaticMarkup(createElement(ProviderPanel, { p: creditsProvider() }))

    expect(markup).toContain('data-provider-credits')
    expect(markup).toContain('42.10 available')
    expect(markup).toContain('Granted')
    expect(markup).toContain('Topped up')
    expect(markup).not.toContain('Balance cannot fund further calls')
  })

  it('warns inline when the balance cannot fund further calls', () => {
    // `available: false` never folds into status, so this row is the only place
    // an exhausted-but-configured account learns why its calls fail.
    const markup = renderToStaticMarkup(
      createElement(ProviderPanel, {
        p: creditsProvider({
          credits: {
            kind: 'balance',
            amount: { currencyCode: 'USD', units: '0', nanos: 0 },
            available: false
          }
        })
      })
    )

    expect(markup).toContain('Balance cannot fund further calls')
    expect(markup).toContain('text-destructive')
  })

  it('keeps spend copy and treats credits as data an error is staling', () => {
    const markup = renderToStaticMarkup(
      createElement(ProviderPanel, {
        p: creditsProvider({
          status: 'error',
          error: 'Network error while refreshing usage',
          credits: {
            kind: 'spend',
            amount: { currencyCode: 'USD', units: '18', nanos: 440_000_000 },
            period: 'current-month'
          }
        })
      })
    )

    expect(markup).toContain('18.44 spent this month')
    expect(markup).toContain('Refresh failed — showing cached data')
  })
})

describe('ProviderPanel allowance', () => {
  function allowanceProvider(overrides: Partial<ProviderRateLimits> = {}): ProviderRateLimits {
    return provider({
      provider: 'claude',
      status: 'ok',
      allowance: {
        unit: { kind: 'money', currencyCode: 'USD' },
        used: 192.68,
        limit: 8000,
        resetsAt: null
      },
      ...overrides
    })
  }

  it('renders the money readout next to the credits rows', () => {
    const markup = renderToStaticMarkup(createElement(ProviderPanel, { p: allowanceProvider() }))

    expect(markup).toContain('data-provider-allowance')
    expect(markup).toContain('$192.68 of $8,000.00')
  })

  it('renders a count readout with the provider’s unit', () => {
    const markup = renderToStaticMarkup(
      createElement(ProviderPanel, {
        p: allowanceProvider({
          allowance: {
            unit: { kind: 'count', label: 'credit' },
            used: 10048.95,
            limit: 52_000,
            resetsAt: 1_800_000_000_000
          }
        })
      })
    )

    expect(markup).toContain('10,049 of 52,000 credits')
  })

  it('omits the row entirely when the provider reports no allowance', () => {
    const markup = renderToStaticMarkup(createElement(ProviderPanel, { p: allowanceProvider() }))

    expect(markup).toContain('data-provider-allowance')
    expect(
      renderToStaticMarkup(
        createElement(ProviderPanel, { p: allowanceProvider({ allowance: null }) })
      )
    ).not.toContain('data-provider-allowance')
  })

  it('treats an allowance as data an error is staling, window and credits absent', () => {
    // Why: an allowance-only plan would otherwise fall into the empty-error branch,
    // which drops the cached readout on a transient refresh failure.
    const markup = renderToStaticMarkup(
      createElement(ProviderPanel, {
        p: allowanceProvider({ status: 'error', error: 'Network error while refreshing usage' })
      })
    )

    expect(markup).toContain('$192.68 of $8,000.00')
    expect(markup).toContain('Refresh failed — showing cached data')
  })
})
