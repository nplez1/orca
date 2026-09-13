import type { MoneyAmount } from '../../../shared/money-amount'
import {
  parseFireworksMoney,
  sumFireworksCosts,
  type FireworksSpendResult
} from './fireworks-fetcher-data'

// Why: payload -> spend translation, split from fireworks-fetcher.ts so the
// transport file stays under the line cap. Pure functions, no I/O.

const FIREWORKS_ACCOUNT_NAME_PREFIX = 'accounts/'

export type FireworksAccountEntry = {
  name?: unknown
  accountId?: unknown
  id?: unknown
}

export type FireworksAccountListResponse = {
  accounts?: unknown
}

export type FireworksLineItemPayload = {
  category?: unknown
  totalCost?: unknown
}

export type FireworksBillingSummaryResponse = {
  lineItems?: unknown
  usageBuckets?: unknown
}

function isPlainObject(value: unknown): value is object {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function asUnknownArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

// Why: the only id the documented account object carries is inside `name`
// ("accounts/<account_id>"); Fireworks publishes no key -> account lookup. Accept
// a bare `accountId`/`id` too so a future revision does not break discovery.
function readAccountId(entry: unknown): string | null {
  if (!isPlainObject(entry)) {
    return null
  }
  const account: FireworksAccountEntry = entry
  const name = typeof account.name === 'string' ? account.name.trim() : ''
  if (name) {
    const stripped = name.startsWith(FIREWORKS_ACCOUNT_NAME_PREFIX)
      ? name.slice(FIREWORKS_ACCOUNT_NAME_PREFIX.length).trim()
      : name
    if (stripped) {
      return stripped
    }
  }
  for (const candidate of [account.accountId, account.id]) {
    if (typeof candidate === 'string' && candidate.trim()) {
      return candidate.trim()
    }
  }
  return null
}

/** First usable account id in a `GET /v1/accounts` page, or null when none is present. */
export function parseFireworksAccountId(payload: unknown): string | null {
  if (!isPlainObject(payload)) {
    return null
  }
  const list: FireworksAccountListResponse = payload
  for (const entry of asUnknownArray(list.accounts)) {
    const accountId = readAccountId(entry)
    if (accountId) {
      return accountId
    }
  }
  return null
}

function parseLineItemCosts(lineItems: unknown): MoneyAmount[] | null {
  const amounts: MoneyAmount[] = []
  for (const raw of asUnknownArray(lineItems)) {
    if (!isPlainObject(raw)) {
      return null
    }
    const item: FireworksLineItemPayload = raw
    const amount = parseFireworksMoney(item.totalCost)
    // Why: dropping an unreadable cost would silently under-report spend, which
    // is worse than a parse failure the user can see and report.
    if (!amount) {
      return null
    }
    amounts.push(amount)
  }
  return amounts
}

/**
 * Rated spend for the requested range.
 *
 * Why only `lineItems`: when `granularity=DAILY` is set, `usageBuckets`
 * subdivides the same range, so adding both would count each cost twice. The
 * top-level `lineItems` is already the range-wide grouping.
 */
export function parseFireworksBillingSummary(payload: unknown): FireworksSpendResult {
  if (!isPlainObject(payload)) {
    return { status: 'malformed' }
  }
  const summary: FireworksBillingSummaryResponse = payload
  if (summary.lineItems != null && !Array.isArray(summary.lineItems)) {
    return { status: 'malformed' }
  }
  // Why: proto3 JSON omits an empty repeated field, so an account with no usage
  // answers without `lineItems` at all — that is zero spend, not a bad payload.
  const amounts = parseLineItemCosts(summary.lineItems)
  if (amounts === null) {
    return { status: 'malformed' }
  }
  return { status: 'ok', amount: sumFireworksCosts(amounts) }
}
