import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createAgentStatusExtensionHarness } from './agent-status-extension-test-harness'
import { postedHookNames } from './agent-status-subagent-event-fixtures'

function events(mock: ReturnType<typeof vi.fn>): unknown[] {
  return mock.mock.calls.map((call) => JSON.parse(String(call[1]?.body)).payload)
}

describe('OMP completion delivery', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it.each(['rejection', 'HTTP failure'])(
    'retries a final %s without another turn',
    async (failure) => {
      const harness = createAgentStatusExtensionHarness({ kind: 'omp' })
      await harness.callHook('agent_start')
      await vi.advanceTimersByTimeAsync(0)
      if (failure === 'rejection') {
        harness.fetchMock.mockRejectedValueOnce(new Error('offline'))
      } else {
        harness.fetchMock.mockResolvedValueOnce({ ok: false, status: 503 })
      }
      await harness.callHook('agent_end')
      await vi.advanceTimersByTimeAsync(251)
      expect(events(harness.fetchMock)).toEqual([
        { hook_event_name: 'agent_start' },
        { hook_event_name: 'agent_end' },
        { hook_event_name: 'agent_end' }
      ])
      expect(vi.getTimerCount()).toBe(0)
    }
  )

  it.each([22, null])('retries failed or timed-out WSL curl (exit %s)', async (curlExitCode) => {
    const harness = createAgentStatusExtensionHarness({
      kind: 'omp',
      env: { WSL_DISTRO_NAME: 'Ubuntu' },
      existsSync: (path) => path === '/mnt/c/Windows/System32/curl.exe',
      curlExitCode,
      fetchImpl: async () => {
        throw new Error('guest unavailable')
      }
    })
    await harness.callHook('agent_end')
    await vi.advanceTimersByTimeAsync(curlExitCode === null ? 11251 : 251)
    expect(harness.spawnMock).toHaveBeenCalledTimes(2)
    await harness.callHook('session_shutdown')
    await vi.advanceTimersByTimeAsync(60_000)
    expect(harness.spawnMock).toHaveBeenCalledTimes(4)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('does not acknowledge a missing WSL curl bridge', async () => {
    const harness = createAgentStatusExtensionHarness({
      kind: 'omp',
      env: { WSL_DISTRO_NAME: 'Ubuntu' },
      fetchImpl: async () => {
        throw new Error('guest unavailable')
      }
    })
    await harness.callHook('agent_end')
    await vi.advanceTimersByTimeAsync(251)
    expect(harness.fetchMock).toHaveBeenCalledTimes(2)
    await harness.callHook('session_shutdown')
  })

  it('waits for WSL curl acknowledgment before draining a newer snapshot', async () => {
    const harness = createAgentStatusExtensionHarness({
      kind: 'omp',
      env: { WSL_DISTRO_NAME: 'Ubuntu' },
      existsSync: (path) => path === '/mnt/c/Windows/System32/curl.exe',
      curlExitCode: null,
      fetchImpl: async () => {
        throw new Error('guest unavailable')
      }
    })
    await harness.callHook('agent_end')
    await vi.advanceTimersByTimeAsync(0)
    await harness.callHook('agent_start')
    expect(harness.fetchMock).toHaveBeenCalledTimes(1)
    harness.spawnedChildren[0]?.emit('close', 0)
    await vi.advanceTimersByTimeAsync(0)
    expect(harness.fetchMock).toHaveBeenCalledTimes(2)
    harness.spawnedChildren[1]?.emit('close', 0)
    await vi.advanceTimersByTimeAsync(1000)
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(['before_agent_start', 'agent_start'])(
    'retires a failed completion at %s',
    async (boundary) => {
      const harness = createAgentStatusExtensionHarness({ kind: 'omp' })
      harness.fetchMock.mockRejectedValueOnce(new Error('offline'))
      await harness.callHook('agent_end')
      await vi.advanceTimersByTimeAsync(0)
      await harness.callHook(boundary, {})
      await vi.advanceTimersByTimeAsync(10_000)
      expect(
        events(harness.fetchMock).filter((event) => JSON.stringify(event).includes('agent_end'))
      ).toHaveLength(1)
      expect(vi.getTimerCount()).toBe(0)
    }
  )

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

  it.each(['scheduled retry', 'in-flight failure', 'in-flight success'] as const)(
    'preserves completion delivery across a session boundary after %s',
    async (delivery) => {
      const harness = createAgentStatusExtensionHarness({ kind: 'omp' })
      let id = 'A'
      const ctx = {
        isIdle: () => true,
        sessionManager: { getSessionId: () => id, getSessionFile: () => `/sessions/${id}.jsonl` }
      }
      await harness.callHook('agent_start', {}, ctx)
      await vi.advanceTimersByTimeAsync(0)
      let acknowledge: ((value: { ok: boolean }) => void) | undefined
      let fail: ((error: Error) => void) | undefined
      if (delivery === 'scheduled retry') {
        harness.fetchMock.mockRejectedValueOnce(new Error('offline'))
      } else {
        harness.fetchMock.mockImplementationOnce(
          () =>
            new Promise((resolve, reject) => {
              acknowledge = resolve
              fail = reject
            })
        )
      }
      await harness.callHook('agent_end', {}, ctx)
      await vi.advanceTimersByTimeAsync(0)
      id = 'B'
      await harness.callHook('session_switch', { reason: 'new' }, ctx)
      await harness.callHook('agent_start', {}, ctx)
      if (delivery === 'in-flight failure') {
        fail?.(new Error('late failure'))
      } else {
        acknowledge?.({ ok: true })
      }
      await vi.advanceTimersByTimeAsync(5_000)

      const payloads = events(harness.fetchMock)
      const completions = payloads.filter(
        (event) =>
          event &&
          typeof event === 'object' &&
          'hook_event_name' in event &&
          event.hook_event_name === 'agent_end'
      )
      expect(completions).toHaveLength(delivery === 'in-flight success' ? 1 : 2)
      for (const completion of completions) {
        expect(completion).toMatchObject({ session_id: 'A' })
      }
      expect(payloads.at(-1)).toMatchObject({ hook_event_name: 'agent_start', session_id: 'B' })
      expect(vi.getTimerCount()).toBe(0)
    }
  )

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

  it('bounds retries when Orca stays unreachable', async () => {
    const harness = createAgentStatusExtensionHarness({
      kind: 'omp',
      fetchImpl: async () => {
        throw new Error('offline')
      }
    })
    await harness.callHook('agent_end')
    await vi.advanceTimersByTimeAsync(30_000)
    expect(harness.fetchMock).toHaveBeenCalledTimes(4)
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
