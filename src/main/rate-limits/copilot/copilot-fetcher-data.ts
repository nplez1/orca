import type { ProviderAllowance } from '../../../shared/provider-allowance'
import type { ProviderRateLimits, RateLimitWindow } from '../../../shared/rate-limit-types'

/**
 * Shape of GitHub's per-user Copilot entitlement.
 *
 * Documented at: GET /copilot_internal/user. Copilot reports a monthly premium-interaction
 * entitlement rather than 5-hour and weekly quota windows, so the numbers are credits
 * against an entitlement with a reset date — not windows the provider tracks itself.
 */

// Why: 30 days, matching the window length the other monthly providers report.
export const COPILOT_MONTHLY_WINDOW_MINUTES = 43_200

export function makeCopilotError(
  error: string,
  failureKind: NonNullable<ProviderRateLimits['usageMetadata']>['failureKind'] = 'usage-unavailable'
): ProviderRateLimits {
  return {
    provider: 'copilot',
    session: null,
    weekly: null,
    updatedAt: Date.now(),
    error,
    status: 'error',
    usageMetadata: { failureKind, source: 'web' }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function readFiniteNumber(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null
  }
  // Why: GitHub returns some billing integers as strings.
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

/**
 * Why inferable here, unlike Claude's spend cap: GitHub documents the entitlement as
 * monthly, so when the payload omits a reset date the period the displayed figure covers
 * ends at the next month boundary.
 */
export function readNextMonthStartUtc(now: number = Date.now()): number {
  const current = new Date(now)
  return Date.UTC(current.getUTCFullYear(), current.getUTCMonth() + 1, 1)
}

export function buildCopilotSnapshot(totals: {
  allowance: ProviderAllowance
  window: RateLimitWindow
}): ProviderRateLimits {
  return {
    provider: 'copilot',
    session: null,
    weekly: null,
    monthly: totals.window,
    allowance: totals.allowance,
    updatedAt: Date.now(),
    error: null,
    status: 'ok',
    usageMetadata: { source: 'web' }
  }
}

export function buildCopilotEntitlementSnapshot(payload: unknown): ProviderRateLimits | null {
  if (!isRecord(payload) || !isRecord(payload.quota_snapshots)) {
    return null
  }
  const quota = payload.quota_snapshots.premium_interactions
  if (!isRecord(quota)) {
    return null
  }
  const used = readFiniteNumber(quota.credits_used)
  const limit = readFiniteNumber(quota.entitlement)
  if (used === null || limit === null || limit <= 0) {
    return null
  }
  const parsedReset =
    typeof payload.quota_reset_date_utc === 'string'
      ? Date.parse(payload.quota_reset_date_utc)
      : Number.NaN
  const resetsAt = Number.isFinite(parsedReset) ? parsedReset : readNextMonthStartUtc()
  return buildCopilotSnapshot({
    allowance: {
      unit: { kind: 'count', label: 'AI credits' },
      used,
      limit,
      resetsAt
    },
    window: {
      usedPercent: Math.min(100, Math.max(0, (used / limit) * 100)),
      windowMinutes: COPILOT_MONTHLY_WINDOW_MINUTES,
      resetsAt,
      resetDescription: null
    }
  })
}
