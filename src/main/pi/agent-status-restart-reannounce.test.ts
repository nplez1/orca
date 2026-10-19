import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { createAgentStatusExtensionHarness } from './agent-status-extension-test-harness'
import {
  complete,
  postedSubagentRunIds,
  posts,
  startAsync,
  startChild,
  startWorkflow
} from './agent-status-subagent-event-fixtures'
import { harnessWithEndpoint, restartOrca, WATCH_MS, working } from './agent-status-restart-harness'

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

const idle = { isIdle: () => true }

function deliveredUrl(harness: ReturnType<typeof harnessWithEndpoint>): string | undefined {
  return harness.fetchMock.mock.calls.at(-1)?.[0]?.toString()
}

function deliveredTokens(harness: ReturnType<typeof harnessWithEndpoint>): string[] {
  return harness.fetchMock.mock.calls.map(
    (call) => new Headers(call[1]?.headers).get('X-Orca-Agent-Hook-Token') ?? ''
  )
}

it('republishes the work in flight at the endpoint a restarted Orca serves', async () => {
  const harness = harnessWithEndpoint('5001', 'first')
  await harness.callHook('agent_start', {}, working)
  await harness.callHook('tool_execution_start', { toolName: 'bash' }, working)
  await vi.advanceTimersByTimeAsync(0)
  expect(deliveredUrl(harness)).toBe('http://127.0.0.1:5001/hook/pi')
  const before = harness.fetchMock.mock.calls.length

  restartOrca(harness, '5002', 'second')
  await vi.advanceTimersByTimeAsync(WATCH_MS)

  // Why: the tool call can outlive the restart, so nothing else would tell Orca this pane is working.
  expect(harness.fetchMock.mock.calls.length).toBe(before + 1)
  expect(deliveredUrl(harness)).toBe('http://127.0.0.1:5002/hook/pi')
  expect(deliveredTokens(harness).at(-1)).toBe('second')
  expect(posts(harness).at(-1)).toMatchObject({
    hook_event_name: 'tool_execution_start',
    tool_name: 'bash'
  })
})

it('re-announces once per restart, not on every tick', async () => {
  const harness = harnessWithEndpoint('5001', 'first')
  await harness.callHook('agent_start', {}, working)
  await vi.advanceTimersByTimeAsync(0)
  const before = harness.fetchMock.mock.calls.length

  await vi.advanceTimersByTimeAsync(WATCH_MS * 5)
  expect(harness.fetchMock.mock.calls.length).toBe(before)

  restartOrca(harness, '5002', 'second')
  await vi.advanceTimersByTimeAsync(WATCH_MS * 5)
  expect(harness.fetchMock.mock.calls.length).toBe(before + 1)
})

it('adds no further attempts at an endpoint that never changed', async () => {
  // Why: the WSL curl bridge and a host that answers 404 (hooks disabled) must not turn one turn
  // into a POST every tick — the watch only re-announces to an endpoint it has not tried.
  const harness = harnessWithEndpoint('5001', 'first')
  harness.fetchMock.mockRejectedValue(new Error('ECONNREFUSED'))
  await harness.callHook('agent_start', {}, working)
  await vi.advanceTimersByTimeAsync(0)
  const before = harness.fetchMock.mock.calls.length
  await vi.advanceTimersByTimeAsync(WATCH_MS * 5)
  expect(harness.fetchMock.mock.calls.length).toBe(before)

  // A restart is a new endpoint, so the state Orca restored gets one more chance to be corrected.
  restartOrca(harness, '5002', 'second')
  await vi.advanceTimersByTimeAsync(WATCH_MS)
  expect(harness.fetchMock.mock.calls.length).toBe(before + 1)
})

it('republishes a prompt-bearing snapshot as the turn start it already counted', async () => {
  const harness = harnessWithEndpoint('5001', 'first')
  await harness.callHook('before_agent_start', { prompt: 'do the thing' }, working)
  await vi.advanceTimersByTimeAsync(0)

  restartOrca(harness, '5002', 'second')
  await vi.advanceTimersByTimeAsync(WATCH_MS)

  // Why: the prompt was submitted to the Orca that had it; counting it again would fake a new turn.
  expect(posts(harness).at(-1)).toMatchObject({ hook_event_name: 'agent_start' })
  expect(posts(harness).at(-1)?.prompt).toBeUndefined()
})

it('stops watching once the turn completes, so an idle pane arms no timer', async () => {
  const harness = harnessWithEndpoint('5001', 'first')
  await harness.callHook('agent_start', {}, idle)
  await vi.advanceTimersByTimeAsync(0)
  await harness.callHook('agent_settled', {}, idle)
  await vi.advanceTimersByTimeAsync(0)
  expect(posts(harness).at(-1)).toMatchObject({ hook_event_name: 'agent_end' })
  const before = harness.fetchMock.mock.calls.length

  restartOrca(harness, '5002', 'second')
  await vi.advanceTimersByTimeAsync(WATCH_MS * 5)
  expect(harness.fetchMock.mock.calls.length).toBe(before)
  expect(vi.getTimerCount()).toBe(0)
})

it('keeps watching while an async child holds the pane after its own turn ended', async () => {
  const harness = harnessWithEndpoint('5001', 'first')
  startAsync(harness, 'run-1', 'reviewer')
  await harness.callHook('agent_start', {}, idle)
  await harness.callHook('agent_settled', {}, idle)
  await vi.advanceTimersByTimeAsync(0)
  expect(posts(harness).at(-1)).toMatchObject({ hook_event_name: 'agent_end' })
  const before = harness.fetchMock.mock.calls.length

  restartOrca(harness, '5002', 'second')
  await vi.advanceTimersByTimeAsync(WATCH_MS)
  expect(harness.fetchMock.mock.calls.length).toBe(before + 1)
})

it('stops watching once the last child finishes, leaving no timer on an idle pane', async () => {
  const harness = harnessWithEndpoint('5001', 'first')
  startAsync(harness, 'run-1', 'reviewer')
  await harness.callHook('agent_start', {}, idle)
  await harness.callHook('agent_settled', {}, idle)
  await vi.advanceTimersByTimeAsync(0)
  complete(harness, 'run-1')
  await vi.advanceTimersByTimeAsync(0)
  const before = harness.fetchMock.mock.calls.length

  restartOrca(harness, '5002', 'second')
  await vi.advanceTimersByTimeAsync(WATCH_MS * 3)
  expect(harness.fetchMock.mock.calls.length).toBe(before)
  expect(vi.getTimerCount()).toBe(0)
})

it('watches a turn whose start was coalesced away behind a stalled completion', async () => {
  const harness = harnessWithEndpoint('5001', 'first')
  await harness.callHook('agent_start', {}, idle)
  await vi.advanceTimersByTimeAsync(0)
  // Why: an Orca that is shutting down stalls the completion's fetch, so the next turn's start and
  // its first tool event collapse into one attempt — the watch still has to know the turn began.
  let releaseCompletion: (() => void) | undefined
  harness.fetchMock.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        releaseCompletion = () => resolve({ ok: true })
      })
  )
  await harness.callHook('agent_settled', {}, idle)
  await harness.callHook('before_agent_start', { prompt: 'next' }, working)
  await harness.callHook('agent_start', {}, working)
  await harness.callHook('tool_execution_start', { toolName: 'bash' }, working)
  releaseCompletion?.()
  await vi.advanceTimersByTimeAsync(0)
  const before = harness.fetchMock.mock.calls.length

  restartOrca(harness, '5002', 'second')
  await vi.advanceTimersByTimeAsync(WATCH_MS)
  expect(harness.fetchMock.mock.calls.length).toBe(before + 1)
})

it('carries a held pane’s child roster into the republished snapshot', async () => {
  const harness = harnessWithEndpoint('5001', 'first')
  startWorkflow(harness)
  startChild(harness, 'child-a')
  await harness.callHook('agent_start', {}, idle)
  await harness.callHook('agent_settled', {}, idle)
  await vi.advanceTimersByTimeAsync(0)

  restartOrca(harness, '5002', 'second')
  await vi.advanceTimersByTimeAsync(WATCH_MS)
  // Why: the receiver rebuilds its hold from this roster, so a snapshot without it would settle.
  expect(postedSubagentRunIds(harness).at(-1)).toContain('child-a')
})

it.each(['omp', 'prime-agent'] as const)(
  're-announces from a %s pane whose queue is not the shared one',
  async (kind) => {
    const harness = createAgentStatusExtensionHarness({
      kind,
      env: { ORCA_AGENT_HOOK_ENDPOINT: '/orca-np/agent-hooks/endpoint.env' },
      statSync: () => ({ mtimeMs: 1, size: 100, ino: 1 }),
      readFileSync: () => 'ORCA_AGENT_HOOK_PORT=5001\nORCA_AGENT_HOOK_TOKEN=first\n',
      fetchImpl: async () => ({ ok: true })
    })
    await harness.callHook('agent_start', {}, working)
    await vi.advanceTimersByTimeAsync(0)
    const before = harness.fetchMock.mock.calls.length

    restartOrca(harness, '5002', 'second')
    await vi.advanceTimersByTimeAsync(WATCH_MS)
    expect(harness.fetchMock.mock.calls.length).toBe(before + 1)
    expect(deliveredUrl(harness)).toContain(':5002')
  }
)
