import { EventEmitter } from 'node:events'
import { vi, type Mock } from 'vitest'
import type { ProviderRateLimits } from '../../shared/rate-limit-types'
import type { RateLimitService } from './service'
import { fetchCodexRateLimits } from './codex-fetcher'
import { fetchGeminiRateLimits } from './gemini-usage-fetcher'
import { fetchKimiRateLimits } from './kimi-fetcher'
import { fetchMiniMaxRateLimits } from './minimax/minimax-fetcher'
import { fetchDeepSeekRateLimits } from './deepseek/deepseek-fetcher'
import { fetchFireworksRateLimits } from './fireworks/fireworks-fetcher'
import { fetchCopilotRateLimits } from './copilot/copilot-fetcher'
import { fetchGrokRateLimits } from './grok-fetcher'
import { readGrokAuthSession } from './grok-auth'
import { fetchCursorRateLimits } from './cursor-fetcher'
import { readCursorAuthSession } from './cursor-auth'
import { fetchOpenCodeGoUsage } from './opencode-go-usage-source-selection'
import { fetchZcodeRateLimits } from './zcode-usage-fetcher'
import { fetchAntigravityRateLimits } from './antigravity-usage-fetcher'
import { hasMiniMaxSessionCookie } from '../minimax/minimax-cookie-store'
import { hasDeepSeekApiKey } from '../deepseek/deepseek-api-key-store'
import { hasFireworksCredentials } from '../fireworks/fireworks-credentials-store'

export type Deferred<T> = {
  promise: Promise<T>
  resolve: (value: T) => void
}

export function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

export async function flushMicrotasks(times = 4): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await Promise.resolve()
  }
}

export function okProvider(
  provider: ProviderRateLimits['provider'],
  usedPercent: number,
  updatedAt = Date.now()
): ProviderRateLimits {
  return {
    provider,
    session: {
      usedPercent,
      windowMinutes: 300,
      resetsAt: null,
      resetDescription: null
    },
    weekly: null,
    updatedAt,
    error: null,
    status: 'ok'
  }
}

export function errorProvider(
  provider: ProviderRateLimits['provider'],
  message: string
): ProviderRateLimits {
  return {
    provider,
    session: null,
    weekly: null,
    updatedAt: Date.now(),
    error: message,
    status: 'error'
  }
}

export function unavailableProvider(
  provider: ProviderRateLimits['provider'],
  message = 'Not configured'
): ProviderRateLimits {
  return {
    provider,
    session: null,
    weekly: null,
    updatedAt: Date.now(),
    error: message,
    status: 'unavailable'
  }
}

// Why: balance/spend providers have no quota window, so a window-shaped fixture would test a state they can never produce.
export function creditsProvider(
  provider: ProviderRateLimits['provider'],
  kind: 'balance' | 'spend' = 'balance'
): ProviderRateLimits {
  return {
    provider,
    session: null,
    weekly: null,
    credits: {
      kind,
      amount: { currencyCode: 'USD', units: '42', nanos: 100_000_000 },
      ...(kind === 'spend' ? { period: 'current-month' as const } : {})
    },
    updatedAt: Date.now(),
    error: null,
    status: 'ok'
  }
}

// Why: beforeEach caches snapshot objects whose updatedAt is pinned at suite
// start, so after 5 fake minutes every healthy provider looks stale and every
// activation degrades to a full fetch. Backoff tests that reason about the
// individual retry lane need healthy providers minted fresh at fetch time.
export function mockFreshBackgroundProviderFetches(): void {
  vi.mocked(fetchCodexRateLimits).mockImplementation(async () => okProvider('codex', 24))
  vi.mocked(fetchGeminiRateLimits).mockImplementation(async () => okProvider('gemini', 0))
  vi.mocked(fetchOpenCodeGoUsage).mockImplementation(async () => okProvider('opencode-go', 0))
  vi.mocked(fetchKimiRateLimits).mockImplementation(async () => okProvider('kimi', 0))
  vi.mocked(fetchMiniMaxRateLimits).mockImplementation(async () => okProvider('minimax', 0))
  vi.mocked(fetchDeepSeekRateLimits).mockImplementation(async () => unavailableProvider('deepseek'))
  vi.mocked(fetchFireworksRateLimits).mockImplementation(async () =>
    unavailableProvider('fireworks')
  )
  vi.mocked(fetchCopilotRateLimits).mockImplementation(async () => unavailableProvider('copilot'))
  vi.mocked(fetchGrokRateLimits).mockImplementation(async () => unavailableProvider('grok'))
  vi.mocked(fetchCursorRateLimits).mockImplementation(async () => unavailableProvider('cursor'))
  vi.mocked(fetchZcodeRateLimits).mockImplementation(async () => unavailableProvider('zcode'))
  vi.mocked(fetchAntigravityRateLimits).mockImplementation(async () =>
    unavailableProvider('antigravity')
  )
}

/** The provider modules a suite must mock before this harness can stub them, with the failure
 *  the harness hit without this check: `vi.mocked(fetchDeepSeekRateLimits).mockResolvedValue`
 *  on a real function reports "mockResolvedValue is not a function" at whichever line ran
 *  first, which names neither the module nor the suite's obligation. Worse, a guarded version
 *  would silently run the real fetcher — real credential reads and subprocesses. */
function unmockedProviderModules(): string[] {
  const modules: [string, unknown][] = [
    ['./codex-fetcher', fetchCodexRateLimits],
    ['./gemini-usage-fetcher', fetchGeminiRateLimits],
    ['./kimi-fetcher', fetchKimiRateLimits],
    ['./minimax/minimax-fetcher', fetchMiniMaxRateLimits],
    ['./deepseek/deepseek-fetcher', fetchDeepSeekRateLimits],
    ['./fireworks/fireworks-fetcher', fetchFireworksRateLimits],
    ['./copilot/copilot-fetcher', fetchCopilotRateLimits],
    ['./grok-fetcher', fetchGrokRateLimits],
    ['./grok-auth', readGrokAuthSession],
    ['./cursor-fetcher', fetchCursorRateLimits],
    ['./cursor-auth', readCursorAuthSession],
    ['./opencode-go-usage-source-selection', fetchOpenCodeGoUsage],
    ['./zcode-usage-fetcher', fetchZcodeRateLimits],
    ['./antigravity-usage-fetcher', fetchAntigravityRateLimits],
    ['../minimax/minimax-cookie-store', hasMiniMaxSessionCookie],
    ['../deepseek/deepseek-api-key-store', hasDeepSeekApiKey],
    ['../fireworks/fireworks-credentials-store', hasFireworksCredentials]
  ]
  return modules
    .filter(([, imported]) => !vi.isMockFunction(imported))
    .map(([specifier]) => specifier)
}

/** Shared `beforeEach` body: healthy stubs for every provider the service polls. */
export function resetRateLimitProviderMocks(): void {
  // Why here: vitest hoists `vi.mock` per test file, so this is the first moment the harness can
  // see whether the suite before it mocked what the stubbing below needs.
  const unmocked = unmockedProviderModules()
  if (unmocked.length > 0) {
    throw new Error(
      `rate-limit-service-test-harness: this suite must vi.mock ${unmocked.join(', ')}. ` +
        'The harness stubs every provider the service polls, and a real fetcher here would ' +
        'read real credentials or spawn subprocesses.'
    )
  }
  vi.clearAllMocks()
  vi.mocked(fetchGeminiRateLimits).mockResolvedValue(okProvider('gemini', 0, Date.now()))
  vi.mocked(fetchOpenCodeGoUsage).mockResolvedValue(okProvider('opencode-go', 0, Date.now()))
  vi.mocked(fetchKimiRateLimits).mockResolvedValue(okProvider('kimi', 0, Date.now()))
  vi.mocked(fetchMiniMaxRateLimits).mockResolvedValue(okProvider('minimax', 0, Date.now()))
  // Why: no API key is configured in these suites, so the credential flags must read false or the new providers report a spurious "configured" state.
  vi.mocked(fetchDeepSeekRateLimits).mockResolvedValue(unavailableProvider('deepseek'))
  vi.mocked(fetchFireworksRateLimits).mockResolvedValue(unavailableProvider('fireworks'))
  vi.mocked(fetchCopilotRateLimits).mockResolvedValue(unavailableProvider('copilot'))
  vi.mocked(fetchGrokRateLimits).mockResolvedValue({
    provider: 'grok',
    session: null,
    weekly: null,
    updatedAt: Date.now(),
    error: null,
    status: 'unavailable'
  })
  vi.mocked(fetchCursorRateLimits).mockResolvedValue(unavailableProvider('cursor'))
  vi.mocked(fetchZcodeRateLimits).mockResolvedValue(unavailableProvider('zcode'))
  vi.mocked(fetchAntigravityRateLimits).mockResolvedValue(unavailableProvider('antigravity'))
  vi.mocked(hasMiniMaxSessionCookie).mockReturnValue(false)
  vi.mocked(hasDeepSeekApiKey).mockReturnValue(false)
  vi.mocked(hasFireworksCredentials).mockReturnValue(false)
  vi.mocked(readGrokAuthSession).mockReturnValue({ status: 'missing' })
  vi.mocked(readCursorAuthSession).mockResolvedValue({ status: 'missing' })
}

type RateLimitWindow = Parameters<RateLimitService['attach']>[0]

export type FakeWindowWebContents = {
  send: Mock<(channel: string, ...args: unknown[]) => void>
}

export class FakeRateLimitWindow extends EventEmitter {
  focused = true
  minimized = false
  visible = true

  webContents: FakeWindowWebContents = {
    send: vi.fn()
  }

  isDestroyed(): boolean {
    return false
  }

  isVisible(): boolean {
    return this.visible
  }

  isMinimized(): boolean {
    return this.minimized
  }

  isFocused(): boolean {
    return this.focused
  }
}

export function asRateLimitWindow(window: FakeRateLimitWindow): RateLimitWindow {
  return window as unknown as RateLimitWindow
}
