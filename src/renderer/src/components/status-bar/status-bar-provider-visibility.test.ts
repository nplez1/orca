import { describe, expect, it } from 'vitest'
import type { ProviderRateLimits } from '../../../../shared/rate-limit-types'
import { isUsageEmptyState } from './status-bar-provider-visibility'

/**
 * Why this file exists: `isUsageEmptyState` decides whether the status bar offers
 * "set up a provider" at all, and its input is fifteen independent slots. The
 * manifest made it one loop, so what needs pinning is the three rules the loop
 * encodes — a disabled provider never holds the CTA back, a slot the host never
 * published is not a fetch in flight, and an enable-gated provider that is off is
 * not one either.
 */

type Snapshots = Parameters<typeof isUsageEmptyState>[0]

function snapshot(
  provider: ProviderRateLimits['provider'],
  status: ProviderRateLimits['status']
): ProviderRateLimits {
  return { provider, status, updatedAt: 1, error: null, session: null, weekly: null }
}

/** Every slot settled and unconfigured: the state the setup CTA exists for. */
function allUnavailable(overrides: Partial<Snapshots> = {}): Snapshots {
  return {
    claude: snapshot('claude', 'unavailable'),
    codex: snapshot('codex', 'unavailable'),
    gemini: snapshot('gemini', 'unavailable'),
    opencodeGo: snapshot('opencode-go', 'unavailable'),
    kimi: snapshot('kimi', 'unavailable'),
    antigravity: snapshot('antigravity', 'unavailable'),
    minimax: snapshot('minimax', 'unavailable'),
    grok: snapshot('grok', 'unavailable'),
    cursor: snapshot('cursor', 'unavailable'),
    zcode: snapshot('zcode', 'unavailable'),
    deepseek: snapshot('deepseek', 'unavailable'),
    fireworks: snapshot('fireworks', 'unavailable'),
    deepinfra: snapshot('deepinfra', 'unavailable'),
    copilot: snapshot('copilot', 'unavailable'),
    muse: snapshot('muse', 'unavailable'),
    ...overrides
  }
}

describe('isUsageEmptyState', () => {
  it('waits for settings hydration', () => {
    expect(isUsageEmptyState(allUnavailable(), null)).toBe(false)
    expect(isUsageEmptyState(allUnavailable(), undefined)).toBe(false)
  })

  it('is false while any slot is still fetching', () => {
    expect(isUsageEmptyState(allUnavailable({ claude: snapshot('claude', 'fetching') }), {})).toBe(
      false
    )
  })

  it('is false while any slot has never been published', () => {
    expect(isUsageEmptyState(allUnavailable({ minimax: null }), {})).toBe(false)
  })

  it('is true when every slot settled with nothing configured', () => {
    expect(isUsageEmptyState(allUnavailable(), {})).toBe(true)
  })

  it('is false once a provider reports a reading', () => {
    expect(isUsageEmptyState(allUnavailable({ grok: snapshot('grok', 'idle') }), {})).toBe(false)
  })

  it('is false once a provider has durable setup', () => {
    expect(isUsageEmptyState(allUnavailable(), { geminiCliOAuthEnabled: true })).toBe(false)
  })

  it('does not count an enable-gated provider that is switched off as pending', () => {
    // Why antigravity: agy is read only while `antigravityUsageConfigured` is set, so a
    // slot there means "not asked" whether it is null or mid-fetch, and counting either
    // as pending would hide the CTA on every install that never enabled it.
    expect(isUsageEmptyState(allUnavailable({ antigravity: null }), {})).toBe(true)
    expect(
      isUsageEmptyState(allUnavailable({ antigravity: snapshot('antigravity', 'fetching') }), {})
    ).toBe(true)
  })

  it('does not count a switched-off provider as pending', () => {
    // Why: a disabled provider's slot stays null forever, so it must not hold the CTA.
    expect(
      isUsageEmptyState(allUnavailable({ antigravity: null, minimax: null }), {
        disabledUsageProviders: ['antigravity', 'minimax']
      })
    ).toBe(true)
  })

  it('does not count a slot the host never published as pending', () => {
    // Why `undefined` and not an absent key: this is what an older main actually sends —
    // the projection builds the object itself, so the key is there with no value in it.
    expect(isUsageEmptyState({ ...allUnavailable(), zcode: undefined, muse: undefined }, {})).toBe(
      true
    )
  })
})
