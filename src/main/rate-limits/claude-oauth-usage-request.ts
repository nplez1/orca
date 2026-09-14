import { net, session } from 'electron'
import type { ProviderAllowance } from '../../shared/provider-allowance'
import type { ProviderRateLimits, RateLimitWindow } from '../../shared/rate-limit-types'
import { ensureElectronProxyFromEnvironment } from '../network/proxy-settings'
import { createOAuthUsageError } from './claude-oauth-usage-error'
import { mapClaudeUsageWindow, type ClaudeUsageWindowInput } from './claude-usage-window'
import { abortedClaudeRateLimitResult } from './claude-usage-result'

const OAUTH_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage'
const API_TIMEOUT_MS = 10_000

type OAuthUsageLimit = {
  kind?: string
  percent?: number
  resets_at?: string | number
  is_active?: boolean
  scope?: { model?: { display_name?: string } | null } | null
}

type OAuthUsageResponse = {
  five_hour?: ClaudeUsageWindowInput
  seven_day?: ClaudeUsageWindowInput
  fable_weekly?: ClaudeUsageWindowInput
  fable_seven_day?: ClaudeUsageWindowInput
  seven_day_fable?: ClaudeUsageWindowInput
  limits?: OAuthUsageLimit[] | null
  spend?: OAuthSpend | null
  extra_usage?: OAuthExtraUsage | null
}

/** Money as an integer count of 10^-`exponent` units, e.g. 800000 + 2 is $8,000.00. */
type OAuthSpendMoney = {
  amount_minor?: unknown
  currency?: unknown
  exponent?: unknown
}

/** The monthly spend cap an enterprise/usage-billed plan reports instead of windows. */
type OAuthSpend = {
  enabled?: unknown
  percent?: unknown
  used?: OAuthSpendMoney | null
  limit?: OAuthSpendMoney | null
}

/** Repeats the spend cap figures as credits; the fallback source when `spend` is absent. */
type OAuthExtraUsage = {
  is_enabled?: unknown
  currency?: unknown
  decimal_places?: unknown
  monthly_limit?: unknown
  used_credits?: unknown
  utilization?: unknown
}

// Why: 30 days, matching the window length the other monthly providers report.
const CLAUDE_MONTHLY_WINDOW_MINUTES = 43_200

function readFiniteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function readMinorUnits(value: unknown, exponent: number | null): number | null {
  const minor = readFiniteNumber(value)
  if (minor === null || exponent === null || !Number.isInteger(exponent) || exponent < 0) {
    return null
  }
  return minor / 10 ** exponent
}

function readSpendAmount(raw: OAuthSpendMoney | null | undefined): number | null {
  return readMinorUnits(raw?.amount_minor, readFiniteNumber(raw?.exponent))
}

function readSpendCurrency(data: OAuthUsageResponse): string | null {
  const candidates = [
    data.spend?.limit?.currency,
    data.spend?.used?.currency,
    data.extra_usage?.currency
  ]
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim() !== '') {
      return candidate.trim()
    }
  }
  return null
}

/**
 * The monthly allowance a plan reports when it has no 5-hour or 7-day window.
 *
 * Why the `spend` object leads: it carries the dollar figures and the provider's own
 * rounded `percent`, which is what their console shows, so Orca does not disagree with
 * it by a rounding step. `extra_usage` repeats the same numbers as credits and is the
 * fallback. No reset time is reported for this cap, so `resetsAt` stays null rather
 * than inferring the first of the month.
 */
function mapClaudeMonthlyAllowance(data: OAuthUsageResponse): {
  monthly: RateLimitWindow | null
  allowance: ProviderAllowance | null
} {
  const percent =
    readFiniteNumber(data.spend?.percent) ?? readFiniteNumber(data.extra_usage?.utilization)

  const spendUsed = readSpendAmount(data.spend?.used)
  const spendLimit = readSpendAmount(data.spend?.limit)
  const extraExponent = readFiniteNumber(data.extra_usage?.decimal_places)
  const extraUsed = readMinorUnits(data.extra_usage?.used_credits, extraExponent)
  const extraLimit = readMinorUnits(data.extra_usage?.monthly_limit, extraExponent)

  const used = spendUsed ?? extraUsed
  const limit = spendLimit ?? extraLimit
  const currencyCode = readSpendCurrency(data)

  const monthly =
    percent === null
      ? null
      : {
          usedPercent: Math.min(100, Math.max(0, percent)),
          windowMinutes: CLAUDE_MONTHLY_WINDOW_MINUTES,
          resetsAt: null,
          resetDescription: null
        }

  const allowance =
    used === null || limit === null
      ? null
      : {
          // Why: a missing currency still denotes credits, which need no symbol.
          unit: currencyCode
            ? ({ kind: 'money', currencyCode } as const)
            : ({ kind: 'count', label: 'credits' } as const),
          used,
          limit,
          resetsAt: null
        }

  return { monthly, allowance }
}

async function ensureProxyFromEnvironment(): Promise<void> {
  await ensureElectronProxyFromEnvironment({
    proxySession: session.defaultSession,
    probeUrl: OAUTH_USAGE_URL
  }).catch(() => {})
}

function mapFableWeeklyWindow(data: OAuthUsageResponse): RateLimitWindow | null {
  const scoped = Array.isArray(data.limits)
    ? data.limits.find(
        (limit) =>
          limit?.kind === 'weekly_scoped' &&
          Number.isFinite(limit.percent) &&
          limit.scope?.model?.display_name?.trim().toLowerCase() === 'fable'
      )
    : undefined
  return (
    mapClaudeUsageWindow(
      scoped ? { used_percentage: scoped.percent, resets_at: scoped.resets_at } : undefined,
      10080
    ) ??
    mapClaudeUsageWindow(data.fable_weekly, 10080) ??
    mapClaudeUsageWindow(data.fable_seven_day, 10080) ??
    mapClaudeUsageWindow(data.seven_day_fable, 10080)
  )
}

export async function fetchClaudeOAuthUsage(
  token: string,
  signal?: AbortSignal
): Promise<ProviderRateLimits> {
  if (signal?.aborted) {
    return abortedClaudeRateLimitResult()
  }
  await ensureProxyFromEnvironment()
  if (signal?.aborted) {
    return abortedClaudeRateLimitResult()
  }

  const requestSignal = signal
    ? AbortSignal.any([signal, AbortSignal.timeout(API_TIMEOUT_MS)])
    : AbortSignal.timeout(API_TIMEOUT_MS)

  try {
    const response = await net.fetch(OAUTH_USAGE_URL, {
      headers: {
        Authorization: `Bearer ${token}`,
        'anthropic-beta': 'oauth-2025-04-20',
        'User-Agent': 'claude-code/2.1.0'
      },
      signal: requestSignal
    })
    if (!response.ok) {
      throw await createOAuthUsageError(response)
    }

    const data = (await response.json()) as OAuthUsageResponse
    if (signal?.aborted) {
      return abortedClaudeRateLimitResult()
    }
    const session = mapClaudeUsageWindow(data.five_hour, 300)
    const weekly = mapClaudeUsageWindow(data.seven_day, 10080)
    // Why: only for plans reporting no subscription window at all — an enterprise or
    // usage-billed account. A Pro account with extra usage credits switched on keeps
    // its 5h/7d bars and must not grow a spurious monthly one beside them.
    const monthly =
      session || weekly ? { monthly: null, allowance: null } : mapClaudeMonthlyAllowance(data)
    return {
      provider: 'claude',
      session,
      weekly,
      fableWeekly: mapFableWeeklyWindow(data),
      ...(monthly.monthly ? { monthly: monthly.monthly } : {}),
      ...(monthly.allowance ? { allowance: monthly.allowance } : {}),
      updatedAt: Date.now(),
      error: null,
      status: 'ok'
    }
  } catch (error) {
    if (signal?.aborted) {
      return abortedClaudeRateLimitResult()
    }
    throw error
  }
}
