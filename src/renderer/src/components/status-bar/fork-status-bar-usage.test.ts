import { describe, expect, it } from 'vitest'
import type { ProviderRateLimits, RateLimitState } from '../../../../shared/rate-limit-types'
import { createEmptyRateLimitState } from '../../../../shared/rate-limit-state-factory'
import {
  withForkStatusBarUsage,
  type ForkStatusBarUsage,
  type ForkStatusBarUsageInputs
} from './fork-status-bar-usage'

function snapshot(
  provider: ProviderRateLimits['provider'],
  overrides: Partial<ProviderRateLimits> = {}
): ProviderRateLimits {
  return {
    provider,
    status: 'ok',
    updatedAt: 1_700_000_000_000,
    error: null,
    session: { usedPercent: 12, windowMinutes: 300, resetsAt: null, resetDescription: null },
    weekly: null,
    ...overrides
  }
}

/** Every provider settled and unconfigured: upstream's body calls this the empty state. */
function settled(overrides: Partial<RateLimitState> = {}): RateLimitState {
  const unavailable = (provider: ProviderRateLimits['provider']): ProviderRateLimits =>
    snapshot(provider, { status: 'unavailable', session: null })
  return createEmptyRateLimitState({
    claude: unavailable('claude'),
    codex: unavailable('codex'),
    gemini: unavailable('gemini'),
    opencodeGo: unavailable('opencode-go'),
    kimi: unavailable('kimi'),
    antigravity: unavailable('antigravity'),
    minimax: unavailable('minimax'),
    grok: unavailable('grok'),
    cursor: unavailable('cursor'),
    zcode: unavailable('zcode'),
    muse: unavailable('muse'),
    deepseek: unavailable('deepseek'),
    fireworks: unavailable('fireworks'),
    deepinfra: unavailable('deepinfra'),
    copilot: unavailable('copilot'),
    ...overrides
  })
}

/** What upstream's body reports for a bar with no usage meters and nothing configured. */
const NO_UPSTREAM_USAGE: ForkStatusBarUsage = {
  anyFetching: false,
  anyVisible: false,
  hasVisibleUsageMeters: false,
  isEmptyUsageState: true,
  rosterProviders: [],
  showEmptyUsageCta: true
}

const FORK_ITEMS: ForkStatusBarUsageInputs['statusBarItems'] = [
  'deepseek',
  'fireworks',
  'deepinfra',
  'copilot'
]

function merge(rateLimits: RateLimitState, overrides: Partial<ForkStatusBarUsageInputs> = {}) {
  return withForkStatusBarUsage(NO_UPSTREAM_USAGE, {
    rateLimits,
    settings: {},
    statusBarItems: FORK_ITEMS,
    ...overrides
  })
}

// Why these cases: the controller now runs upstream's per-provider body verbatim, so what can
// regress silently is the merge — a fork provider dropped from the roster, or an upstream verdict
// the fork overrides when it has nothing of its own to say.
describe('withForkStatusBarUsage', () => {
  it('leaves upstream’s numbers alone when no fork provider is configured', () => {
    expect(merge(settled())).toStrictEqual(NO_UPSTREAM_USAGE)
  })

  it('counts a fork provider’s reading as a meter and puts it in the roster', () => {
    const merged = merge(settled({ deepseek: snapshot('deepseek') }))

    expect(merged.rosterProviders.map((provider) => provider.provider)).toStrictEqual(['deepseek'])
    expect(merged.hasVisibleUsageMeters).toBe(true)
    expect(merged.anyVisible).toBe(true)
    expect(merged.isEmptyUsageState).toBe(false)
    expect(merged.showEmptyUsageCta).toBe(false)
  })

  it('shows a saved fork key as a pending bar before its first reading lands', () => {
    // Why a null slot: main publishes the presence flag before any poll has answered.
    const merged = merge(settled({ deepseek: null, deepseekApiKeyConfigured: true }))

    expect(merged.rosterProviders.map((provider) => provider.status)).toStrictEqual(['fetching'])
    expect(merged.hasVisibleUsageMeters).toBe(true)
    expect(merged.isEmptyUsageState).toBe(false)
  })

  it('reports a fork provider still fetching', () => {
    expect(
      merge(settled({ fireworks: snapshot('fireworks', { status: 'fetching', session: null }) }))
        .anyFetching
    ).toBe(true)
    expect(merge(settled()).anyFetching).toBe(false)
  })

  it('does not show a fork provider the user switched off or unchecked', () => {
    const rateLimits = settled({ deepseek: snapshot('deepseek') })
    const disabled = merge(rateLimits, { settings: { disabledUsageProviders: ['deepseek'] } })

    expect(disabled.rosterProviders).toStrictEqual([])
    expect(disabled.hasVisibleUsageMeters).toBe(false)
    expect(merge(rateLimits, { statusBarItems: [] }).rosterProviders).toStrictEqual([])
  })

  it('keeps upstream’s chip order and collapses a placeholder before a live meter', () => {
    const merged = withForkStatusBarUsage(
      {
        ...NO_UPSTREAM_USAGE,
        hasVisibleUsageMeters: true,
        anyVisible: true,
        isEmptyUsageState: false,
        rosterProviders: [
          snapshot('claude', {
            status: 'error',
            usageMetadata: {
              ownerNotSetUp: {
                kind: 'not-configured',
                ownerLabel: 'np-mini',
                signInSavedHereOnly: false
              }
            }
          }),
          snapshot('codex')
        ]
      },
      {
        rateLimits: settled({ deepseek: snapshot('deepseek') }),
        settings: {},
        statusBarItems: ['deepseek']
      }
    )

    expect(merged.rosterProviders.map((provider) => provider.provider)).toStrictEqual([
      'codex',
      'deepseek',
      'claude'
    ])
  })
})
