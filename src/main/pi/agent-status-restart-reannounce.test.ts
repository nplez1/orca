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

// Why: Orca mints a new hook token (and usually a new port) on every start, so a restarted Orca is
// an endpoint change to the agent already running in the pane it restored that agent's row from.
const ENDPOINT_FILE = '/orca-np/agent-hooks/endpoint.env'
const WATCH_MS = 2000
const WSL_CURL_PATH = '/mnt/c/Windows/System32/curl.exe'

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
function harnessWithEndpoint(
  port: string,
  token: string,
  extra: { env?: Record<string, string>; curlExitCode?: number | null } = {}
) {
  return createAgentStatusExtensionHarness({
    kind: 'pi',
    env: { ORCA_AGENT_HOOK_ENDPOINT: ENDPOINT_FILE, ...extra.env },
    ...(extra.curlExitCode !== undefined ? { curlExitCode: extra.curlExitCode } : {}),
    statSync: () => ({ mtimeMs: 1, size: 100, ino: 1 }),
    readFileSync: () => endpointFile(port, token)
  })
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

function deliveredUrl(harness: ReturnType<typeof harnessWithEndpoint>): string | undefined {
  return harness.fetchMock.mock.calls.at(-1)?.[0]?.toString()
}

/** The argv of the last curl.exe the WSL bridge spawned. */
function curlArgv(harness: ReturnType<typeof harnessWithEndpoint>): string[] {
  const argv: unknown = harness.spawnMock.mock.calls.at(-1)?.[1]
  return Array.isArray(argv) ? argv.filter((arg): arg is string => typeof arg === 'string') : []
}

function curlUrl(harness: ReturnType<typeof harnessWithEndpoint>): string | undefined {
  return curlArgv(harness).findLast((arg) => arg.startsWith('http://'))
}

function deliveredTokens(harness: ReturnType<typeof harnessWithEndpoint>): string[] {
  return harness.fetchMock.mock.calls.map(
    (call) => new Headers(call[1]?.headers).get('X-Orca-Agent-Hook-Token') ?? ''
  )
}

const working = { isIdle: () => false }
const idle = { isIdle: () => true }

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
  harness.emitPiEvent('subagent:process-terminal', { runId: 'runner-1', state: 'observed' })
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

it('is not stopped by an in-process child agent registering itself mid-turn', async () => {
  const harness = harnessWithEndpoint('5001', 'first')
  await harness.callHook('agent_start', {}, working)
  await harness.callHook('tool_execution_start', { toolName: 'task' }, working)
  await vi.advanceTimersByTimeAsync(0)
  // Why: pi-subagents and OMP task children re-run the factory in this same process, which used to
  // reset the pane's delivery state — the lead is inside its tool call and cannot re-arm it.
  const child = harness.registerTaskChild()
  await child.callHook('session_start', {}, { sessionManager: { getSessionId: () => 'child-1' } })
  await child.callHook('agent_start')
  await vi.advanceTimersByTimeAsync(0)
  const before = harness.fetchMock.mock.calls.length

  restartOrca(harness, '5002', 'second')
  await vi.advanceTimersByTimeAsync(WATCH_MS)
  expect(harness.fetchMock.mock.calls.length).toBe(before + 1)
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

  expect(curlUrl(harness)).toBe('http://127.0.0.1:4321/hook/pi')
  harness.spawnedChildren[0]?.emit('close', 7)
  await vi.advanceTimersByTimeAsync(0)
  expect(curlUrl(harness)).toBe('http://127.0.0.1:5001/hook/pi')
  harness.spawnedChildren[1]?.emit('close', 0)
  await vi.advanceTimersByTimeAsync(0)

  // Why: one curl.exe per candidate, never one per tick — the attempt recorded this endpoint.
  const spawnsAfterTurnStart = harness.spawnMock.mock.calls.length
  await vi.advanceTimersByTimeAsync(WATCH_MS * 5)
  expect(harness.spawnMock.mock.calls.length).toBe(spawnsAfterTurnStart)

  restartOrca(harness, '5002', 'second')
  await vi.advanceTimersByTimeAsync(WATCH_MS)
  expect(curlUrl(harness)).toBe('http://127.0.0.1:4321/hook/pi')
  harness.spawnedChildren.at(-1)?.emit('close', 7)
  await vi.advanceTimersByTimeAsync(0)
  expect(curlUrl(harness)).toBe('http://127.0.0.1:5002/hook/pi')
  expect(curlArgv(harness).join(' ')).toContain('X-Orca-Agent-Hook-Token: second')
})

it.each(['omp', 'prime-agent'] as const)(
  're-announces from a %s pane whose queue is not the shared one',
  async (kind) => {
    const harness = createAgentStatusExtensionHarness({
      kind,
      env: { ORCA_AGENT_HOOK_ENDPOINT: ENDPOINT_FILE },
      statSync: () => ({ mtimeMs: 1, size: 100, ino: 1 }),
      readFileSync: () => endpointFile('5001', 'first')
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
