import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { createAgentStatusExtensionHarness } from './agent-status-extension-test-harness'
import { posts, startChild, startWorkflow } from './agent-status-subagent-event-fixtures'

// Why: Orca mints a new hook token (and usually a new port) on every start, so a restarted Orca is
// an endpoint change to the agent already running in the pane it restored that agent's row from.
const ENDPOINT_FILE = '/orca-np/agent-hooks/endpoint.env'
const WATCH_MS = 2000

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

function endpointFile(port: string, token: string): string {
  return [
    `ORCA_AGENT_HOOK_PORT=${port}`,
    `ORCA_AGENT_HOOK_TOKEN=${token}`,
    'ORCA_AGENT_HOOK_ENV=production',
    'ORCA_AGENT_HOOK_VERSION=1'
  ].join('\n')
}

/** A harness whose hook endpoint is served from the on-disk file, as a real pane's env points it there. */
function harnessWithEndpoint(port: string, token: string) {
  const harness = createAgentStatusExtensionHarness({
    kind: 'pi',
    env: { ORCA_AGENT_HOOK_ENDPOINT: ENDPOINT_FILE },
    statSync: () => ({ mtimeMs: 1, size: 100, ino: 1 }),
    readFileSync: () => endpointFile(port, token)
  })
  return harness
}

/** Rewrite the endpoint file the way a restarted Orca does: same path, new identity. */
function restartOrca(
  harness: ReturnType<typeof harnessWithEndpoint>,
  port: string,
  token: string,
  statKey = 2
): void {
  harness.fsMock.statSync.mockImplementation(() => ({
    mtimeMs: statKey,
    size: 100 + statKey,
    ino: statKey
  }))
  harness.fsMock.readFileSync.mockImplementation(() => endpointFile(port, token))
}

function deliveredUrls(harness: ReturnType<typeof harnessWithEndpoint>): string[] {
  return harness.fetchMock.mock.calls.map((call) => String(call[0]))
}

function deliveredTokens(harness: ReturnType<typeof harnessWithEndpoint>): string[] {
  return harness.fetchMock.mock.calls.map(
    (call) => new Headers(call[1]?.headers).get('X-Orca-Agent-Hook-Token') ?? ''
  )
}

it('republishes the work in flight at the endpoint a restarted Orca serves', async () => {
  const harness = harnessWithEndpoint('5001', 'first')
  const ctx = { isIdle: () => false }
  await harness.callHook('agent_start', {}, ctx)
  await harness.callHook('tool_execution_start', { toolName: 'bash' }, ctx)
  await vi.advanceTimersByTimeAsync(0)
  expect(deliveredUrls(harness).at(-1)).toBe('http://127.0.0.1:5001/hook/pi')
  const before = harness.fetchMock.mock.calls.length

  restartOrca(harness, '5002', 'second')
  await vi.advanceTimersByTimeAsync(WATCH_MS)

  // Why: the tool call can outlive the restart, so nothing else would tell Orca this pane is working.
  expect(harness.fetchMock.mock.calls.length).toBe(before + 1)
  expect(deliveredUrls(harness).at(-1)).toBe('http://127.0.0.1:5002/hook/pi')
  expect(deliveredTokens(harness).at(-1)).toBe('second')
  expect(posts(harness).at(-1)).toMatchObject({
    hook_event_name: 'tool_execution_start',
    tool_name: 'bash'
  })
})

it('re-announces once per restart, not on every tick', async () => {
  const harness = harnessWithEndpoint('5001', 'first')
  await harness.callHook('agent_start', {}, { isIdle: () => false })
  await vi.advanceTimersByTimeAsync(0)
  const before = harness.fetchMock.mock.calls.length

  await vi.advanceTimersByTimeAsync(WATCH_MS * 5)
  expect(harness.fetchMock.mock.calls.length).toBe(before)

  restartOrca(harness, '5002', 'second')
  await vi.advanceTimersByTimeAsync(WATCH_MS * 5)
  expect(harness.fetchMock.mock.calls.length).toBe(before + 1)
})

it('keeps trying while Orca is down, then reports when it answers', async () => {
  const harness = harnessWithEndpoint('5001', 'first')
  harness.fetchMock.mockRejectedValue(new Error('ECONNREFUSED'))
  await harness.callHook('agent_start', {}, { isIdle: () => false })
  await vi.advanceTimersByTimeAsync(0)
  expect(harness.fetchMock).toHaveBeenCalled()

  // Why: the pane's row was restored from disk, but nothing on this side ever landed, so the last
  // known state has to keep being offered until an Orca accepts it.
  restartOrca(harness, '5002', 'second')
  harness.fetchMock.mockResolvedValue({ ok: true })
  const attemptsBefore = harness.fetchMock.mock.calls.length
  await vi.advanceTimersByTimeAsync(WATCH_MS)
  expect(harness.fetchMock.mock.calls.length).toBe(attemptsBefore + 1)
  const delivered = harness.fetchMock.mock.calls.length
  await vi.advanceTimersByTimeAsync(WATCH_MS * 5)
  expect(harness.fetchMock.mock.calls.length).toBe(delivered)
})

it('stops watching once the turn completes, so an idle pane arms no timer', async () => {
  const harness = harnessWithEndpoint('5001', 'first')
  const ctx = { isIdle: () => true }
  await harness.callHook('agent_start', {}, ctx)
  await vi.advanceTimersByTimeAsync(0)
  await harness.callHook('agent_settled', {}, ctx)
  await vi.advanceTimersByTimeAsync(0)
  expect(posts(harness).at(-1)).toMatchObject({ hook_event_name: 'agent_end' })
  const before = harness.fetchMock.mock.calls.length

  restartOrca(harness, '5002', 'second')
  await vi.advanceTimersByTimeAsync(WATCH_MS * 5)
  expect(harness.fetchMock.mock.calls.length).toBe(before)
  expect(vi.getTimerCount()).toBe(0)
})

it('keeps watching while a child still holds the pane', async () => {
  const harness = harnessWithEndpoint('5001', 'first')
  const ctx = { isIdle: () => true }
  startWorkflow(harness)
  startChild(harness, 'child-a')
  await harness.callHook('agent_start', {}, ctx)
  await vi.advanceTimersByTimeAsync(0)
  await harness.callHook('agent_settled', {}, ctx)
  await vi.advanceTimersByTimeAsync(0)
  // Why: this fork folds the child roster receiver-side, so the lead posts its own agent_end while
  // the child works and the pane still reads working — a restart is still silently invalidating it.
  expect(posts(harness).at(-1)).toMatchObject({ hook_event_name: 'agent_end' })
  const before = harness.fetchMock.mock.calls.length

  restartOrca(harness, '5002', 'second')
  await vi.advanceTimersByTimeAsync(WATCH_MS)
  expect(harness.fetchMock.mock.calls.length).toBe(before + 1)
})
