import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createAgentStatusExtensionHarness } from './agent-status-extension-test-harness'
import { postedHookNames } from './agent-status-subagent-event-fixtures'

function events(mock: ReturnType<typeof vi.fn>): unknown[] {
  return mock.mock.calls.map((call) => JSON.parse(String(call[1]?.body)).payload)
}

describe('OMP completion delivery', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('does not schedule retries when a pending completion fails after a new start', async () => {
    let rejectDelivery: ((error: Error) => void) | undefined
    const harness = createAgentStatusExtensionHarness({ kind: 'omp' })
    harness.fetchMock.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectDelivery = reject
        })
    )
    await harness.callHook('agent_end')
    await harness.callHook('agent_start')
    rejectDelivery?.(new Error('late failure'))
    await vi.advanceTimersByTimeAsync(10_000)
    expect(events(harness.fetchMock)).toEqual([
      { hook_event_name: 'agent_end' },
      { hook_event_name: 'agent_start' }
    ])
  })

  it('retries a timed out completion without blocking agent handlers', async () => {
    const harness = createAgentStatusExtensionHarness({ kind: 'omp' })
    harness.fetchMock.mockImplementationOnce(() => new Promise(() => {}))
    await harness.callHook('agent_end')
    await vi.advanceTimersByTimeAsync(1251)
    expect(events(harness.fetchMock)).toEqual([
      { hook_event_name: 'agent_end' },
      { hook_event_name: 'agent_end' }
    ])
    expect(harness.fetchMock.mock.calls[0]?.[1]?.signal.aborted).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })
})

// A plain-pi completion used to be dropped outright: only OMP retried, and once the turn ended the
// endpoint watch stopped — so a stall or restart while a turn was ending left the pane "working"
// until the user typed again. The opposite symptom to #197/#100.
describe('plain pi completion delivery', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  function endpointHarness(args: {
    fetchImpl: (...params: Parameters<typeof fetch>) => Promise<unknown>
    readEndpoint: () => string
  }) {
    let ino = 1
    return createAgentStatusExtensionHarness({
      kind: 'pi',
      env: { ORCA_AGENT_HOOK_ENDPOINT: '/tmp/orca-hook-endpoint' },
      existsSync: (path) => path === '/tmp/orca-hook-endpoint',
      // Why a fresh inode per stat: the endpoint read caches on it, and the test changes the file.
      statSync: () => ({ mtimeMs: ino, size: 1, ino: ino++ }),
      readFileSync: () => args.readEndpoint(),
      fetchImpl: args.fetchImpl
    })
  }

  const endpointFile = (token: string): string =>
    [
      'set ORCA_AGENT_HOOK_PORT=4321',
      `set ORCA_AGENT_HOOK_TOKEN=${token}`,
      'set ORCA_AGENT_HOOK_ENV=env-1',
      'set ORCA_AGENT_HOOK_VERSION=1.2.3',
      ''
    ].join('\n')

  it('retries a failed completion instead of dropping it', async () => {
    const harness = createAgentStatusExtensionHarness({ kind: 'pi' })
    harness.fetchMock.mockRejectedValueOnce(new Error('offline'))
    await harness.callHook('agent_end')
    await vi.advanceTimersByTimeAsync(251)

    expect(postedHookNames(harness)).toEqual(['agent_end', 'agent_end'])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('keeps no endpoint watch once the completion is acknowledged', async () => {
    const harness = endpointHarness({
      fetchImpl: async () => ({ ok: true }),
      readEndpoint: () => endpointFile('token-1')
    })
    await harness.callHook('agent_end')
    await vi.advanceTimersByTimeAsync(0)

    expect(harness.fetchMock).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('republishes an unacknowledged completion at the restarted Orca endpoint', async () => {
    let token = 'token-1'
    const harness = endpointHarness({
      fetchImpl: async () => {
        throw new Error('offline')
      },
      readEndpoint: () => endpointFile(token)
    })
    await harness.callHook('agent_end')
    await vi.advanceTimersByTimeAsync(30_000)
    const beforeRestart = harness.fetchMock.mock.calls.length

    // A restart mints a new token, which is how the pane notices it now reports somewhere else.
    token = 'token-2'
    await vi.advanceTimersByTimeAsync(4_000)

    expect(harness.fetchMock.mock.calls.length).toBeGreaterThan(beforeRestart)
    expect(
      events(harness.fetchMock)
        .slice(beforeRestart)
        .every((event) => JSON.stringify(event).includes('agent_end'))
    ).toBe(true)
  })
})
