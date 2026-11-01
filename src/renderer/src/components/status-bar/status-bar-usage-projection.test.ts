import { describe, expect, it } from 'vitest'
import type { ProviderRateLimits, RateLimitState } from '../../../../shared/rate-limit-types'
import {
  getStatusBarUsageProjection,
  type StatusBarUsageProjectionInputs
} from './status-bar-usage-projection'

function snapshot(provider: ProviderRateLimits['provider']): ProviderRateLimits {
  return {
    provider,
    status: 'ok',
    updatedAt: 1_700_000_000_000,
    error: null,
    session: { usedPercent: 12, windowMinutes: 300, resetsAt: null, resetDescription: null },
    weekly: null
  }
}

/**
 * Configured but nothing fetched yet: the case the durable setup flags exist for. `isProviderConfigured`
 * already counts `ok` and bare `idle` snapshots as visible, so `fetching`-with-no-data is the state
 * `antigravityUsageConfigured` actually decides.
 */
function pendingSnapshot(provider: ProviderRateLimits['provider']): ProviderRateLimits {
  return {
    provider,
    status: 'fetching',
    updatedAt: 1_700_000_000_000,
    error: null,
    session: null,
    weekly: null
  }
}

function emptyRateLimits(): RateLimitState {
  return {
    claude: null,
    codex: null,
    gemini: null,
    opencodeGo: null,
    kimi: null,
    antigravity: null,
    minimax: null,
    grok: null,
    cursor: null,
    zcode: null,
    deepseek: null,
    fireworks: null,
    deepinfra: null,
    copilot: null,
    minimaxCookieConfigured: false,
    minimaxApiKeyConfigured: false,
    opencodeGoApiKeyConfigured: false,
    deepseekApiKeyConfigured: false,
    fireworksApiKeyConfigured: false,
    deepinfraApiKeyConfigured: false,
    copilotTokenConfigured: false,
    grokAuthConfigured: false,
    zcodePlanApiKeyConfigured: false,
    cursorAuthConfigured: false,
    claudeTarget: { runtime: 'host', wslDistro: null },
    codexTarget: { runtime: 'host', wslDistro: null },
    inactiveClaudeAccounts: [],
    inactiveCodexAccounts: []
  }
}

type ProjectArgs = Pick<
  StatusBarUsageProjectionInputs,
  'rateLimits' | 'statusBarItems' | 'detectedAgentIds'
> & { remoteOwned: boolean }

function project(args: ProjectArgs) {
  return getStatusBarUsageProjection({
    rateLimits: args.rateLimits,
    settings: null,
    remoteOwned: args.remoteOwned,
    statusBarItems: args.statusBarItems,
    detectedAgentIds: args.detectedAgentIds,
    usageEmptyStateDismissed: false
  })
}

// Why these cases: both flags this covers were silently dropped while the fork's projection was
// carried forward over two upstream refactors, and neither had a test to notice.
describe('getStatusBarUsageProjection', () => {
  it('does not let a remote owner borrow this machine’s Antigravity detection', () => {
    // Why a pending snapshot: that is the only case `antigravityUsageConfigured` decides — a
    // fetched snapshot is visible on its own merits, which is why this guard is easy to lose.
    const rateLimits = { ...emptyRateLimits(), antigravity: pendingSnapshot('antigravity') }
    const args: ProjectArgs = {
      rateLimits,
      statusBarItems: ['antigravity'],
      // A remote owner is passed no local detection at all, and null reads as "available".
      detectedAgentIds: null,
      remoteOwned: true
    }

    expect(project(args).hasVisibleUsageMeters).toBe(false)
    expect(project({ ...args, remoteOwned: false }).hasVisibleUsageMeters).toBe(true)
  })

  it('shows the ZCode meter from a saved plan key when no ZCode CLI is on PATH', () => {
    const rateLimits = {
      ...emptyRateLimits(),
      zcode: snapshot('zcode'),
      zcodePlanApiKeyConfigured: true
    }
    const args: ProjectArgs = {
      rateLimits,
      statusBarItems: ['zcode'],
      detectedAgentIds: [],
      remoteOwned: false
    }

    expect(project(args).hasVisibleUsageMeters).toBe(true)
    expect(
      project({
        ...args,
        rateLimits: { ...rateLimits, zcodePlanApiKeyConfigured: false }
      }).hasVisibleUsageMeters
    ).toBe(false)
  })
})
