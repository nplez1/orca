import type { ProviderRateLimits, RateLimitWindow } from '../../../shared/rate-limit-types'
import type { ClaudeOAuthExtraUsage, ClaudeOAuthSpend } from '../claude-usage-credits'
import { mapClaudeExtraUsage, mapClaudeSpendLimitWindow } from '../claude-usage-credits'
import { mapClaudeUsageWindow, type ClaudeUsageWindowInput } from '../claude-usage-window'

const SESSION_WINDOW_MINUTES = 300
const WEEKLY_WINDOW_MINUTES = 10_080
const FABLE_MODEL_NAME = 'fable'

/**
 * The CLI's own report of its plan windows, published as `rate_limit_event.rate_limit_info`.
 *
 * `utilization` is a 0–1 **fraction** here, unlike the usage endpoint's 0–100 `utilization` — hence
 * the multiply in `cliWindowInput`. `resetsAt` is epoch seconds. Both windows live under
 * `unifiedWindows`; a reply that omits it (an older CLI) reports only the representative window it
 * last hit.
 */
type CliUnifiedWindow = {
  utilization?: number
  resetsAt?: number | string
  status?: string
}

type CliRateLimitInfo = {
  status?: string
  resetsAt?: number | string
  rateLimitType?: string
  unifiedWindows?: {
    five_hour?: CliUnifiedWindow | null
    seven_day?: CliUnifiedWindow | null
  } | null
}

function cliWindowInput(window: CliUnifiedWindow | null | undefined): ClaudeUsageWindowInput {
  return {
    utilization: typeof window?.utilization === 'number' ? window.utilization * 100 : undefined,
    resets_at: window?.resetsAt
  }
}

/**
 * Map the CLI's `rate_limit_event` onto the provider snapshot the status bar renders.
 *
 * Null means the event carries no plan window — an API-key or Bedrock/Vertex account, or a CLI that
 * reports only a status. The reading is the CLI's own, so it needs no endpoint and no token from Orca.
 */
export function mapClaudeCliRateLimitInfo(info: unknown): ProviderRateLimits | null {
  const root = record(info)
  if (!root) {
    return null
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the CLI's own event shape; every field below is re-checked by the mappers.
  const rateLimitInfo = root as CliRateLimitInfo
  const unified = rateLimitInfo.unifiedWindows
  const session = mapClaudeUsageWindow(cliWindowInput(unified?.five_hour), SESSION_WINDOW_MINUTES)
  const weekly = mapClaudeUsageWindow(cliWindowInput(unified?.seven_day), WEEKLY_WINDOW_MINUTES)
  if (!session && !weekly) {
    return null
  }
  return {
    provider: 'claude',
    session,
    weekly,
    fableWeekly: null,
    updatedAt: Date.now(),
    error: null,
    status: 'ok',
    usageMetadata: { source: 'cli', attemptedSources: ['cli'] }
  }
}

type CliScopedLimit = {
  kind?: string
  percent?: number
  resets_at?: string | number
  scope?: { model?: { display_name?: string } | null } | null
}

type CliModelScopedWindow = {
  display_name?: string
  utilization?: number
  resets_at?: string | number
}

/** The subset of the CLI's `get_usage` payload this fork reads; it mirrors the usage endpoint. */
type CliRateLimits = {
  five_hour?: ClaudeUsageWindowInput | null
  seven_day?: ClaudeUsageWindowInput | null
  extra_usage?: ClaudeOAuthExtraUsage
  spend?: ClaudeOAuthSpend
  limits?: CliScopedLimit[] | null
  model_scoped?: CliModelScopedWindow[] | null
}

function record(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: parsed JSON; every read below re-checks the field it uses.
  return value as Record<string, unknown>
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function percent(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function timestamp(value: unknown): string | number | undefined {
  return typeof value === 'number' || typeof value === 'string' ? value : undefined
}

// Why: the CLI reports the per-model window twice (server `limits[]` and the SDK's `model_scoped`)
// and older builds report only one, so both are read the way the OAuth reply is.
function mapFableWeeklyWindow(rateLimits: CliRateLimits): RateLimitWindow | null {
  // Why guard: a malformed array must degrade to "no reading", never throw out of the poll.
  for (const limit of Array.isArray(rateLimits.limits) ? rateLimits.limits : []) {
    const model = record(limit?.scope?.model)
    const used = percent(limit?.percent)
    if (
      limit?.kind === 'weekly_scoped' &&
      used !== null &&
      text(model?.display_name)?.toLowerCase() === FABLE_MODEL_NAME
    ) {
      return mapClaudeUsageWindow(
        { utilization: used, resets_at: timestamp(limit.resets_at) },
        WEEKLY_WINDOW_MINUTES
      )
    }
  }
  for (const scoped of Array.isArray(rateLimits.model_scoped) ? rateLimits.model_scoped : []) {
    const used = percent(scoped?.utilization)
    if (used !== null && text(scoped?.display_name)?.toLowerCase() === FABLE_MODEL_NAME) {
      return mapClaudeUsageWindow(
        { utilization: used, resets_at: timestamp(scoped.resets_at) },
        WEEKLY_WINDOW_MINUTES
      )
    }
  }
  return null
}

/**
 * Map the Claude CLI's `get_usage` reply onto the provider snapshot the status bar renders.
 *
 * Null means the reply cannot stand in for a usage read: no plan limits apply (API key, Bedrock,
 * Vertex), or the payload carried no window and no credit balance at all.
 */
export function mapClaudeCliUsageResponse(response: unknown): ProviderRateLimits | null {
  const root = record(response)
  if (!root || root.rate_limits_available !== true) {
    return null
  }
  const raw = record(root.rate_limits)
  if (!raw) {
    return null
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the CLI mirror of the usage endpoint; each mapper below re-checks what it reads.
  const rateLimits = raw as CliRateLimits
  const session = mapClaudeUsageWindow(rateLimits.five_hour ?? undefined, SESSION_WINDOW_MINUTES)
  const weekly = mapClaudeUsageWindow(rateLimits.seven_day ?? undefined, WEEKLY_WINDOW_MINUTES)
  const fableWeekly = mapFableWeeklyWindow(rateLimits)
  const extraUsage = mapClaudeExtraUsage(rateLimits)
  // Why only without plan windows: there, spend is overage after a cap, not the account's limit.
  const monthly = session || weekly ? null : mapClaudeSpendLimitWindow(rateLimits)
  if (!session && !weekly && !fableWeekly && !extraUsage && !monthly) {
    return null
  }
  return {
    provider: 'claude',
    session,
    weekly,
    fableWeekly,
    monthly,
    extraUsage,
    updatedAt: Date.now(),
    error: null,
    status: 'ok',
    usageMetadata: { source: 'cli', attemptedSources: ['cli'] }
  }
}
