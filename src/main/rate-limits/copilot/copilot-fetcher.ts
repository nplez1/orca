import { net } from 'electron'
import type { ProviderRateLimits } from '../../../shared/rate-limit-types'
import {
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
 */
const GITHUB_API_BASE = 'https://api.github.com'
// Why: the billing endpoints are version-gated; earlier versions do not expose them.
const GITHUB_API_VERSION = '2026-03-10'
const REQUEST_TIMEOUT_MS = 10_000
// Why bounded: an enterprise holds few budgets, so this only covers a pathological
// list rather than paging forever inside a poll cycle.
const MAX_BUDGET_PAGES = 5

export type FetchCopilotRateLimitsOptions = {
  token: string
  enterpriseSlug: string
}

type GitHubJsonResult =
  | { status: 'ok'; payload: unknown }
  | { status: 'http-error'; httpStatus: number }
  | { status: 'parse-error' }
  | { status: 'network-error'; message: string }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

async function getGitHubJson(path: string, token: string): Promise<GitHubJsonResult> {
  try {
    const response = await net.fetch(`${GITHUB_API_BASE}${path}`, {
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': GITHUB_API_VERSION
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    })
    if (!response.ok) {
      return { status: 'http-error', httpStatus: response.status }
    }
    try {
      return { status: 'ok', payload: await response.json() }
    } catch {
      return { status: 'parse-error' }
    }
  } catch (error) {
    return {
      status: 'network-error',
      message: error instanceof Error ? error.message : String(error)
    }
  }
}

/**
 * Maps an HTTP status onto the shared failure vocabulary so the renderer's existing
 * error copy explains the cause instead of showing a bare "Usage unavailable".
 */
function makeCopilotHttpError(what: string, failure: GitHubJsonResult): ProviderRateLimits {
  if (failure.status === 'http-error') {
    if (failure.httpStatus === 401) {
      return makeCopilotError(`GitHub rejected the token while reading ${what}`, 'stale-token')
    }
    if (failure.httpStatus === 403) {
      return makeCopilotError(
        `The token cannot read ${what} — it needs the "Enterprise billing" read permission`,
        'missing-scope'
      )
    }
    if (failure.httpStatus === 404) {
      return makeCopilotError(
        `GitHub did not find ${what} — check the enterprise slug, and that the enhanced billing platform is enabled`,
        'usage-unavailable'
      )
    }
    if (failure.httpStatus >= 500) {
      return makeCopilotError(`GitHub server error while reading ${what}`, 'server')
    }
    return makeCopilotError(`GitHub returned ${failure.httpStatus} for ${what}`)
  }
  if (failure.status === 'network-error') {
    return makeCopilotError(`Could not reach GitHub: ${failure.message}`, 'network')
  }
  return makeCopilotError(`GitHub returned unreadable JSON for ${what}`, 'parse')
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
  token: string
): Promise<ProviderRateLimits | { budget: CopilotBudget }> {
  const collected: CopilotBudget[] = []
  for (let page = 1; page <= MAX_BUDGET_PAGES; page += 1) {
    const result = await getGitHubJson(
      `/enterprises/${encodeURIComponent(enterpriseSlug)}/settings/billing/budgets?per_page=100&page=${page}`,
      token
    )
    if (result.status !== 'ok') {
      return makeCopilotHttpError('the AI-credit budget', result)
    }
    collected.push(...budgetEntries(result.payload))
    const hasNextPage = isRecord(result.payload) && result.payload.has_next_page === true
    if (!hasNextPage) {
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
    if (!token || !enterpriseSlug) {
      return makeCopilotUnavailable('GitHub Copilot credentials not configured')
    }

    const budgetResult = await findAiCreditBudget(enterpriseSlug, token)
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
    const usage = await getGitHubJson(
      `/enterprises/${encodeURIComponent(enterpriseSlug)}/settings/billing/ai_credit/usage?year=${now.getUTCFullYear()}&month=${now.getUTCMonth() + 1}`,
      token
    )
    if (usage.status !== 'ok') {
      return makeCopilotHttpError('this month’s AI-credit usage', usage)
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
