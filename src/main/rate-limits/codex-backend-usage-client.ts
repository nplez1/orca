import type { ProviderAllowance } from '../../shared/provider-allowance'
import type { ProviderRateLimits, RateLimitWindow } from '../../shared/rate-limit-types'
import { cancelUnreadResponseBody } from '../lib/unread-response-body'
import {
  classifyCodexRateLimitWindows,
  CODEX_SESSION_WINDOW_MINUTES,
  CODEX_WEEKLY_WINDOW_MINUTES,
  type CodexRateWindowSnapshot
} from './codex-rate-limit-window-classification'
import {
  createCodexBackendRequestSignal,
  getCodexBackendAuthHeaders,
  type CodexBackendRequest
} from './codex-backend-auth'
import type { CodexRateLimitFetchOptions } from './codex-rate-limit-fetch-options'
import { mapCodexRateLimitWindow } from './codex-rate-limit-window-mapper'
import { mapBackendRateLimitResetCredits } from './codex-reset-credit-client'

type BackendRateLimitWindow = {
  used_percent?: number
  limit_window_seconds?: number
  reset_at?: number
}

type BackendUsageResponse = {
  plan_type?: string
  rate_limit?: {
    primary_window?: BackendRateLimitWindow | null
    secondary_window?: BackendRateLimitWindow | null
  } | null
  rate_limit_reset_credits?: Parameters<typeof mapBackendRateLimitResetCredits>[0]
  spend_control?: BackendSpendControl | null
}

/**
 * Present on business/enterprise plans in place of a rate-limit window. Amounts arrive
 * as decimal strings and `unit` is the provider's own denomination, e.g. `credit`.
 */
type BackendSpendControl = {
  individual_limit?: {
    limit?: unknown
    used?: unknown
    used_percent?: unknown
    remaining_percent?: unknown
    reset_at?: unknown
    unit?: unknown
  } | null
  reached?: unknown
}

// Why: 30 days, matching the window length the other monthly providers report. The reset
// observed on a real spend control lands on the first of the month.
const CODEX_MONTHLY_WINDOW_MINUTES = 43_200
// Why: the backend reports `reset_at` in Unix seconds while Orca stores Unix ms; seconds
// are ~1.7e9 and ms ~1.7e12, so this boundary is unambiguous.
const UNIX_SECONDS_MAX = 1e11

function readFiniteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/** Why: spend-control amounts arrive as decimal strings such as "10048.956130862236". */
function readDecimalAmount(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null
  }
  if (typeof value !== 'string' || value.trim() === '') {
    return null
  }
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function readResetAtMs(value: unknown): number | null {
  const raw = readFiniteNumber(value)
  if (raw === null || raw <= 0) {
    return null
  }
  return raw < UNIX_SECONDS_MAX ? raw * 1000 : raw
}

/**
 * The monthly allowance a plan reports when it has no 5-hour or 7-day window.
 *
 * Why `used_percent` leads: the backend supplies its own percentage, so Orca never
 * derives one from the amounts and cannot disagree with the provider's own figure.
 */
function mapCodexSpendControl(payload: BackendUsageResponse): {
  monthly: RateLimitWindow | null
  allowance: ProviderAllowance | null
} {
  const individual = payload.spend_control?.individual_limit
  if (!individual) {
    return { monthly: null, allowance: null }
  }
  const remainingPercent = readFiniteNumber(individual.remaining_percent)
  const percent =
    readFiniteNumber(individual.used_percent) ??
    (remainingPercent === null ? null : 100 - remainingPercent)
  const limit = readDecimalAmount(individual.limit)
  const used = readDecimalAmount(individual.used)
  const unit =
    typeof individual.unit === 'string' && individual.unit.trim() !== ''
      ? individual.unit.trim()
      : 'credits'
  const resetsAt = readResetAtMs(individual.reset_at)

  return {
    monthly:
      percent === null
        ? null
        : {
            usedPercent: Math.min(100, Math.max(0, percent)),
            windowMinutes: CODEX_MONTHLY_WINDOW_MINUTES,
            resetsAt,
            resetDescription: null
          },
    allowance:
      limit === null || used === null
        ? null
        : { unit: { kind: 'count', label: unit }, used, limit, resetsAt }
  }
}

function backendWindowToSnapshot(
  raw: BackendRateLimitWindow | null | undefined
): CodexRateWindowSnapshot | null {
  if (!raw) {
    return null
  }
  const limitWindowSeconds = raw.limit_window_seconds
  const windowDurationMins =
    typeof limitWindowSeconds === 'number' &&
    Number.isFinite(limitWindowSeconds) &&
    limitWindowSeconds > 0
      ? Math.ceil(limitWindowSeconds / 60)
      : undefined
  return { usedPercent: raw.used_percent, windowDurationMins, resetsAt: raw.reset_at }
}

function snapshotWindowMinutes(
  snapshot: CodexRateWindowSnapshot | null,
  fallbackWindowMinutes: number
): number {
  const duration = snapshot?.windowDurationMins
  return typeof duration === 'number' && Number.isFinite(duration) && duration > 0
    ? duration
    : fallbackWindowMinutes
}

export async function fetchCodexRateLimitsViaBackend(
  request: CodexBackendRequest,
  options?: CodexRateLimitFetchOptions
): Promise<ProviderRateLimits | null> {
  const signal = createCodexBackendRequestSignal(options?.signal)
  const headers = await getCodexBackendAuthHeaders(options, signal)
  if (!headers || signal.aborted) {
    return null
  }
  const response = await request('https://chatgpt.com/backend-api/wham/usage', { headers, signal })
  if (!response.ok) {
    await cancelUnreadResponseBody(response)
    return null
  }
  const payload = (await response.json()) as BackendUsageResponse
  if (typeof payload.plan_type !== 'string') {
    return null
  }
  const classified = classifyCodexRateLimitWindows({
    primary: backendWindowToSnapshot(payload.rate_limit?.primary_window),
    secondary: backendWindowToSnapshot(payload.rate_limit?.secondary_window)
  })
  const session = mapCodexRateLimitWindow(
    classified.session,
    snapshotWindowMinutes(classified.session, CODEX_SESSION_WINDOW_MINUTES)
  )
  const weekly = mapCodexRateLimitWindow(
    classified.weekly,
    snapshotWindowMinutes(classified.weekly, CODEX_WEEKLY_WINDOW_MINUTES)
  )
  // Why: only for plans reporting no subscription window at all — a business/enterprise
  // account. A normal ChatGPT plan keeps its 5h/7d bars and must not grow a monthly one.
  const spend =
    session || weekly ? { monthly: null, allowance: null } : mapCodexSpendControl(payload)
  return {
    provider: 'codex',
    session,
    weekly,
    ...(spend.monthly ? { monthly: spend.monthly } : {}),
    ...(spend.allowance ? { allowance: spend.allowance } : {}),
    planType: payload.plan_type,
    ...(payload.rate_limit_reset_credits !== undefined
      ? {
          rateLimitResetCredits:
            mapBackendRateLimitResetCredits(payload.rate_limit_reset_credits) ?? null
        }
      : {}),
    updatedAt: Date.now(),
    error: null,
    status: 'ok'
  }
}

export async function supplementCodexSessionWindow(
  limits: ProviderRateLimits,
  request: CodexBackendRequest,
  options?: CodexRateLimitFetchOptions
): Promise<ProviderRateLimits> {
  // Why: run whenever the RPC produced no session window. That keeps the original
  // weekly-only plan case and adds the windowless enterprise case, whose allowance and
  // planType exist only in the backend payload.
  if (options?.signal?.aborted || limits.session) {
    return limits
  }
  try {
    const backend = await fetchCodexRateLimitsViaBackend(request, options)
    if (!backend) {
      return limits
    }
    const rateLimitResetCredits = backend.rateLimitResetCredits ?? limits.rateLimitResetCredits
    // Why: no session window means the backend is not authoritative for this plan's
    // windows — keep the local weekly (the backend can report a different bucket) and
    // adopt only what the local snapshot lacks, which is the enterprise allowance and
    // its plan. Returning `limits` unchanged when there is nothing to add preserves the
    // previous no-op behaviour.
    if (!backend.session) {
      const adoptsPlan = backend.planType !== undefined && backend.planType !== limits.planType
      const adoptsCredits = rateLimitResetCredits !== limits.rateLimitResetCredits
      if (!backend.monthly && !backend.allowance && !adoptsPlan && !adoptsCredits) {
        return limits
      }
      return {
        ...limits,
        ...(backend.monthly ? { monthly: backend.monthly } : {}),
        ...(backend.allowance ? { allowance: backend.allowance } : {}),
        planType: backend.planType ?? limits.planType,
        ...(rateLimitResetCredits !== undefined ? { rateLimitResetCredits } : {}),
        updatedAt: backend.updatedAt
      }
    }
    return {
      ...limits,
      session: backend.session,
      // Why: here the backend is authoritative for windows, so its weekly wins — it
      // carries a fresher resetsAt than the local snapshot.
      weekly: backend.weekly ?? limits.weekly,
      planType: backend.planType ?? limits.planType,
      ...(backend.monthly ? { monthly: backend.monthly } : {}),
      ...(backend.allowance ? { allowance: backend.allowance } : {}),
      ...(rateLimitResetCredits !== undefined ? { rateLimitResetCredits } : {}),
      updatedAt: backend.updatedAt
    }
  } catch {
    return limits
  }
}
