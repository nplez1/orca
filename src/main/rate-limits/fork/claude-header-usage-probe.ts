import type { ProviderRateLimits, RateLimitWindow } from '../../../shared/rate-limit-types'
import { abortSignalWithTimeout } from '../../lib/abort-signal-with-timeout'
import { getMainHttpClient } from '../../network/http-client'
import { ensureElectronProxyFromEnvironment } from '../../network/proxy-settings'
import { mapClaudeUsageWindow } from '../claude-usage-window'

// fork-comment-ok: fork-only source; the why must sit above the code a sync rewrites.
/**
 * Plan usage read from the API's own unified rate-limit headers.
 *
 * The Claude CLI reports these headers on every completion, and Claude Code's statusline is fed from
 * them — which is why a session shows usage while Orca's own poll shows none. Asking for the smallest
 * possible completion reads the same numbers proactively: `max_tokens: 1` costs one output token and
 * the window utilization comes back in the response headers, not the body.
 *
 * This is the source that works when `GET /api/oauth/usage` answers 429 (measured on this machine
 * 2026-11-09: `retry-after: 3593`) and when the CLI's `get_usage` control request answers
 * `rate_limits_available: false` on 2.1.319.
 */
const MESSAGES_URL = 'https://api.anthropic.com/v1/messages'
// Cheapest model with a one-token reply; the readout lives in the headers, so the model only has to exist.
const PROBE_MODEL = 'claude-haiku-4-5-20251001'
const PROBE_TIMEOUT_MS = 10_000
const SESSION_WINDOW_MINUTES = 300
const WEEKLY_WINDOW_MINUTES = 10_080

const SESSION_UTILIZATION = 'anthropic-ratelimit-unified-5h-utilization'
const SESSION_RESET = 'anthropic-ratelimit-unified-5h-reset'
const WEEKLY_UTILIZATION = 'anthropic-ratelimit-unified-7d-utilization'
const WEEKLY_RESET = 'anthropic-ratelimit-unified-7d-reset'

type HeaderReader = { get(name: string): string | null }

/** The header is a 0–1 fraction; anything above 1 is already a percentage. */
export function claudeHeaderUtilization(value: string | null): number | null {
  if (value === null) {
    return null
  }
  const parsed = Number(value.trim())
  if (!Number.isFinite(parsed) || parsed < 0) {
    return null
  }
  return parsed <= 1 ? parsed * 100 : parsed
}

function claudeHeaderReset(value: string | null): number | undefined {
  if (value === null) {
    return undefined
  }
  const parsed = Number(value.trim())
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined
}

function windowFromHeaders(
  headers: HeaderReader,
  utilizationHeader: string,
  resetHeader: string,
  windowMinutes: number
): RateLimitWindow | null {
  const utilization = claudeHeaderUtilization(headers.get(utilizationHeader))
  return utilization === null
    ? null
    : mapClaudeUsageWindow(
        { utilization, resets_at: claudeHeaderReset(headers.get(resetHeader)) },
        windowMinutes
      )
}

/** Map the unified rate-limit headers onto the snapshot the status bar renders. */
export function mapClaudeUnifiedRateLimitHeaders(headers: HeaderReader): ProviderRateLimits | null {
  const session = windowFromHeaders(
    headers,
    SESSION_UTILIZATION,
    SESSION_RESET,
    SESSION_WINDOW_MINUTES
  )
  const weekly = windowFromHeaders(headers, WEEKLY_UTILIZATION, WEEKLY_RESET, WEEKLY_WINDOW_MINUTES)
  if (!session && !weekly) {
    return null
  }
  return {
    provider: 'claude',
    session,
    weekly,
    updatedAt: Date.now(),
    error: null,
    status: 'ok',
    // Why 'cli': these are the same server-reported headers the CLI reads, not an endpoint reading.
    usageMetadata: { source: 'cli', attemptedSources: ['cli'] }
  }
}

/**
 * Read plan usage from a one-token completion's rate-limit headers.
 *
 * Null means this account cannot be read this way — no plan headers on the reply, a refused request,
 * or no network — and the caller keeps its other sources.
 */
export async function probeClaudeUsageHeaders(
  token: string,
  signal?: AbortSignal
): Promise<ProviderRateLimits | null> {
  if (signal?.aborted) {
    return null
  }
  await ensureElectronProxyFromEnvironment({ probeUrl: MESSAGES_URL }).catch(() => {})
  if (signal?.aborted) {
    return null
  }
  try {
    const response = await getMainHttpClient().fetch(MESSAGES_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'anthropic-beta': 'oauth-2025-04-20',
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
        'User-Agent': 'claude-code/2.1.0'
      },
      body: JSON.stringify({
        model: PROBE_MODEL,
        max_tokens: 1,
        messages: [{ role: 'user', content: 'hi' }]
      }),
      signal: abortSignalWithTimeout(signal, PROBE_TIMEOUT_MS)
    })
    // Why no ok check: a 429 still carries the unified headers, and those headers are the answer.
    const reading = mapClaudeUnifiedRateLimitHeaders(response.headers)
    // Why: an unread undici body can crash the process, so the reply is always drained.
    await response.text().catch(() => '')
    return reading
  } catch {
    return null
  }
}
