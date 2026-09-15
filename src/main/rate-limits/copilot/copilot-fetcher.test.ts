import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { UsageRateLimitFailureKind } from '../../../shared/rate-limit-types'

type GhResult = { stdout: string; stderr: string }
type GhCallOptions = { env?: NodeJS.ProcessEnv }

const { ghExecFileAsyncMock } = vi.hoisted(() => ({
  ghExecFileAsyncMock: vi.fn<(args: string[], options?: GhCallOptions) => Promise<GhResult>>()
}))

// Why: `gh` is the whole transport for this endpoint, so mocking that one surface keeps
// the suite off the real GitHub API and off the real CLI.
vi.mock('../../git/command-runner/gh-exec-file', () => ({
  ghExecFileAsync: ghExecFileAsyncMock
}))

import { fetchCopilotRateLimits } from './copilot-fetcher'

const GITHUB_API_VERSION = '2026-03-10'
// A mid-month instant, so the next-month boundary is unambiguous.
const FROZEN_NOW = Date.parse('2026-07-04T12:00:00.000Z')

const HTTP_STATUS_TEXT: Record<number, string> = {
  400: 'Bad Request',
  401: 'Bad credentials',
  403: 'Resource protected by enterprise policy',
  404: 'Not Found',
  500: 'Server Error',
  503: 'Service Unavailable'
}

function ghOk(payload: unknown): GhResult {
  return { stdout: JSON.stringify(payload), stderr: '' }
}

/** A gh rejection shaped like the real one: the API status lives inside stderr. */
function ghHttpError(status: number): Error & { stderr: string } {
  const text = `gh: ${HTTP_STATUS_TEXT[status] ?? 'Error'} (HTTP ${status})`
  return Object.assign(new Error(text), { stderr: text })
}

function ghEnoent(): Error & { code: string } {
  return Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' })
}

function ghCliError(stderr: string): Error & { stderr: string } {
  return Object.assign(new Error(stderr), { stderr })
}

function userEntitlement(overrides: Record<string, unknown> = {}): unknown {
  return {
    quota_reset_date_utc: '2026-08-01T00:00:00.000Z',
    quota_snapshots: {
      premium_interactions: {
        credits_used: 264_518,
        entitlement: 1_000_000
      }
    },
    ...overrides
  }
}

function callArgs(index: number): string[] | undefined {
  return ghExecFileAsyncMock.mock.calls[index]?.[0]
}

describe('fetchCopilotRateLimits', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(FROZEN_NOW))
    ghExecFileAsyncMock.mockReset()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('reads the user entitlement through gh with the documented argv', async () => {
    ghExecFileAsyncMock.mockResolvedValueOnce(ghOk(userEntitlement()))

    const result = await fetchCopilotRateLimits()

    expect(result).toEqual({
      provider: 'copilot',
      session: null,
      weekly: null,
      monthly: {
        usedPercent: 26.4518,
        windowMinutes: 43_200,
        resetsAt: Date.UTC(2026, 7, 1),
        resetDescription: null
      },
      allowance: {
        unit: { kind: 'count', label: 'AI credits' },
        used: 264_518,
        limit: 1_000_000,
        resetsAt: Date.UTC(2026, 7, 1)
      },
      updatedAt: FROZEN_NOW,
      error: null,
      status: 'ok',
      usageMetadata: { source: 'web' }
    })
    expect(callArgs(0)).toEqual([
      'api',
      '/copilot_internal/user',
      '-H',
      `X-GitHub-Api-Version: ${GITHUB_API_VERSION}`
    ])
    expect(ghExecFileAsyncMock).toHaveBeenCalledTimes(1)
  })

  it('sends no env override, so gh always uses its own sign-in', async () => {
    ghExecFileAsyncMock.mockResolvedValueOnce(ghOk(userEntitlement()))

    await fetchCopilotRateLimits()

    // Why asserted: this provider has no stored credential and must never hold a token.
    expect(ghExecFileAsyncMock.mock.calls[0]).toHaveLength(1)
    expect(JSON.stringify(ghExecFileAsyncMock.mock.calls)).not.toContain('GH_TOKEN')
  })

  it('reports an unreadable user entitlement instead of inventing a quota', async () => {
    ghExecFileAsyncMock.mockResolvedValueOnce(ghOk({ quota_snapshots: {} }))

    const result = await fetchCopilotRateLimits()

    expect(result.status).toBe('error')
    expect(result.usageMetadata).toEqual({ failureKind: 'parse', source: 'web' })
    expect(result.error).toMatch(/no usable premium-interaction entitlement/i)
  })

  const HTTP_STATUS_CASES: [number, UsageRateLimitFailureKind, RegExp][] = [
    [401, 'stale-token', /rejected the GitHub CLI sign-in/i],
    [403, 'missing-scope', /cannot read your Copilot entitlement/i],
    [404, 'usage-unavailable', /did not expose a Copilot entitlement/i],
    [500, 'server', /server error/i],
    [503, 'server', /server error/i]
  ]

  it.each(HTTP_STATUS_CASES)(
    'maps HTTP %i to failureKind %s',
    async (status, failureKind, messagePattern) => {
      ghExecFileAsyncMock.mockRejectedValueOnce(ghHttpError(status))

      const result = await fetchCopilotRateLimits()

      expect(result.status).toBe('error')
      expect(result.usageMetadata?.failureKind).toBe(failureKind)
      expect(result.error).toMatch(messagePattern)
      expect(ghExecFileAsyncMock).toHaveBeenCalledTimes(1)
    }
  )

  it('recovers the status from gh stderr even when gh prints a JSON error body after it', async () => {
    ghExecFileAsyncMock.mockRejectedValueOnce(
      ghCliError('gh: Not Found (HTTP 404)\n{"message":"Not Found","status":"404"}')
    )

    const result = await fetchCopilotRateLimits()

    expect(result.usageMetadata?.failureKind).toBe('usage-unavailable')
    expect(result.error).toMatch(/did not expose a Copilot entitlement/i)
  })

  it('falls back to usage-unavailable for an unmapped HTTP status', async () => {
    ghExecFileAsyncMock.mockRejectedValueOnce(ghHttpError(400))

    const result = await fetchCopilotRateLimits()

    expect(result.status).toBe('error')
    expect(result.usageMetadata?.failureKind).toBe('usage-unavailable')
    expect(result.error).toContain('400')
  })

  it('treats a gh failure with no HTTP status as a CLI error, not as a server error', async () => {
    ghExecFileAsyncMock.mockRejectedValueOnce(ghCliError('gh: could not connect to api.github.com'))

    const result = await fetchCopilotRateLimits()

    expect(result.status).toBe('error')
    expect(result.usageMetadata).toEqual({ failureKind: 'usage-unavailable', source: 'web' })
    expect(result.error).toContain('could not connect to api.github.com')
    expect(result.error).toContain('GitHub CLI')
  })

  it('survives a gh rejection that carries no Error object', async () => {
    ghExecFileAsyncMock.mockRejectedValueOnce('gh exploded')

    const result = await fetchCopilotRateLimits()

    expect(result.status).toBe('error')
    expect(result.usageMetadata?.failureKind).toBe('usage-unavailable')
    expect(result.error).toContain('gh exploded')
  })

  it('reports a missing gh CLI as cli-unavailable', async () => {
    ghExecFileAsyncMock.mockRejectedValueOnce(ghEnoent())

    const result = await fetchCopilotRateLimits()

    expect(result.status).toBe('error')
    expect(result.usageMetadata).toEqual({ failureKind: 'cli-unavailable', source: 'web' })
    expect(result.error).toMatch(/install gh/i)
    expect(result.error).toContain('gh auth login')
  })

  it('reports unreadable JSON as a parse error without throwing', async () => {
    ghExecFileAsyncMock.mockResolvedValueOnce({
      stdout: '<html><body>gateway error</body></html>',
      stderr: ''
    })

    const result = await fetchCopilotRateLimits()

    expect(result.status).toBe('error')
    expect(result.usageMetadata).toEqual({ failureKind: 'parse', source: 'web' })
    expect(result.error).toMatch(/unreadable json/i)
  })

  const GARBAGE_ENTITLEMENT_PAYLOADS: string[] = [
    'null',
    '[]',
    '"not-an-object"',
    '{"quota_snapshots":null}',
    '{"quota_snapshots":"nope"}',
    '{"quota_snapshots":{"premium_interactions":null}}',
    '{"quota_snapshots":{"premium_interactions":{"credits_used":"abc","entitlement":100}}}',
    '{"quota_snapshots":{"premium_interactions":{"entitlement":100}}}',
    '{"quota_snapshots":{"premium_interactions":{"credits_used":5}}}',
    '{"quota_snapshots":{"premium_interactions":{"credits_used":5,"entitlement":0}}}',
    '{"quota_snapshots":{"premium_interactions":{"credits_used":5,"entitlement":-1}}}'
  ]

  it.each(GARBAGE_ENTITLEMENT_PAYLOADS)(
    'never throws and reports a parse error for %s',
    async (stdout) => {
      ghExecFileAsyncMock.mockResolvedValueOnce({ stdout, stderr: '' })

      const result = await fetchCopilotRateLimits()

      expect(result.provider).toBe('copilot')
      expect(result.status).toBe('error')
      expect(result.usageMetadata).toEqual({ failureKind: 'parse', source: 'web' })
      expect(result.updatedAt).toBe(FROZEN_NOW)
      expect(result.allowance).toBeUndefined()
      expect(ghExecFileAsyncMock).toHaveBeenCalledTimes(1)
    }
  )

  it('accepts an entitlement whose numeric fields arrive as strings', async () => {
    ghExecFileAsyncMock.mockResolvedValueOnce(
      ghOk({
        quota_reset_date_utc: '2026-08-01T00:00:00.000Z',
        quota_snapshots: { premium_interactions: { credits_used: '250', entitlement: '1000' } }
      })
    )

    const result = await fetchCopilotRateLimits()

    expect(result.status).toBe('ok')
    expect(result.allowance).toEqual({
      unit: { kind: 'count', label: 'AI credits' },
      used: 250,
      limit: 1_000,
      resetsAt: Date.UTC(2026, 7, 1)
    })
    expect(result.monthly?.usedPercent).toBe(25)
  })
})
