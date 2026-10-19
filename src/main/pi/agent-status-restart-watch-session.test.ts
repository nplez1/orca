import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { posts, startAsync } from './agent-status-subagent-event-fixtures'
import {
  curlArgv,
  curlUrl,
  harnessWithEndpoint,
  resolveCurlCandidates,
  restartOrca,
  WATCH_MS,
  WSL_CURL_PATH,
  working
} from './agent-status-restart-harness'

/** Long enough for every scheduled retry of a failed final to have fired. */
const STRETCHED_RETRY_MS = 5_000

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

const idle = { isIdle: () => true }

it('is not stopped by an in-process child agent registering itself mid-turn', async () => {
  const harness = harnessWithEndpoint('5001', 'first')
  await harness.callHook('agent_start', {}, working)
  await harness.callHook('tool_execution_start', { toolName: 'task' }, working)
  await vi.advanceTimersByTimeAsync(0)
  // Why: pi-subagents and OMP task children re-run the factory in this same process; the lead is
  // inside its tool call and could not re-arm a watch the child had reset.
  const child = harness.registerTaskChild()
  await child.callHook('session_start', {}, { sessionManager: { getSessionId: () => 'child-1' } })
  await child.callHook('agent_start')
  await vi.advanceTimersByTimeAsync(0)
  const before = harness.fetchMock.mock.calls.length

  restartOrca(harness, '5002', 'second')
  await vi.advanceTimersByTimeAsync(WATCH_MS)
  expect(harness.fetchMock.mock.calls.length).toBe(before + 1)
})

// Why only the OMP family: an OMP task child is a separate bus with its own roster, so its
// shutdown must not speak for the pane. A pi pane has one registration per session, and /reload
// keeps watching on purpose.
it.each(['omp', 'prime-agent'] as const)(
  'is not stopped by a %s task child shutting its own session down',
  async (kind) => {
    const harness = harnessWithEndpoint('5001', 'first', { kind })
    await harness.callHook('agent_start', {}, working)
    await harness.callHook('tool_execution_start', { toolName: 'task' }, working)
    await vi.advanceTimersByTimeAsync(0)
    // Why: the child registers the same session_shutdown handler on its own bus; its end is not the
    // pane's, and the queue it would reset describes the lead.
    const child = harness.registerTaskChild()
    await child.callHook('session_shutdown', { reason: 'quit' })
    await vi.advanceTimersByTimeAsync(0)
    const before = harness.fetchMock.mock.calls.length

    restartOrca(harness, '5002', 'second')
    await vi.advanceTimersByTimeAsync(WATCH_MS)
    expect(harness.fetchMock.mock.calls.length).toBe(before + 1)
  }
)

it('is not ended by a completion retried after the next turn already started', async () => {
  const harness = harnessWithEndpoint('5001', 'first')
  await harness.callHook('agent_start', {}, idle)
  await vi.advanceTimersByTimeAsync(0)
  // Why: the completion's delivery fails while Orca is down; a /reload promotes it to a final that
  // keeps retrying, and by then the next turn's start has already been posted.
  harness.fetchMock.mockRejectedValue(new Error('Orca is going down'))
  await harness.callHook('agent_settled', {}, idle)
  await vi.advanceTimersByTimeAsync(0)
  await harness.reloadPi()
  await harness.callHook('before_agent_start', { prompt: 'next' }, working)
  await harness.callHook('tool_execution_start', { toolName: 'bash' }, working)
  harness.fetchMock.mockResolvedValue({ ok: true })
  await vi.advanceTimersByTimeAsync(STRETCHED_RETRY_MS)

  const before = harness.fetchMock.mock.calls.length

  restartOrca(harness, '5002', 'second')
  await vi.advanceTimersByTimeAsync(WATCH_MS)
  // Why: the retried completion belonged to the turn before this one, so a restarted Orca hears the
  // new turn's state instead of nothing at all.
  expect(harness.fetchMock.mock.calls.length).toBe(before + 1)
  expect(posts(harness).at(-1)).toMatchObject({ hook_event_name: 'tool_execution_start' })
})

it('stops watching when the session ends', async () => {
  const harness = harnessWithEndpoint('5001', 'first')
  await harness.callHook('agent_start', {}, working)
  await vi.advanceTimersByTimeAsync(0)
  await harness.replacePiSession('new')
  const before = harness.fetchMock.mock.calls.length

  restartOrca(harness, '5002', 'second')
  await vi.advanceTimersByTimeAsync(WATCH_MS * 3)
  expect(harness.fetchMock.mock.calls.length).toBe(before)
  expect(vi.getTimerCount()).toBe(0)
})

it('keeps watching a turn that a /reload re-registered', async () => {
  const harness = harnessWithEndpoint('5001', 'first')
  await harness.callHook('agent_start', {}, working)
  await harness.callHook('tool_execution_start', { toolName: 'bash' }, working)
  await vi.advanceTimersByTimeAsync(0)
  await harness.reloadPi()
  const before = harness.fetchMock.mock.calls.length

  restartOrca(harness, '5002', 'second')
  await vi.advanceTimersByTimeAsync(WATCH_MS)
  expect(harness.fetchMock.mock.calls.length).toBe(before + 1)
})

it('keeps the held-pane snapshot through a completion a queue reset promoted to final', async () => {
  const harness = harnessWithEndpoint('5001', 'first')
  startAsync(harness, 'run-1', 'reviewer')
  harness.fetchMock.mockRejectedValueOnce(new Error('Orca is going down'))
  await harness.callHook('agent_start', {}, idle)
  await harness.callHook('agent_settled', {}, idle)
  await vi.advanceTimersByTimeAsync(0)
  // Why: /reload promotes an undelivered completion to final, but that is not the session's end —
  // the children it reported still hold the pane.
  harness.fetchMock.mockResolvedValue({ ok: true })
  await harness.reloadPi()
  await vi.advanceTimersByTimeAsync(0)
  const before = harness.fetchMock.mock.calls.length

  restartOrca(harness, '5002', 'second')
  await vi.advanceTimersByTimeAsync(WATCH_MS)
  expect(harness.fetchMock.mock.calls.length).toBe(before + 1)
})

it('re-announces through the WSL curl bridge at the endpoint the host serves now', async () => {
  // Why: the fake curl is driven by hand, so the launch coordinates can fail the way a restarted
  // host's do and the endpoint file's can be the candidate that lands.
  const harness = harnessWithEndpoint('5001', 'first', {
    env: { WSL_DISTRO_NAME: 'Ubuntu' },
    curlExitCode: null
  })
  harness.fsMock.existsSync.mockImplementation((path: string) => path === WSL_CURL_PATH)
  harness.fetchMock.mockRejectedValue(new Error('WSL loopback is not the host loopback'))
  await harness.callHook('agent_start', {}, working)
  await vi.advanceTimersByTimeAsync(0)
  await resolveCurlCandidates(harness, 'http://127.0.0.1:5001/hook/pi', (ms) =>
    vi.advanceTimersByTimeAsync(ms)
  )
  expect(curlUrl(harness)).toBe('http://127.0.0.1:5001/hook/pi')

  // Why: one curl.exe per candidate, never one per tick — the attempt recorded this endpoint.
  const spawnsAfterTurnStart = harness.spawnMock.mock.calls.length
  await vi.advanceTimersByTimeAsync(WATCH_MS * 5)
  expect(harness.spawnMock.mock.calls.length).toBe(spawnsAfterTurnStart)

  restartOrca(harness, '5002', 'second')
  await vi.advanceTimersByTimeAsync(WATCH_MS)
  await resolveCurlCandidates(harness, 'http://127.0.0.1:5002/hook/pi', (ms) =>
    vi.advanceTimersByTimeAsync(ms)
  )
  expect(curlUrl(harness)).toBe('http://127.0.0.1:5002/hook/pi')
  expect(curlArgv(harness).join(' ')).toContain('X-Orca-Agent-Hook-Token: second')
})

it('starts the WSL bridge at the candidate that landed last', async () => {
  const harness = harnessWithEndpoint('5001', 'first', {
    env: { WSL_DISTRO_NAME: 'Ubuntu' },
    curlExitCode: null
  })
  harness.fsMock.existsSync.mockImplementation((path: string) => path === WSL_CURL_PATH)
  harness.fetchMock.mockRejectedValue(new Error('WSL loopback is not the host loopback'))
  await harness.callHook('agent_start', {}, working)
  await vi.advanceTimersByTimeAsync(0)
  await resolveCurlCandidates(harness, 'http://127.0.0.1:5001/hook/pi', (ms) =>
    vi.advanceTimersByTimeAsync(ms)
  )

  // Why: the dead launch port must not be re-tried on every later post.
  await harness.callHook('tool_execution_start', { toolName: 'grep' }, working)
  await vi.advanceTimersByTimeAsync(0)
  expect(curlUrl(harness)).toBe('http://127.0.0.1:5001/hook/pi')
})
