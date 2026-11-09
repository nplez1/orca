import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  claudeHeaderUtilization,
  mapClaudeUnifiedRateLimitHeaders,
  probeClaudeUsageHeaders
} from './claude-header-usage-probe'

const fetchMock = vi.hoisted(() => vi.fn())
vi.mock('../../network/http-client', () => ({ getMainHttpClient: () => ({ fetch: fetchMock }) }))
vi.mock('../../network/proxy-settings', () => ({
  ensureElectronProxyFromEnvironment: async () => ({})
}))

// Measured on this machine 2026-11-09: a one-token haiku completion answered these headers while
// `GET /api/oauth/usage` answered 429 with `retry-after: 3593`.
const UNIFIED_HEADERS: Record<string, string> = {
  'anthropic-ratelimit-unified-5h-utilization': '0.51',
  'anthropic-ratelimit-unified-5h-reset': '1794213600',
  'anthropic-ratelimit-unified-7d-utilization': '0.14',
  'anthropic-ratelimit-unified-7d-reset': '1794499200',
  'anthropic-ratelimit-unified-status': 'allowed'
}

function headers(source: Record<string, string>): { get(name: string): string | null } {
  return { get: (name) => source[name.toLowerCase()] ?? null }
}

function response(
  status: number,
  source: Record<string, string>
): {
  ok: boolean
  status: number
  headers: ReturnType<typeof headers>
  text: () => Promise<string>
} {
  return { ok: status < 400, status, headers: headers(source), text: async () => '{}' }
}

beforeEach(() => {
  fetchMock.mockReset()
})

describe('claudeHeaderUtilization', () => {
  it('reads the header as the 0–1 fraction the API sends', () => {
    expect(claudeHeaderUtilization('0.51')).toBeCloseTo(51)
    expect(claudeHeaderUtilization('0')).toBe(0)
  })

  it('leaves an already-percentage value alone', () => {
    expect(claudeHeaderUtilization('51')).toBe(51)
  })

  it('reports nothing for a header that is not a usable number', () => {
    expect(claudeHeaderUtilization(null)).toBeNull()
    expect(claudeHeaderUtilization('n/a')).toBeNull()
    expect(claudeHeaderUtilization('-1')).toBeNull()
  })
})

describe('mapClaudeUnifiedRateLimitHeaders', () => {
  it('maps both plan windows onto the snapshot the status bar renders', () => {
    const reading = mapClaudeUnifiedRateLimitHeaders(headers(UNIFIED_HEADERS))

    expect(reading?.status).toBe('ok')
    expect(reading?.session?.usedPercent).toBeCloseTo(51)
    expect(reading?.session?.windowMinutes).toBe(300)
    expect(reading?.session?.resetsAt).toBe(1_794_213_600_000)
    expect(reading?.weekly?.usedPercent).toBeCloseTo(14)
    expect(reading?.weekly?.windowMinutes).toBe(10_080)
    expect(reading?.weekly?.resetsAt).toBe(1_794_499_200_000)
  })

  it('reports nothing when the reply carries no plan window', () => {
    expect(mapClaudeUnifiedRateLimitHeaders(headers({}))).toBeNull()
  })

  it('keeps the weekly window when only that one is reported', () => {
    const reading = mapClaudeUnifiedRateLimitHeaders(
      headers({ 'anthropic-ratelimit-unified-7d-utilization': '0.2' })
    )

    expect(reading?.session).toBeNull()
    expect(reading?.weekly?.usedPercent).toBeCloseTo(20)
  })
})

describe('probeClaudeUsageHeaders', () => {
  it('asks for a one-token completion and reads the answer from its headers', async () => {
    fetchMock.mockResolvedValue(response(200, UNIFIED_HEADERS))

    const reading = await probeClaudeUsageHeaders('sk-ant-oat01-token')

    expect(reading?.session?.usedPercent).toBeCloseTo(51)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://api.anthropic.com/v1/messages')
    expect(init.method).toBe('POST')
    expect(init.headers.Authorization).toBe('Bearer sk-ant-oat01-token')
    // The readout is the headers, so the completion itself stays as small as the API allows.
    expect(JSON.parse(init.body).max_tokens).toBe(1)
  })

  it('drains the response body, which an unread undici stream would crash on', async () => {
    const reply = response(200, UNIFIED_HEADERS)
    const drain = vi.fn(async () => '{}')
    fetchMock.mockResolvedValue({ ...reply, text: drain })

    await probeClaudeUsageHeaders('sk-ant-oat01-token')

    expect(drain).toHaveBeenCalled()
  })

  it('still reads the plan window from a rate-limited reply', async () => {
    fetchMock.mockResolvedValue(response(429, UNIFIED_HEADERS))

    expect((await probeClaudeUsageHeaders('sk-ant-oat01-token'))?.session?.usedPercent).toBeCloseTo(
      51
    )
  })

  it('answers nothing when the request itself fails', async () => {
    fetchMock.mockRejectedValue(new Error('offline'))

    expect(await probeClaudeUsageHeaders('sk-ant-oat01-token')).toBeNull()
  })

  it('spends no request once the cycle is aborted', async () => {
    const controller = new AbortController()
    controller.abort()

    expect(await probeClaudeUsageHeaders('sk-ant-oat01-token', controller.signal)).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
