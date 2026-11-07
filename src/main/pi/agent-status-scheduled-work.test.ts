import type { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { normalizeHookPayload } from '../../shared/agent-hook-listener'
import type { ParsedAgentStatusPayload } from '../../shared/agent-status-types'
import { PANE_KEY } from '../../shared/agent-hook-listener-test-harness'
import {
  createHookListenerState,
  seedLegacyAgentStatusForTests
} from '../../shared/agent-hook-listener/listener-state'
import {
  createAgentStatusExtensionHarness,
  type HookContext
} from './agent-status-extension-test-harness'

const HOOK_ENV = { ORCA_PANE_KEY: PANE_KEY, ORCA_AGENT_HOOK_ENV: 'production' }
const LIVE_LIST = 'loop:rpc:schedules:list'
const COLD_LIST = 'subagents:rpc:schedules:list'
const SCHEDULED_EVENT = 'subagents:scheduled'
const SCHEDULER_READY = 'subagents:scheduler_ready'

/** A live `/loop` job as the loop extension lists it. */
type LiveJob = {
  id: string
  prompt: string
  mode: 'fixed' | 'dynamic'
  nextAt?: number
  runs: number
}

/** A cold scheduler job as pi-subagents lists it. */
type ColdJob = { id: string; schedule: string; prompt: string; enabled: boolean; nextRun?: string }

/** The two extensions `/loop` sits on, answering their list channels on the session bus. */
type Inventory = { live: LiveJob[]; cold: ColdJob[] }

/** The request id an RPC channel carries, without asserting on the payload a peer sent. */
function requestIdOf(raw: unknown): string | undefined {
  if (!isRecord(raw)) {
    return undefined
  }
  const value = raw['requestId']
  return typeof value === 'string' ? value : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function serveSchedules(emitter: EventEmitter, inventory: Inventory) {
  emitter.on(LIVE_LIST, (raw) => {
    const requestId = requestIdOf(raw)
    if (!requestId) {
      return
    }
    emitter.emit(`${LIVE_LIST}:reply:${requestId}`, {
      success: true,
      data: { jobs: inventory.live }
    })
  })
  emitter.on(COLD_LIST, (raw) => {
    const requestId = requestIdOf(raw)
    if (!requestId) {
      return
    }
    emitter.emit(`${COLD_LIST}:reply:${requestId}`, {
      success: true,
      data: { jobs: inventory.cold }
    })
  })
}

/** Drives the REAL generated extension into the REAL listener, so the row asserted here is the row a
 *  pi pane would show. */
function createHarness(
  options: { inventory?: { live: LiveJob[]; cold: ColdJob[] }; serve?: boolean } = {}
) {
  const state = createHookListenerState()
  const accepted: (ParsedAgentStatusPayload | undefined)[] = []
  const posted: Record<string, unknown>[] = []
  const inventory: Inventory = options.inventory ?? { live: [], cold: [] }
  const harness = createAgentStatusExtensionHarness({
    kind: 'pi',
    env: HOOK_ENV,
    ...(options.serve === false
      ? {}
      : { seedEventBus: (emitter: EventEmitter) => serveSchedules(emitter, inventory) }),
    fetchImpl: async (_url, init) => {
      const body: { payload?: Record<string, unknown> } = JSON.parse(String(init?.body))
      posted.push(body.payload ?? {})
      const event = normalizeHookPayload(state, 'pi', body, 'production')
      if (event) {
        seedLegacyAgentStatusForTests(state, event)
      }
      accepted.push(event?.payload)
      return { ok: true }
    }
  })
  return { ...harness, accepted, posted, inventory }
}

async function flush(): Promise<void> {
  // Why: `agent_end` defers through a 0ms idle recheck and the inventory update through another 0ms
  // tick, so a microtask flush would read the pane before either ran.
  for (let index = 0; index < 8; index++) {
    await vi.advanceTimersByTimeAsync(1)
  }
}

async function drive(
  harness: ReturnType<typeof createHarness>,
  name: string,
  event: unknown = {},
  context: HookContext = { isIdle: () => true }
): Promise<void> {
  await harness.callHook(name, event, context)
  await flush()
}

async function startTurn(harness: ReturnType<typeof createHarness>): Promise<void> {
  await drive(harness, 'session_start', { reason: 'startup' })
  await drive(harness, 'before_agent_start', { prompt: 'run the sweep' })
  await drive(harness, 'agent_start')
}

describe('pi scheduled work holds the pane as monitoring', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-11-02T12:00:00.000Z'))
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('holds a finished turn working + monitoring while a live loop is armed', async () => {
    const inventory: Inventory = { live: [], cold: [] }
    const harness = createHarness({ inventory })
    await startTurn(harness)
    inventory.live.push({
      id: 'loop-1',
      prompt: 'check the deploy',
      mode: 'fixed',
      nextAt: Date.now() + 300_000,
      runs: 0
    })

    await drive(harness, 'agent_end', {})

    expect(harness.posted.at(-1)?.scheduled_work).toEqual({
      jobs: [{ id: 'loop-1', kind: 'live', next_in_ms: 300_000 }]
    })
    expect(harness.accepted.at(-1)?.state).toBe('working')
    expect(harness.accepted.at(-1)?.workingMode).toBe('monitoring')
    // Why: the lead's own verdict the fold consumed, so a restatement can recover it.
    expect(harness.accepted.at(-1)?.mainAgent?.state).toBe('done')
    expect(harness.accepted.at(-1)?.mainAgent?.stateStartedAt).toBeTypeOf('number')
  })

  it('holds a self-paced loop that has no armed wakeup yet', async () => {
    const inventory: Inventory = { live: [], cold: [] }
    const harness = createHarness({ inventory })
    await startTurn(harness)
    // Why: a dynamic loop mid-turn is present without `nextAt`; presence, not a deadline, is the signal.
    inventory.live.push({ id: 'loop-d', prompt: 'keep watching', mode: 'dynamic', runs: 1 })

    await drive(harness, 'agent_end', {})

    expect(harness.posted.at(-1)?.scheduled_work).toEqual({
      jobs: [{ id: 'loop-d', kind: 'live' }]
    })
    expect(harness.accepted.at(-1)?.state).toBe('working')
    expect(harness.accepted.at(-1)?.workingMode).toBe('monitoring')
  })

  it('holds while a cold scheduler job is enabled, and ignores a paused one', async () => {
    const inventory: Inventory = { live: [], cold: [] }
    const harness = createHarness({ inventory })
    await startTurn(harness)
    inventory.cold.push({
      id: 'cold-1',
      schedule: 'every 1h',
      prompt: 'sweep the queue',
      enabled: true,
      nextRun: new Date(Date.now() + 3_600_000).toISOString()
    })

    await drive(harness, 'agent_end', {})
    expect(harness.accepted.at(-1)?.workingMode).toBe('monitoring')
    expect(harness.posted.at(-1)?.scheduled_work).toEqual({
      jobs: [{ id: 'cold-1', kind: 'cold', next_in_ms: 3_600_000 }]
    })

    inventory.cold[0].enabled = false
    await drive(harness, 'before_agent_start', { prompt: 'again' })
    await drive(harness, 'agent_start')
    await drive(harness, 'agent_end', {})
    // Why: a paused job will not fire, so it holds nothing.
    expect(harness.posted.at(-1)?.scheduled_work).toBeUndefined()
    expect(harness.accepted.at(-1)?.state).toBe('done')
  })

  it('settles to done once the last job is stopped, off the poll that no event announces', async () => {
    const inventory: Inventory = { live: [], cold: [] }
    const harness = createHarness({ inventory })
    await startTurn(harness)
    inventory.live.push({
      id: 'loop-1',
      prompt: 'check the deploy',
      mode: 'fixed',
      nextAt: Date.now() + 300_000,
      runs: 0
    })
    await drive(harness, 'agent_end', {})
    expect(harness.accepted.at(-1)?.workingMode).toBe('monitoring')

    // Why: `/loop stop` and a TTL expiry publish nothing, so only the re-check can notice them.
    inventory.live.length = 0
    await vi.advanceTimersByTimeAsync(60_000)
    await flush()

    expect(harness.accepted.at(-1)?.state).toBe('done')
    expect(harness.accepted.at(-1)?.workingMode).toBeUndefined()
    // Why: the restatement drops the hold's mainAgent, so the row is exactly what it was before the hold.
    expect(harness.accepted.at(-1)?.mainAgent).toBeUndefined()
  })

  it('re-checks as soon as a scheduler event says the inventory moved', async () => {
    const inventory: Inventory = { live: [], cold: [] }
    const harness = createHarness({ inventory })
    await startTurn(harness)
    inventory.cold.push({
      id: 'cold-1',
      schedule: 'every 1h',
      prompt: 'sweep the queue',
      enabled: true,
      nextRun: new Date(Date.now() + 3_600_000).toISOString()
    })
    await drive(harness, 'agent_end', {})
    expect(harness.accepted.at(-1)?.workingMode).toBe('monitoring')

    inventory.cold.length = 0
    harness.emitPiEvent(SCHEDULED_EVENT, { type: 'removed', jobId: 'cold-1' })
    await flush()

    expect(harness.accepted.at(-1)?.state).toBe('done')
  })

  it('refreshes on the scheduler-ready handshake without a turn', async () => {
    const inventory: Inventory = { live: [], cold: [] }
    const harness = createHarness({ inventory })
    await startTurn(harness)
    await drive(harness, 'agent_end', {})
    expect(harness.accepted.at(-1)?.state).toBe('done')

    inventory.cold.push({
      id: 'cold-restored',
      schedule: 'every 30m',
      prompt: 'resumed job',
      enabled: true,
      nextRun: new Date(Date.now() + 1_800_000).toISOString()
    })
    harness.emitPiEvent(SCHEDULER_READY, {})
    await flush()

    expect(harness.accepted.at(-1)?.state).toBe('working')
    expect(harness.accepted.at(-1)?.workingMode).toBe('monitoring')
  })

  it('reads exactly as today when no extension answers the inventory', async () => {
    const harness = createHarness({ serve: false })
    await startTurn(harness)
    await drive(harness, 'agent_end', {})

    // Why: fail-safe, not fail-active — a build that serves neither channel earns no hold at all.
    expect(harness.posted.at(-1)?.scheduled_work).toBeUndefined()
    expect(harness.accepted.at(-1)?.state).toBe('done')
    expect(harness.accepted.at(-1)?.workingMode).toBeUndefined()
  })

  it('never holds a session boundary row', async () => {
    const inventory: Inventory = { live: [], cold: [] }
    const harness = createHarness({ inventory })
    await startTurn(harness)
    inventory.live.push({
      id: 'loop-1',
      prompt: 'check the deploy',
      mode: 'fixed',
      nextAt: Date.now() + 300_000,
      runs: 0
    })
    await drive(harness, 'agent_end', {})
    expect(harness.accepted.at(-1)?.workingMode).toBe('monitoring')

    // Why: the session's loops do not come back with the next one, so the boundary row must settle.
    await drive(harness, 'session_shutdown', {})

    expect(harness.accepted.at(-1)?.state).toBe('done')
    expect(harness.accepted.at(-1)?.workingMode).toBeUndefined()
    expect(harness.posted.at(-1)?.scheduled_work).toBeUndefined()
  })

  it('keeps a live child as plain working, then settles to monitoring when it ends', async () => {
    const inventory: Inventory = { live: [], cold: [] }
    const harness = createHarness({ inventory })
    await startTurn(harness)
    harness.emitPiEvent('subagents:started', { id: 'run-1', type: 'researcher' })
    await flush()
    inventory.live.push({
      id: 'loop-1',
      prompt: 'check the deploy',
      mode: 'fixed',
      nextAt: Date.now() + 300_000,
      runs: 0
    })

    await drive(harness, 'agent_end', {})
    // Why: a running child is agent work, which outranks the monitor.
    expect(harness.accepted.at(-1)?.state).toBe('working')
    expect(harness.accepted.at(-1)?.workingMode).toBeUndefined()

    harness.emitPiEvent('subagents:completed', { id: 'run-1' })
    await drive(harness, 'agent_end', {})

    expect(harness.accepted.at(-1)?.state).toBe('working')
    expect(harness.accepted.at(-1)?.workingMode).toBe('monitoring')
  })
})
