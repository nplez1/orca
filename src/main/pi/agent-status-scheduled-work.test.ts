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

type Inventory = { live: LiveJob[]; cold: ColdJob[] }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** The request id an RPC channel carries, without asserting on the payload a peer sent. */
function requestIdOf(raw: unknown): string | undefined {
  if (!isRecord(raw)) {
    return undefined
  }
  const value = raw['requestId']
  return typeof value === 'string' ? value : undefined
}

/** What the two extensions `/loop` sits on do: answer their list channels on the session bus. */
function serveSchedules(
  emitter: EventEmitter,
  inventory: Inventory,
  state: { serving: boolean; replyAsync: boolean }
) {
  // Why the field name and not the array: a test swaps the inventory wholesale, and a captured array
  // would keep answering with the one it was bound to.
  const answer = (channel: string, field: keyof Inventory) => (raw: unknown) => {
    if (!state.serving) {
      return
    }
    const requestId = requestIdOf(raw)
    if (!requestId) {
      return
    }
    const reply = { success: true, data: { jobs: inventory[field] } }
    if (state.replyAsync) {
      // Why: pi-subagents awaits its handler, so its list reply lands after the post that asked.
      void Promise.resolve().then(() => emitter.emit(`${channel}:reply:${requestId}`, reply))
      return
    }
    emitter.emit(`${channel}:reply:${requestId}`, reply)
  }
  emitter.on(LIVE_LIST, answer(LIVE_LIST, 'live'))
  emitter.on(COLD_LIST, answer(COLD_LIST, 'cold'))
}

/** Drives the REAL generated extension into the REAL listener, so the row asserted here is the row a
 *  pi pane would show. */
function createHarness(
  options: { inventory?: Inventory; serve?: boolean; replyAsync?: boolean } = {}
) {
  const state = createHookListenerState()
  const accepted: (ParsedAgentStatusPayload | undefined)[] = []
  const posted: Record<string, unknown>[] = []
  const inventory: Inventory = options.inventory ?? { live: [], cold: [] }
  const serving = { serving: options.serve !== false, replyAsync: options.replyAsync === true }
  // Why: a test can hold a delivery open to prove what a post in flight does to the inventory.
  let deliveryGate: Promise<void> | null = null
  const harness = createAgentStatusExtensionHarness({
    kind: 'pi',
    env: HOOK_ENV,
    seedEventBus: (emitter: EventEmitter) => serveSchedules(emitter, inventory, serving),
    fetchImpl: async (_url, init) => {
      if (deliveryGate) {
        await deliveryGate
      }
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
  return {
    ...harness,
    accepted,
    posted,
    inventory,
    serving,
    holdDelivery: (gate: Promise<void>) => {
      deliveryGate = gate
    },
    releaseDelivery: () => {
      deliveryGate = null
    }
  }
}

async function flush(): Promise<void> {
  // Why: `agent_end` defers through a 0ms idle recheck and the inventory update through another 0ms
  // tick, so a microtask flush would read the pane before either ran.
  for (let index = 0; index < 8; index++) {
    await vi.advanceTimersByTimeAsync(1)
  }
}

/** A session the extension can name, so the ownership fence can tell the lead from its children. */
function leadContext(): HookContext {
  return {
    isIdle: () => true,
    sessionManager: {
      getSessionId: () => 'lead-session',
      getSessionFile: () => '/sessions/lead.jsonl'
    }
  }
}

async function drive(
  harness: ReturnType<typeof createHarness>,
  name: string,
  event: unknown = {},
  context: HookContext = leadContext()
): Promise<void> {
  await harness.callHook(name, event, context)
  await flush()
}

async function startTurn(harness: ReturnType<typeof createHarness>): Promise<void> {
  await drive(harness, 'session_start', { reason: 'startup' })
  await drive(harness, 'before_agent_start', { prompt: 'run the sweep' })
  await drive(harness, 'agent_start')
}

function liveLoop(overrides: Partial<LiveJob> = {}): LiveJob {
  return {
    id: 'loop-1',
    prompt: 'check the deploy',
    mode: 'fixed',
    nextAt: Date.now() + 300_000,
    runs: 0,
    ...overrides
  }
}

function coldJob(overrides: Partial<ColdJob> = {}): ColdJob {
  return {
    id: 'cold-1',
    schedule: 'every 1h',
    prompt: 'sweep the queue',
    enabled: true,
    nextRun: new Date(Date.now() + 3_600_000).toISOString(),
    ...overrides
  }
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
    inventory.live.push(liveLoop())

    await drive(harness, 'agent_end', {})

    expect(harness.posted.at(-1)?.scheduled_work).toEqual({
      jobs: [{ id: 'loop-1', kind: 'live', next_in_ms: 300_000 }]
    })
    expect(harness.accepted.at(-1)?.state).toBe('working')
    expect(harness.accepted.at(-1)?.workingMode).toBe('monitoring')
    // Why: the lead's own verdict the fold consumed, so a restatement can recover it.
    expect(harness.accepted.at(-1)?.mainAgent?.state).toBe('done')
  })

  it('holds a self-paced loop that has no armed wakeup yet', async () => {
    const inventory: Inventory = { live: [], cold: [] }
    const harness = createHarness({ inventory })
    await startTurn(harness)
    // Why: a dynamic loop mid-turn is present without `nextAt`; presence, not a deadline, is the signal.
    inventory.live.push(liveLoop({ id: 'loop-d', mode: 'dynamic', nextAt: undefined }))

    await drive(harness, 'agent_end', {})

    expect(harness.posted.at(-1)?.scheduled_work).toEqual({
      jobs: [{ id: 'loop-d', kind: 'live' }]
    })
    expect(harness.accepted.at(-1)?.workingMode).toBe('monitoring')
  })

  it('holds while a cold scheduler job is enabled, and ignores a paused one', async () => {
    const inventory: Inventory = { live: [], cold: [] }
    const harness = createHarness({ inventory })
    await startTurn(harness)
    inventory.cold.push(coldJob())

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
    inventory.live.push(liveLoop())
    await drive(harness, 'agent_end', {})
    expect(harness.accepted.at(-1)?.workingMode).toBe('monitoring')

    // Why: `/loop stop` and a TTL expiry publish nothing, so only the re-check can notice them.
    inventory.live.length = 0
    await vi.advanceTimersByTimeAsync(60_000)
    await flush()

    expect(harness.accepted.at(-1)?.state).toBe('done')
    expect(harness.accepted.at(-1)?.workingMode).toBeUndefined()
    // Why: the restatement drops the hold's mainAgent, so the row is what it was before the hold.
    expect(harness.accepted.at(-1)?.mainAgent).toBeUndefined()
  })

  it('stops believing an inventory whose channel stopped answering', async () => {
    const inventory: Inventory = { live: [], cold: [] }
    const harness = createHarness({ inventory })
    await startTurn(harness)
    inventory.live.push(liveLoop())
    await drive(harness, 'agent_end', {})
    expect(harness.accepted.at(-1)?.workingMode).toBe('monitoring')

    // Why: the extension was unloaded mid-session. One unanswered ask is a race; two mean nobody serves
    // the channel, and the hold must not outlive the evidence that produced it.
    harness.serving.serving = false
    await vi.advanceTimersByTimeAsync(120_000)
    await flush()

    expect(harness.accepted.at(-1)?.state).toBe('done')
  })

  it('re-checks as soon as a scheduler event says the inventory moved', async () => {
    const inventory: Inventory = { live: [], cold: [] }
    const harness = createHarness({ inventory })
    await startTurn(harness)
    inventory.cold.push(coldJob())
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

    inventory.cold.push(coldJob({ id: 'cold-restored' }))
    harness.emitPiEvent(SCHEDULER_READY, {})
    await flush()

    expect(harness.accepted.at(-1)?.state).toBe('working')
    expect(harness.accepted.at(-1)?.workingMode).toBe('monitoring')
  })

  it('publishes a change that landed while a post was already in flight', async () => {
    const inventory: Inventory = { live: [], cold: [] }
    const harness = createHarness({ inventory })
    await startTurn(harness)
    inventory.cold.push(coldJob())
    await drive(harness, 'agent_end', {})
    expect(harness.accepted.at(-1)?.workingMode).toBe('monitoring')

    // Why a held delivery: the update's body is built while `cold-2` is still armed, so only a later
    // attempt can publish the removal that lands behind it.
    let open: () => void = () => undefined
    harness.holdDelivery(
      new Promise<void>((resolve) => {
        open = resolve
      })
    )
    inventory.cold = [coldJob({ id: 'cold-2' })]
    harness.emitPiEvent(SCHEDULED_EVENT, { type: 'updated', job: coldJob({ id: 'cold-2' }) })
    await flush()

    inventory.cold = []
    harness.emitPiEvent(SCHEDULED_EVENT, { type: 'removed', jobId: 'cold-2' })
    await flush()
    harness.releaseDelivery()
    open()
    // Why past the retry interval: the flush that found a post in flight re-arms itself.
    await vi.advanceTimersByTimeAsync(1_000)
    await flush()

    // Why this order: the held body carried `cold-2`, and the retry is what clears it.
    expect(harness.posted.at(-2)?.scheduled_work).toEqual({
      jobs: [{ id: 'cold-2', kind: 'cold', next_in_ms: 3_600_000 }]
    })
    expect(harness.posted.at(-1)?.scheduled_work).toBeUndefined()
    expect(harness.accepted.at(-1)?.state).toBe('done')
  })

  it('retries the restatement when the change landed behind the completion itself', async () => {
    const inventory: Inventory = { live: [], cold: [] }
    const harness = createHarness({ inventory })
    await startTurn(harness)
    inventory.cold.push(coldJob())

    // Why: pi-subagents awaits its list handler, so its answer lands after the completion post that
    // asked — which is exactly when a post is already in flight.
    let open: () => void = () => undefined
    harness.holdDelivery(
      new Promise<void>((resolve) => {
        open = resolve
      })
    )
    void harness.callHook('agent_end', {}, leadContext())
    inventory.cold = []
    await flush()
    harness.releaseDelivery()
    open()
    await vi.advanceTimersByTimeAsync(1_000)
    await flush()

    expect(harness.accepted.at(-1)?.state).toBe('done')
    expect(harness.accepted.at(-1)?.workingMode).toBeUndefined()
  })

  it('reads exactly as today when no extension answers the inventory', async () => {
    const harness = createHarness({ serve: false })
    await startTurn(harness)
    await drive(harness, 'agent_end', {})

    // Why: fail-safe, not fail-active — a build that serves neither channel earns no hold at all.
    expect(harness.posted.at(-1)?.scheduled_work).toBeUndefined()
    expect(harness.accepted.at(-1)?.state).toBe('done')
    expect(harness.accepted.at(-1)?.workingMode).toBeUndefined()
    // Why: a turn end must arm nothing. A probe with no responder keeps one listener and no timer.
    expect(vi.getTimerCount()).toBe(0)
  })

  it('never lets an in-process subagent take the inventory bus away from the lead', async () => {
    const inventory: Inventory = { live: [], cold: [] }
    const harness = createHarness({ inventory })
    await startTurn(harness)
    inventory.live.push(liveLoop())
    await drive(harness, 'agent_end', {})
    expect(harness.accepted.at(-1)?.workingMode).toBe('monitoring')

    // Why: pi-subagents runs children in-process on their own bus and with the same pid, so the child's
    // registration reaches the same module state — and its bus serves no loops at all.
    const child = harness.registerTaskChild()
    await child.callHook(
      'session_start',
      { reason: 'startup' },
      {
        isIdle: () => true,
        sessionManager: {
          getSessionId: () => 'child-session',
          getSessionFile: () => '/sessions/child.jsonl'
        }
      }
    )
    await vi.advanceTimersByTimeAsync(60_000)
    await flush()

    expect(harness.accepted.at(-1)?.workingMode).toBe('monitoring')
  })

  it('never holds a session boundary row', async () => {
    const inventory: Inventory = { live: [], cold: [] }
    const harness = createHarness({ inventory })
    await startTurn(harness)
    inventory.live.push(liveLoop())
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
    // Why a self-paced loop: it carries no deadline, so the heartbeat below is the only thing keeping
    // the hold fresh — which is exactly the restatement the drain must not let pin the row.
    inventory.live.push(liveLoop({ id: 'loop-d', mode: 'dynamic', nextAt: undefined }))

    await drive(harness, 'agent_end', {})
    // Why: a running child is agent work, which outranks the monitor.
    expect(harness.accepted.at(-1)?.state).toBe('working')
    expect(harness.accepted.at(-1)?.workingMode).toBeUndefined()

    // Why the heartbeat: a restatement must not republish the child-gated `working` as the lead's own
    // verdict, or the drain below would never settle the row.
    await vi.advanceTimersByTimeAsync(11 * 60_000)
    harness.emitPiEvent('subagents:completed', { id: 'run-1' })
    await drive(harness, 'agent_end', {})

    expect(harness.accepted.at(-1)?.state).toBe('working')
    expect(harness.accepted.at(-1)?.workingMode).toBe('monitoring')

    inventory.live.length = 0
    await vi.advanceTimersByTimeAsync(60_000)
    await flush()
    expect(harness.accepted.at(-1)?.state).toBe('done')
  })
})
