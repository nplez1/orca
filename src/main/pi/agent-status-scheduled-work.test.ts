import type { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { normalizeHookPayload } from '../../shared/agent-hook-listener/normalization/normalize-hook-payload'
import type { ParsedAgentStatusPayload } from '../../shared/agent-status/contracts/agent-status-types'
import { PANE_KEY } from '../../shared/agent-hook-listener/normalization/agent-hook-listener-test-harness'
import { createHookListenerState } from '../../shared/agent-hook-listener/listener-state'
import { seedLegacyAgentStatusForTests } from '../../shared/agent-hook-listener/legacy-agent-status-test-seed'
import {
  createAgentStatusExtensionHarness,
  type HookContext
} from './managed-extensions/agent-status/agent-status-extension-test-harness'

const HOOK_ENV = { ORCA_PANE_KEY: PANE_KEY, ORCA_AGENT_HOOK_ENV: 'production' }
const LIVE_LIST = 'loop:rpc:schedules:list'
const COLD_LIST = 'subagents:rpc:schedules:list'
const SCHEDULED_EVENT = 'subagents:scheduled'
const SCHEDULER_READY = 'subagents:scheduler_ready'
const LOOP_STATE = 'loop:state'

/** A live `/loop` job as the loop extension lists it. */
type LiveJob = {
  id: string
  prompt: string
  mode: 'fixed' | 'dynamic' | 'once'
  nextAt?: number
  runs: number
  paused?: boolean
  maxRuns?: number
  until?: number
}

/** A cold scheduler job as pi-subagents lists it. */
type ColdJob = {
  id: string
  schedule: string
  prompt: string
  enabled: boolean
  nextRun?: string
  runCount?: number
  maxRuns?: number
  until?: string
}

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
    state,
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

  it('holds nothing for a paused live loop, whose id outlives its armed state', async () => {
    const inventory: Inventory = { live: [], cold: [] }
    const harness = createHarness({ inventory })
    await startTurn(harness)
    // Why: `pause` keeps the id, the prompt and the cadence and only unarms the timer, so a paused loop is
    // still listed with no `nextAt` — the shape a self-paced loop has while it waits for its wakeup.
    inventory.live.push(liveLoop({ paused: true, nextAt: undefined }))

    await drive(harness, 'agent_end', {})

    expect(harness.posted.at(-1)?.scheduled_work).toBeUndefined()
    expect(harness.accepted.at(-1)?.state).toBe('done')
    expect(harness.accepted.at(-1)?.workingMode).toBeUndefined()
  })

  it('re-checks when the loop extension publishes its armed set between turns', async () => {
    const inventory: Inventory = { live: [], cold: [] }
    const harness = createHarness({ inventory })
    await startTurn(harness)
    await drive(harness, 'agent_end', {})
    expect(harness.accepted.at(-1)?.state).toBe('done')

    // Why: a `/loop` typed at an idle prompt, or a `manage_schedules` call that lands after the turn, moves
    // the inventory with no turn to carry it — `loop:state` is the only thing that announces it.
    inventory.live.push(liveLoop())
    harness.emitPiEvent(LOOP_STATE, { jobs: [{ id: 'loop-1', nextAt: Date.now() + 300_000 }] })
    await flush()

    expect(harness.accepted.at(-1)?.state).toBe('working')
    expect(harness.accepted.at(-1)?.workingMode).toBe('monitoring')

    // Why both directions: a pause at an idle prompt must release the hold the same way. `/loop` filters
    // a paused loop out of its own armed set, so the release arrives as an empty one.
    inventory.live[0].paused = true
    harness.emitPiEvent(LOOP_STATE, { jobs: [] })
    await flush()

    expect(harness.accepted.at(-1)?.state).toBe('done')
    expect(harness.accepted.at(-1)?.workingMode).toBeUndefined()
  })

  it('keeps holding a live loop whose last fire is already armed and in flight', async () => {
    const inventory: Inventory = { live: [], cold: [] }
    const harness = createHarness({ inventory })
    await startTurn(harness)
    const now = Date.now()
    // Why these hold: `/loop` moves `runs` when it arms the fire and starts the turn only after it has
    // published the new armed set, so a live job at or over its bound is mid-fire, not finished — dropping
    // it here would read `done` for the gap before `before_agent_start` arrives.
    inventory.live.push(
      liveLoop({ id: 'loop-spent', mode: 'once', runs: 1, nextAt: undefined }),
      liveLoop({ id: 'loop-maxed', runs: 2, maxRuns: 2 }),
      liveLoop({ id: 'loop-past-until', runs: 1, until: now - 1_000 })
    )

    await drive(harness, 'agent_end', {})

    expect(harness.posted.at(-1)?.scheduled_work).toEqual({
      jobs: [
        { id: 'loop-spent', kind: 'live' },
        { id: 'loop-maxed', kind: 'live', next_in_ms: 300_000 },
        { id: 'loop-past-until', kind: 'live', next_in_ms: 300_000 }
      ]
    })
    expect(harness.accepted.at(-1)?.workingMode).toBe('monitoring')
  })

  it('holds nothing for a cold job whose bound was already reached', async () => {
    const inventory: Inventory = { live: [], cold: [] }
    const harness = createHarness({ inventory })
    await startTurn(harness)
    const now = Date.now()
    const until = now + 60_000
    // Why the cold home may drop these: the scheduler moves `runCount` in the same step it disables the
    // job, so a job at or over its bound (or armed past it) has no fire left and cannot be mid-fire.
    inventory.cold.push(
      coldJob({ id: 'job-maxed', runCount: 3, maxRuns: 3 }),
      coldJob({ id: 'job-expired', until: new Date(now - 1_000).toISOString() }),
      coldJob({
        id: 'job-bound-before-fire',
        until: new Date(until).toISOString(),
        nextRun: new Date(until + 1_000).toISOString()
      }),
      coldJob({
        id: 'job-fires-before-bound',
        until: new Date(until).toISOString(),
        nextRun: new Date(until - 1_000).toISOString()
      })
    )

    await drive(harness, 'agent_end', {})

    expect(harness.posted.at(-1)?.scheduled_work).toEqual({
      jobs: [{ id: 'job-fires-before-bound', kind: 'cold', next_in_ms: 59_000 }]
    })
    expect(harness.accepted.at(-1)?.workingMode).toBe('monitoring')
  })

  it('holds an armed one-shot that has not fired yet', async () => {
    const inventory: Inventory = { live: [], cold: [] }
    const harness = createHarness({ inventory })
    await startTurn(harness)
    inventory.live.push(
      liveLoop({ id: 'loop-once', mode: 'once', runs: 0, nextAt: Date.now() + 600_000 })
    )

    await drive(harness, 'agent_end', {})

    expect(harness.posted.at(-1)?.scheduled_work).toEqual({
      jobs: [{ id: 'loop-once', kind: 'live', next_in_ms: 600_000 }]
    })
    expect(harness.accepted.at(-1)?.workingMode).toBe('monitoring')
  })

  it('reads the whole revamped roster: only the jobs that can still fire hold', async () => {
    const inventory: Inventory = { live: [], cold: [] }
    const harness = createHarness({ inventory })
    await startTurn(harness)
    inventory.live.push(
      // A `jobView()` from `/loop`: armed, cadence kept.
      liveLoop({ id: 'loop-armed' }),
      // Paused by `manage_schedules pause` or `/loop pause`: listed, cadence kept, nothing armed.
      liveLoop({ id: 'loop-paused', paused: true, nextAt: undefined }),
      // Self-paced and between wakeups: present with no deadline, which is exactly a paused shape
      // minus the flag — the flag is the whole difference.
      liveLoop({ id: 'loop-dynamic', mode: 'dynamic', nextAt: undefined, paused: false })
    )
    inventory.cold.push(
      coldJob({ id: 'job-enabled' }),
      // The scheduler's word for paused, and what a job disabled by `maxRuns`/`until` looks like.
      coldJob({ id: 'job-disabled', enabled: false, nextRun: undefined })
    )

    await drive(harness, 'agent_end', {})

    expect(harness.posted.at(-1)?.scheduled_work).toEqual({
      jobs: [
        { id: 'loop-armed', kind: 'live', next_in_ms: 300_000 },
        { id: 'loop-dynamic', kind: 'live' },
        { id: 'job-enabled', kind: 'cold', next_in_ms: 3_600_000 }
      ]
    })
    expect(harness.accepted.at(-1)?.workingMode).toBe('monitoring')
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

  it('finds an armed loop in an idle session that announces nothing', async () => {
    const inventory: Inventory = { live: [], cold: [] }
    const harness = createHarness({ inventory })
    await drive(harness, 'session_start', { reason: 'startup' })
    const postedWhileIdle = harness.posted.length

    // Why silent: an older `/loop` answers its list channel and emits no `loop:state` at all, so nothing
    // in the pane announces this arm — only asking again on the discovery cadence can find it.
    inventory.live.push(liveLoop())
    await vi.advanceTimersByTimeAsync(300_000)
    await flush()

    expect(harness.accepted.at(-1)?.state).toBe('working')
    expect(harness.accepted.at(-1)?.workingMode).toBe('monitoring')
    // Why the slice: the post that carries it must be the discovery's, not the idle start's.
    expect(harness.posted.slice(postedWhileIdle).at(-1)?.scheduled_work).toEqual({
      jobs: [expect.objectContaining({ id: 'loop-1', kind: 'live' })]
    })
  })

  it('asks again without posting while a served session holds nothing', async () => {
    const inventory: Inventory = { live: [], cold: [] }
    const harness = createHarness({ inventory })
    await drive(harness, 'session_start', { reason: 'startup' })
    const postedWhileIdle = harness.posted.length

    await vi.advanceTimersByTimeAsync(600_000)
    await flush()

    // Why: discovery exists to find work, not to restate an empty inventory — a tick that found nothing
    // must cost one ask and no delivery, or every idle pane posts every five minutes forever.
    expect(harness.posted.length).toBe(postedWhileIdle)
    expect(harness.accepted.at(-1)?.state).toBe('done')
  })

  it('holds a loop restored with the resumed session, before any turn', async () => {
    const inventory: Inventory = { live: [liveLoop()], cold: [] }
    const harness = createHarness({ inventory })
    harness.fsMock.existsSync.mockReturnValue(true)

    await drive(harness, 'session_start', { reason: 'resume' })
    // Why past the retry: the start's own post is in flight when the refresh's answer lands, so the
    // restatement that carries it is re-armed rather than delivered on the first tick.
    await vi.advanceTimersByTimeAsync(1_000)
    await flush()

    expect(harness.accepted.at(-1)?.state).toBe('working')
    expect(harness.accepted.at(-1)?.workingMode).toBe('monitoring')

    // Why the release: the hold opened on the start's own post here, with no restatement to record it, so
    // the release must still find the placeholder it has to return to.
    inventory.live.length = 0
    harness.emitPiEvent(LOOP_STATE, { jobs: [] })
    await flush()

    expect(harness.accepted.at(-1)?.state).toBe('done')
    expect(harness.accepted.at(-1)?.sessionBoundary).toBe(true)
  })

  it('releases a turn that ran inside an armed session as a real completion', async () => {
    const inventory: Inventory = { live: [], cold: [] }
    const harness = createHarness({ inventory })
    harness.fsMock.existsSync.mockReturnValue(true)
    await drive(harness, 'session_start', { reason: 'startup' })
    inventory.live.push(liveLoop())
    harness.emitPiEvent(LOOP_STATE, { jobs: [{ id: 'loop-1', nextAt: Date.now() + 300_000 }] })
    await flush()
    expect(harness.accepted.at(-1)?.workingMode).toBe('monitoring')

    // Why: a loop firing (or the user typing) starts a real turn under the same hold, and that turn's
    // completion is the one completion this pane has — it must not be mistaken for the idle boundary.
    await drive(harness, 'before_agent_start', { prompt: 'sweep the queue' })
    await drive(harness, 'agent_start')
    await drive(harness, 'agent_end', {})
    expect(harness.accepted.at(-1)?.workingMode).toBe('monitoring')

    inventory.live.length = 0
    harness.emitPiEvent(LOOP_STATE, { jobs: [] })
    await flush()

    expect(harness.accepted.at(-1)?.state).toBe('done')
    expect(harness.accepted.at(-1)?.workingMode).toBeUndefined()
    expect(harness.accepted.at(-1)?.sessionBoundary).toBeUndefined()
  })

  it('holds a loop armed before the session’s first turn', async () => {
    const inventory: Inventory = { live: [], cold: [] }
    const harness = createHarness({ inventory })
    // Why the persisted session: a real pi post carries `session_id` once its transcript exists, which is
    // what makes a session_start row an identity-only placeholder.
    harness.fsMock.existsSync.mockReturnValue(true)
    // Why a bare session_start: a resumed pane holding restored loops has no turn to ride, and its row
    // is the placeholder this post opened.
    await drive(harness, 'session_start', { reason: 'resume' })
    expect(harness.accepted.at(-1)?.state).toBe('done')

    inventory.live.push(liveLoop())
    harness.emitPiEvent(LOOP_STATE, { jobs: [{ id: 'loop-1', nextAt: Date.now() + 300_000 }] })
    await flush()

    expect(harness.accepted.at(-1)?.state).toBe('working')
    expect(harness.accepted.at(-1)?.workingMode).toBe('monitoring')
    // Why: the placeholder states no turn, so the hold must not publish a boundary flag beside `working`
    // — a client without session-boundary support drops a flagged tab's whole status.
    expect(harness.accepted.at(-1)?.sessionBoundary).toBeUndefined()

    // Why the release: a stopped loop on a pane that never ran a turn must settle back to the boundary
    // row it came from. Without the flag the row is a completed turn — a push nobody earned, and a
    // completion clock on an idle session.
    inventory.live.length = 0
    harness.emitPiEvent(LOOP_STATE, { jobs: [] })
    await flush()

    expect(harness.accepted.at(-1)?.state).toBe('done')
    expect(harness.accepted.at(-1)?.workingMode).toBeUndefined()
    expect(harness.accepted.at(-1)?.sessionBoundary).toBe(true)
  })

  it('leaves a session-switch prompt identity-only until work claims the pane', async () => {
    // Why: a pi session_start carrying a live UI prompt opens a `waiting` row, which is not a turn and not
    // a hold — it must not become a visible row just because the pane has a transcript.
    const harness = createHarness({ inventory: { live: [], cold: [] } })
    harness.fsMock.existsSync.mockReturnValue(true)

    await drive(harness, 'session_start', { reason: 'startup', ui_prompt_active: true })

    expect(harness.state.lastStatusByPaneKey.get(PANE_KEY)?.providerSessionOnly).toBe(true)
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
