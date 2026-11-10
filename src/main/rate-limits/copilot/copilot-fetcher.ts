import type { ProviderRateLimits } from '../../../shared/rate-limit-types'
import { extractExecError, parseRetryAfterMs } from '../../git/exec-error'
import { isGhPrimaryRateLimitStderr } from '../../git/gh-rate-limit-breaker'
import { ghExecFileAsync } from '../../git/command-runner/gh-exec-file'
import { isHostCommandMissing } from '../../git/command-runner/github-cli-host-fallback'
import { capUsageRetryAfterMs } from '../providers/usage-retry-after'
import {
  buildCopilotEntitlementSnapshot,
  buildCopilotSnapshot,
  buildCopilotTotals,
  findCopilotAiCreditBudget,
  makeCopilotError,
  makeCopilotUnavailable,
  sumCopilotUsage,
  type CopilotBudget
} from './copilot-fetcher-data'

/**
 * Reads the enterprise's monthly Copilot AI-credit budget and the credits consumed so
 * far this month. Two endpoints are needed because GitHub keeps the ceiling on the
 * budget and the consumption on the usage report.
 *
 * Why through `gh` rather than `net.fetch`: every authenticated GitHub call in Orca
 * goes through the CLI, and going direct would be the only exception — losing GitHub
 * Enterprise Server host resolution and bypassing the gh rate-limit breaker. It also
 * means this provider never holds a token of its own: an explicit credential is only
 * ever passed to gh as `GH_TOKEN`.
 */
// Why: these billing endpoints are version-gated; earlier versions do not expose them.
const GITHUB_API_VERSION = '2026-03-10'
const HTTP_STATUS_IN_GH_ERROR = /\(HTTP (\d{3})\)/
// Why: GitHub reports a secondary rate limit as 403 with this text, and 429 for the same thing.
const GH_SECONDARY_RATE_LIMIT = /secondary rate limit/i
// Why bounded: an enterprise holds few budgets, so this only covers a pathological
// list rather than paging forever inside a poll cycle.
const MAX_BUDGET_PAGES = 5

export type FetchCopilotRateLimitsOptions = {
  /** Explicit credential from Settings, passed to gh as `GH_TOKEN`. Blank uses gh's own sign-in. */
  token: string
  enterpriseSlug: string
  source?: 'enterprise-billing' | 'user-entitlement'
  signal?: AbortSignal
}

type GhApiResult =
  | { status: 'ok'; payload: unknown }
  | { status: 'http-error'; httpStatus: number }
  | { status: 'rate-limited'; retryAtMs?: number }
  | { status: 'parse-error' }
  | { status: 'cli-missing' }
  | { status: 'cli-error'; message: string }
  | { status: 'aborted' }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** The breaker's own error never reached the API, so its text carries no `(HTTP nnn)`. */
function isGhRateLimitFailure(error: unknown, stderr: string): boolean {
  return (
    (typeof error === 'object' && error !== null && 'ghRateLimitBlocked' in error) ||
    isGhPrimaryRateLimitStderr(stderr) ||
    GH_SECONDARY_RATE_LIMIT.test(stderr)
  )
}

/** gh prints response headers only with `-i`, so the breaker's own wait is often the only one known. */
function rateLimitedResult(error: unknown, stderr: string): GhApiResult {
  const now = Date.now()
  const breakerRetryAtMs =
    typeof error === 'object' && error !== null && 'retryAtMs' in error
      ? error.retryAtMs
      : undefined
  const remainingMs =
    typeof breakerRetryAtMs === 'number' && breakerRetryAtMs > now
      ? breakerRetryAtMs - now
      : parseRetryAfterMs(stderr)
  // Why capped: a corrupt wait from either source must not gate the provider indefinitely.
  const cappedMs = capUsageRetryAfterMs(remainingMs)
  return { status: 'rate-limited', ...(cappedMs === null ? {} : { retryAtMs: now + cappedMs }) }
}

async function ghApiJson(path: string, token: string, signal?: AbortSignal): Promise<GhApiResult> {
  try {
    const { stdout } = await ghExecFileAsync(
      ['api', path, '-H', `X-GitHub-Api-Version: ${GITHUB_API_VERSION}`],
      {
        ...(token ? { env: { ...process.env, GH_TOKEN: token } } : {}),
        ...(signal ? { signal } : {})
      }
    )
    try {
      return { status: 'ok', payload: JSON.parse(stdout) }
    } catch {
      return { status: 'parse-error' }
    }
  } catch (error) {
    if (isHostCommandMissing(error, 'gh')) {
      return { status: 'cli-missing' }
    }
    // Why: an aborted cycle is not a GitHub failure, and its text must not be shown as one.
    if (signal?.aborted) {
      return { status: 'aborted' }
    }
    // gh reports the API status inside its error text, e.g. "gh: Not Found (HTTP 404)".
    const { stderr } = extractExecError(error)
    // Why before the status: a primary limit is a 403, which would otherwise read as a scope problem.
    if (isGhRateLimitFailure(error, stderr)) {
      return rateLimitedResult(error, stderr)
    }
    const statusMatch = HTTP_STATUS_IN_GH_ERROR.exec(stderr)
    if (statusMatch?.[1] === '429') {
      return rateLimitedResult(error, stderr)
    }
    return statusMatch
      ? { status: 'http-error', httpStatus: Number(statusMatch[1]) }
      : { status: 'cli-error', message: stderr.trim() }
  }
}

/**
 * Maps a gh failure onto the shared failure vocabulary so the renderer's existing error
 * copy explains the cause instead of showing a bare "Usage unavailable".
 */
function makeCopilotFailure(
  what: string,
  failure: GhApiResult,
  source: FetchCopilotRateLimitsOptions['source'] = 'enterprise-billing'
): ProviderRateLimits {
  if (failure.status === 'ok') {
    // Unreachable: callers only route failures here.
    return makeCopilotError(`Unexpected success while reading ${what}`)
  }
  if (failure.status === 'cli-error') {
    return makeCopilotError(`Could not read ${what} through the GitHub CLI: ${failure.message}`)
  }
  if (failure.status === 'parse-error') {
    return makeCopilotError(`GitHub returned unreadable JSON for ${what}`, 'parse')
  }
  if (failure.status === 'cli-missing') {
    return makeCopilotError(
      `Reading ${what} needs the GitHub CLI — install gh and run gh auth login`,
      'cli-unavailable'
    )
  }
  if (failure.status === 'aborted') {
    return makeCopilotError(`Reading ${what} was cancelled`, 'network')
  }
  if (failure.status === 'rate-limited') {
    return makeCopilotError(
      'GitHub is rate limiting Copilot usage reads right now',
      'rate-limited',
      failure.retryAtMs
    )
  }
  if (failure.httpStatus === 401) {
    return makeCopilotError(`GitHub rejected the token while reading ${what}`, 'stale-token')
  }
  if (failure.httpStatus === 403) {
    return makeCopilotError(
      source === 'user-entitlement'
        ? `The token cannot read ${what} — refresh the GitHub CLI with the user scope`
        : `The token cannot read ${what} — it needs the enterprise billing permissions`,
      'missing-scope'
    )
  }
  if (failure.httpStatus === 404) {
    return makeCopilotError(
      source === 'user-entitlement'
        ? 'GitHub did not expose a Copilot entitlement for this account'
        : `GitHub did not find ${what} — check the enterprise slug, that the token can see the enterprise, and that the enhanced billing platform is enabled`,
      'usage-unavailable'
    )
  }
  if (failure.httpStatus >= 500) {
    return makeCopilotError(`GitHub server error while reading ${what}`, 'server')
  }
  return makeCopilotError(`GitHub returned ${failure.httpStatus} for ${what}`)
}

async function fetchCopilotUserEntitlement(
  token: string,
  signal?: AbortSignal
): Promise<ProviderRateLimits> {
  const result = await ghApiJson('/copilot_internal/user', token, signal)
  if (result.status !== 'ok') {
    return makeCopilotFailure('your Copilot entitlement', result, 'user-entitlement')
  }
  const snapshot = buildCopilotEntitlementSnapshot(result.payload)
  return (
    snapshot ??
    makeCopilotError('GitHub returned no usable premium-interaction entitlement', 'parse')
  )
}

function budgetEntries(payload: unknown): CopilotBudget[] {
  if (!isRecord(payload) || !Array.isArray(payload.budgets)) {
    return []
  }
  return payload.budgets.filter(isRecord)
}

function usageItems(payload: unknown): Record<string, unknown>[] {
  if (!isRecord(payload) || !Array.isArray(payload.usageItems)) {
    return []
  }
  return payload.usageItems.filter(isRecord)
}

async function findAiCreditBudget(
  enterpriseSlug: string,
  token: string,
  signal?: AbortSignal
): Promise<ProviderRateLimits | { budget: CopilotBudget }> {
  const collected: CopilotBudget[] = []
  for (let page = 1; page <= MAX_BUDGET_PAGES; page += 1) {
    const result = await ghApiJson(
      `/enterprises/${encodeURIComponent(enterpriseSlug)}/settings/billing/budgets?per_page=100&page=${page}`,
      token,
      signal
    )
    if (result.status !== 'ok') {
      return makeCopilotFailure('the AI-credit budget', result)
    }
    collected.push(...budgetEntries(result.payload))
    if (!(isRecord(result.payload) && result.payload.has_next_page === true)) {
      break
    }
  }
  const budget = findCopilotAiCreditBudget(collected)
  if (!budget) {
    return makeCopilotError(
      `No AI-credit budget is configured for enterprise ${enterpriseSlug}`,
      'usage-unavailable'
    )
  }
  return { budget }
}

export async function fetchCopilotRateLimits(
  options: FetchCopilotRateLimitsOptions
): Promise<ProviderRateLimits> {
  try {
    const token = options.token?.trim() ?? ''
    const enterpriseSlug = options.enterpriseSlug?.trim() ?? ''
    if (options.source === 'user-entitlement') {
      return await fetchCopilotUserEntitlement(token, options.signal)
    }
    if (!token && !enterpriseSlug) {
      return makeCopilotUnavailable(
        'GitHub Copilot credentials not configured — sign in with the GitHub CLI or add a token'
      )
    }
    if (!enterpriseSlug) {
      return makeCopilotUnavailable('No GitHub enterprise selected for Copilot usage')
    }

    const budgetResult = await findAiCreditBudget(enterpriseSlug, token, options.signal)
    if ('provider' in budgetResult) {
      return budgetResult
    }
    const budgetAmount = budgetResult.budget.budget_amount
    const budgetAmountDollars =
      typeof budgetAmount === 'number' ? budgetAmount : Number(budgetAmount)
    if (!Number.isFinite(budgetAmountDollars) || budgetAmountDollars <= 0) {
      return makeCopilotError('The AI-credit budget has no usable amount', 'parse')
    }

    const now = new Date()
    const usage = await ghApiJson(
      `/enterprises/${encodeURIComponent(enterpriseSlug)}/settings/billing/ai_credit/usage?year=${now.getUTCFullYear()}&month=${now.getUTCMonth() + 1}`,
      token,
      options.signal
    )
    if (usage.status !== 'ok') {
      return makeCopilotFailure('this month’s AI-credit usage', usage)
    }

    const totals = buildCopilotTotals(
      budgetAmountDollars,
      sumCopilotUsage(usageItems(usage.payload))
    )
    return buildCopilotSnapshot(totals)
  } catch (error) {
    return makeCopilotError(error instanceof Error ? error.message : String(error), 'unknown')
  }
}
