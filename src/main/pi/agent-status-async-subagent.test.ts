import { describe, expect, it } from 'vitest'
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

// Why: the channel names the two installed subagent plugins publish on. `pi-subagents`
// (tintinweb, the local fork — see its README's event-bus table) uses the `subagents:*` family;
// `@earendil-works/pi-subagents` uses `subagent:async-*`. Both ride `pi.events`.
const FORK_CREATED = 'subagents:created'
const FORK_STARTED = 'subagents:started'
const FORK_COMPLETED = 'subagents:completed'
const FORK_FAILED = 'subagents:failed'
const EW_STARTED = 'subagent:async-started'
const EW_COMPLETE = 'subagent:async-complete'
/** Upstream's roster also binds this for its own runner-exit grace, so a pi pane carries one
 *  roster subscription plus the fork bus's own. */
const RUNNER_EXIT = 'subagent:process-terminal'
const START_CHANNELS = [FORK_CREATED, FORK_STARTED, EW_STARTED]
const END_CHANNELS = [FORK_COMPLETED, FORK_FAILED, EW_COMPLETE]

/** Drives the REAL generated extension source into the REAL listener entry, so the pane state
 *  asserted here is the one a pi pane would actually show. */
function createHarness(
  kind: 'pi' | 'omp' | 'prime-agent' = 'pi',
  options: { existsSync?: () => boolean } = {}
) {
  const state = createHookListenerState()
  const states: (string | undefined)[] = []
  const accepted: (ParsedAgentStatusPayload | undefined)[] = []
  const posted: Record<string, unknown>[] = []
  const harness = createAgentStatusExtensionHarness({
    kind,
    env: HOOK_ENV,
    existsSync: options.existsSync,
    fetchImpl: async (_url, init) => {
      const body: { payload?: Record<string, unknown> } = JSON.parse(String(init?.body))
      posted.push(body.payload ?? {})
      const event = normalizeHookPayload(
        state,
        kind === 'prime-agent' ? 'prime-agent' : kind,
        body,
        'production'
      )
      if (event) {
        seedLegacyAgentStatusForTests(state, event)
      }
      states.push(event?.payload.state)
      accepted.push(event?.payload)
      return { ok: true }
    }
  })
  return { ...harness, states, accepted, posted }
}

async function flushPosts(): Promise<void> {
  // Why: `agent_end` defers its post through a 0ms idle recheck, so microtask flushes alone
  // would read the pane before the parent's own completion was ever delivered.
  for (let i = 0; i < 8; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

async function drive(
  harness: ReturnType<typeof createHarness>,
  name: string,
  event: unknown = {},
  context: HookContext = { isIdle: () => true }
): Promise<void> {
  await harness.callHook(name, event, context)
  await flushPosts()
}

/** A session the extension can name, so a child's bucket is keyed the way production keys it. */
function sessionCtx(id: string): HookContext {
  return {
    isIdle: () => true,
    sessionManager: { getSessionId: () => id, getSessionFile: () => `/sessions/${id}.jsonl` }
  }
}

async function emit(
  harness: ReturnType<typeof createHarness>,
  name: string,
  payload: unknown
): Promise<void> {
  harness.emitPiEvent(name, payload)
  await flushPosts()
}

/** Emit several bus events with NO flush between them, so every one after the first lands
 *  while a delivery is already in flight — the window where the transport's latest-only slot
 *  discards the pending message. Awaiting between emits would flush that window every time
 *  and the race would never be exercised. */
async function emitWithoutFlush(
  harness: ReturnType<typeof createHarness>,
  events: readonly { name: string; payload: unknown }[]
): Promise<void> {
  for (const event of events) {
    harness.emitPiEvent(event.name, event.payload)
  }
  await flushPosts()
}

describe('pi async subagent runs reach the pane as descendants (STA-6378)', () => {
  it('holds the pane working while an async child run outlives the parent turn', async () => {
    const harness = createHarness()
    await drive(harness, 'before_agent_start', { prompt: 'delegate the sweep' })
    await drive(harness, 'agent_start')
    await emit(harness, FORK_STARTED, {
      id: 'run-1',
      type: 'researcher',
      description: 'trace the writer'
    })

    await drive(harness, 'agent_end', {})
    expect(harness.states.at(-1)).toBe('working')
    // Why: the plugin's `type` is the child's agent type and its `description` is the row's label,
    // so the pane can name what it is still waiting on.
    expect(harness.accepted.at(-1)?.subagents).toEqual([
      expect.objectContaining({
        id: 'run-1',
        agentType: 'researcher',
        description: 'trace the writer'
      })
    ])

    await emit(harness, FORK_COMPLETED, { id: 'run-1', description: 'trace the writer' })
    expect(harness.states.at(-1)).toBe('done')
  })

  it('counts a background spawn the plugin announces before it starts running', async () => {
    const harness = createHarness()
    await drive(harness, 'before_agent_start', { prompt: 'fan out' })
    await drive(harness, 'agent_start')
    // Why: `subagents:created` is the background-spawn signal, which can precede the running
    // transition while the child queues — the pane must already hold for it.
    await emit(harness, FORK_CREATED, { id: 'run-1', type: 'worker', isBackground: true })

    await drive(harness, 'agent_end', {})
    expect(harness.states.at(-1)).toBe('working')

    await emit(harness, FORK_COMPLETED, { id: 'run-1' })
    expect(harness.states.at(-1)).toBe('done')
  })

  it('retires a child the plugin reports as failed or stopped', async () => {
    const harness = createHarness()
    await drive(harness, 'before_agent_start', { prompt: 'fan out' })
    await drive(harness, 'agent_start')
    await emit(harness, FORK_STARTED, { id: 'run-1' })
    await drive(harness, 'agent_end', {})
    expect(harness.states.at(-1)).toBe('working')

    await emit(harness, FORK_FAILED, { id: 'run-1', status: 'aborted' })
    expect(harness.states.at(-1)).toBe('done')
  })

  it('holds through the @earendil-works plugin channel names as well', async () => {
    const harness = createHarness()
    await drive(harness, 'before_agent_start', { prompt: 'fan out' })
    await drive(harness, 'agent_start')
    await emit(harness, EW_STARTED, { runId: 'run-9', agentType: 'scout' })
    await drive(harness, 'agent_end', {})
    expect(harness.states.at(-1)).toBe('working')

    await emit(harness, EW_COMPLETE, { runId: 'run-9' })
    expect(harness.states.at(-1)).toBe('done')
  })

  it('rides the live child set on the next post, so a swallowed add still lands', async () => {
    const harness = createHarness()
    await drive(harness, 'before_agent_start', { prompt: 'delegate' })
    await drive(harness, 'agent_start')
    // Why: this is the shape the transport loses — the child's own add post races the tool burst
    // a background spawn ends with. What matters is that the NEXT ordinary event carries the set.
    await emit(harness, FORK_STARTED, { id: 'run-1', type: 'researcher' })
    await drive(harness, 'tool_execution_end', { tool_name: 'Agent' })

    expect(harness.posted.at(-1)?.subagent_runs).toEqual([
      expect.objectContaining({ id: 'run-1', agent_type: 'researcher' })
    ])
    // The pane reads that field off any event, so it holds for a child it only heard about here.
    expect(harness.accepted.at(-1)?.subagents).toEqual([
      expect.objectContaining({ id: 'run-1', agentType: 'researcher' })
    ])
    await drive(harness, 'agent_end', {})
    expect(harness.states.at(-1)).toBe('working')
  })

  it('clears the set on the next post after the last child finishes', async () => {
    const harness = createHarness()
    await drive(harness, 'before_agent_start', { prompt: 'delegate' })
    await drive(harness, 'agent_start')
    await emit(harness, FORK_STARTED, { id: 'run-1' })
    await drive(harness, 'agent_end', {})
    expect(harness.states.at(-1)).toBe('working')

    await emit(harness, FORK_COMPLETED, { id: 'run-1' })
    // Why: a dropped clear would pin the pane working, so the empty set must ride ordinary
    // events too — not only the dedicated post.
    await drive(harness, 'agent_start')
    await drive(harness, 'agent_end', {})
    expect(harness.posted.at(-1)?.subagent_runs).toEqual([])
    expect(harness.states.at(-1)).toBe('done')
  })

  it('settles only after the last child, then only once for the turn it wakes', async () => {
    const harness = createHarness()
    await drive(harness, 'before_agent_start', { prompt: 'fan out' })
    await drive(harness, 'agent_start')
    await emit(harness, FORK_STARTED, { id: 'run-1' })
    await emit(harness, FORK_STARTED, { id: 'run-2' })

    await drive(harness, 'agent_end', {})
    await emit(harness, FORK_COMPLETED, { id: 'run-1' })
    expect(harness.states.at(-1)).toBe('working')

    await emit(harness, FORK_COMPLETED, { id: 'run-2' })
    expect(harness.states.at(-1)).toBe('done')

    // The final child woke the parent for another turn; the pane must not stay settled.
    await drive(harness, 'agent_start')
    expect(harness.states.at(-1)).toBe('working')
    await drive(harness, 'agent_end', {})
    expect(harness.states.at(-1)).toBe('done')

    expect(harness.states.filter((value) => value === 'done')).toHaveLength(2)
  })

  it('settles when several children finish inside one in-flight delivery window', async () => {
    const harness = createHarness()
    await drive(harness, 'before_agent_start', { prompt: 'fan out wide' })
    await drive(harness, 'agent_start')
    // Why: the starts are delivered one at a time on purpose. Coalescing them too would drop
    // the start that pairs with a dropped completion, and the two losses would cancel out —
    // the pane would settle for the wrong reason and the test would prove nothing.
    await emit(harness, FORK_STARTED, { id: 'run-1' })
    await emit(harness, FORK_STARTED, { id: 'run-2' })
    await emit(harness, FORK_STARTED, { id: 'run-3' })
    await drive(harness, 'agent_end', {})
    expect(harness.states.at(-1)).toBe('working')

    // Why: the transport coalesces to a latest-only slot, so of these three only the last
    // is ever delivered. It carries the whole live set, so the pane still settles; a
    // start/complete delta would strand run-1 and run-2 and pin the pane working forever.
    await emitWithoutFlush(harness, [
      { name: FORK_COMPLETED, payload: { id: 'run-1' } },
      { name: FORK_COMPLETED, payload: { id: 'run-2' } },
      { name: FORK_COMPLETED, payload: { id: 'run-3' } }
    ])
    expect(harness.states.at(-1)).toBe('done')
  })

  it('keeps the pane working when only some of a coalesced burst finish', async () => {
    const harness = createHarness()
    await drive(harness, 'before_agent_start', { prompt: 'partial' })
    await drive(harness, 'agent_start')
    await emit(harness, FORK_STARTED, { id: 'run-1' })
    await emit(harness, FORK_STARTED, { id: 'run-2' })
    await drive(harness, 'agent_end', {})

    await emitWithoutFlush(harness, [{ name: FORK_COMPLETED, payload: { id: 'run-1' } }])
    expect(harness.states.at(-1)).toBe('working')

    await emit(harness, FORK_COMPLETED, { id: 'run-2' })
    expect(harness.states.at(-1)).toBe('done')
  })

  it('survives an in-process reload without forgetting live children', async () => {
    const harness = createHarness()
    await drive(harness, 'before_agent_start', { prompt: 'reload me' })
    await drive(harness, 'agent_start')
    await emit(harness, FORK_STARTED, { id: 'run-1' })

    // Why: the posted set is authoritative, so a reload that rebuilt it empty would tell the
    // receiver the child had finished. The set lives on globalThis for exactly this reason.
    harness.reload()
    await drive(harness, 'agent_end', {})
    expect(harness.states.at(-1)).toBe('working')

    await emit(harness, FORK_COMPLETED, { id: 'run-1' })
    expect(harness.states.at(-1)).toBe('done')
  })

  it('brings a resumed session’s children back to the pane, and keeps them off another session', async () => {
    // Why: a pi post carries its session identity only once its transcript exists on disk, and the
    // receiver refuses a pi `session_start` that cannot name the session it resumes.
    const harness = createHarness('pi', { existsSync: () => true })
    await drive(harness, 'session_start', { reason: 'startup' }, sessionCtx('A'))
    await drive(harness, 'before_agent_start', { prompt: 'delegate the sweep' }, sessionCtx('A'))
    await drive(harness, 'agent_start', {}, sessionCtx('A'))
    await emit(harness, FORK_STARTED, { id: 'run-1', type: 'researcher' })
    await drive(harness, 'agent_end', {}, sessionCtx('A'))
    expect(harness.states.at(-1)).toBe('working')

    // A new session is a scope reset for the pane: a pane shows one session's children at a time,
    // so B is not held by A's child and does not name it.
    await harness.replacePiSession('new')
    await drive(harness, 'session_start', { reason: 'new' }, sessionCtx('B'))
    expect(harness.states.at(-1)).toBe('done')
    expect(harness.accepted.at(-1)?.subagents).toBeUndefined()

    // The session that comes back is the one its children were never taken from, so the resume is
    // where the pane gets them back — and with them, the hold.
    await harness.replacePiSession('resume', '/sessions/A.jsonl')
    await drive(harness, 'session_start', { reason: 'resume' }, sessionCtx('A'))
    expect(harness.posted.at(-1)?.subagent_runs).toEqual([expect.objectContaining({ id: 'run-1' })])
    // Why: the resume publishes the restored hold itself, so a receiver that discarded the row when
    // the session changed learns the returned session is still held by the child it names.
    expect(harness.accepted.at(-1)?.state).toBe('working')
    expect(harness.accepted.at(-1)?.subagents).toEqual([
      expect.objectContaining({ id: 'run-1', agentType: 'researcher' })
    ])
    // Why: a NEW turn here would re-describe the pane's own verdict, and the final child would settle
    // against that instead of against a restored one. The case that has to hold on its own is the
    // resume with no turn — see 'settles a resumed session when its last child completes'.
    await drive(harness, 'agent_start', {}, sessionCtx('A'))
    await drive(harness, 'agent_end', {}, sessionCtx('A'))
    // The resumed turn ends and the pane is still held, by that child, named.
    expect(harness.states.at(-1)).toBe('working')
    expect(harness.accepted.at(-1)?.subagents).toEqual([
      expect.objectContaining({ id: 'run-1', agentType: 'researcher' })
    ])

    await emit(harness, FORK_COMPLETED, { id: 'run-1' })
    expect(harness.states.at(-1)).toBe('done')
  })

  it('settles a resumed session when its last child completes, with no new turn', async () => {
    const harness = createHarness('pi', { existsSync: () => true })
    await drive(harness, 'session_start', { reason: 'startup' }, sessionCtx('A'))
    await drive(harness, 'before_agent_start', { prompt: 'delegate the sweep' }, sessionCtx('A'))
    await drive(harness, 'agent_start', {}, sessionCtx('A'))
    await emit(harness, FORK_STARTED, { id: 'run-1', type: 'researcher' })
    await drive(harness, 'agent_end', {}, sessionCtx('A'))
    expect(harness.states.at(-1)).toBe('working')

    // A→B→A: /new takes the pane to a session with no children of its own.
    await harness.replacePiSession('new')
    await drive(harness, 'session_start', { reason: 'new' }, sessionCtx('B'))
    await harness.replacePiSession('resume', '/sessions/A.jsonl')
    await drive(harness, 'session_start', { reason: 'resume' }, sessionCtx('A'))
    // The resume re-publishes the hold A's still-live child justifies.
    expect(harness.accepted.at(-1)?.state).toBe('working')
    expect(harness.accepted.at(-1)?.subagents).toEqual([
      expect.objectContaining({ id: 'run-1', agentType: 'researcher' })
    ])

    // No turn follows the resume: the child's own completion is the only event left, and it has to
    // settle the pane rather than leave the hold standing on a child that is gone.
    await emit(harness, FORK_COMPLETED, { id: 'run-1' })
    expect(harness.states.at(-1)).toBe('done')
    expect(harness.accepted.at(-1)?.subagents).toBeUndefined()
  })

  it('keeps the held state working once only the child is still working', async () => {
    const harness = createHarness()
    await drive(harness, 'before_agent_start', { prompt: 'delegate the sweep' })
    await drive(harness, 'agent_start')
    await emit(harness, FORK_STARTED, { id: 'run-1' })
    // Why: the lead's own turn is running, so the pane is working for its own reasons.
    expect(harness.accepted.at(-1)?.workingMode).toBeUndefined()

    await drive(harness, 'agent_end', {})
    expect(harness.accepted.at(-1)).toMatchObject({
      state: 'working',
      workingMode: undefined
    })

    await emit(harness, FORK_COMPLETED, { id: 'run-1' })
    expect(harness.accepted.at(-1)?.state).toBe('done')
    expect(harness.accepted.at(-1)?.workingMode).toBeUndefined()
  })

  it('retires a child from the live set when its runner exits', async () => {
    const harness = createHarness()
    await drive(harness, 'before_agent_start', { prompt: 'fan out' })
    await drive(harness, 'agent_start')
    await emit(harness, EW_STARTED, { runId: 'run-1', agentType: 'scout' })
    await drive(harness, 'agent_end', {})
    expect(harness.states.at(-1)).toBe('working')

    // Why: this lineage's only end signal for an awaited workflow child is its runner exit, so the
    // set must shrink here instead of stranding the child until the quiet-reap window.
    await emit(harness, RUNNER_EXIT, { runId: 'run-1', state: 'observed' })
    expect(harness.posted.at(-1)?.subagent_runs).toEqual([])
    // The pane recomputes its hold from the new set; the exit itself never settles it.
    expect(harness.accepted.at(-1)?.state).toBe('done')
  })

  it('ignores a bus payload with no child id rather than inventing a child', async () => {
    const harness = createHarness()
    await drive(harness, 'before_agent_start', { prompt: 'go' })
    await drive(harness, 'agent_start')
    const before = harness.states.length

    await emit(harness, FORK_STARTED, { description: 'no id here' })
    expect(harness.states).toHaveLength(before)

    await drive(harness, 'agent_end', {})
    expect(harness.states.at(-1)).toBe('done')
  })

  it('arms a second factory’s own bus, so its child reports', async () => {
    const harness = createHarness('pi', { existsSync: () => true })
    await drive(harness, 'session_start', { reason: 'startup' }, sessionCtx('A'))
    await drive(harness, 'before_agent_start', { prompt: 'delegate' }, sessionCtx('A'))
    await drive(harness, 'agent_start', {}, sessionCtx('A'))
    await emit(harness, EW_STARTED, { runId: 'run-a', agentType: 'scout' })
    // A second registration of the same extension in this process, on its own bus.
    const child = harness.registerTaskChild()

    // Why: one binding per channel PER BUS is the fork’s policy — not one per evaluation, which
    // would leave this bus unobserved and lose every child that reports on it.
    expect(harness.piEventListenerCount(EW_STARTED)).toBe(1)
    expect(child.piEventListenerCount(EW_STARTED)).toBe(1)

    // Its child is reported, and reported for the session its own context named.
    await child.callHook('session_start', { reason: 'startup' }, sessionCtx('B'))
    child.emitPiEvent(EW_STARTED, { runId: 'run-b', agentType: 'scout' })
    await flushPosts()
    expect(harness.posted.at(-1)).toMatchObject({ session_id: 'B' })
    expect(harness.posted.at(-1)?.subagent_runs).toEqual([expect.objectContaining({ id: 'run-b' })])
  })

  it('files a child under the session of the registration now live on the bus', async () => {
    const harness = createHarness('pi', { existsSync: () => true })
    await drive(harness, 'session_start', { reason: 'startup' }, sessionCtx('A'))
    await drive(harness, 'before_agent_start', { prompt: 'delegate' }, sessionCtx('A'))
    await drive(harness, 'agent_start', {}, sessionCtx('A'))
    await emit(harness, EW_STARTED, { runId: 'run-a', agentType: 'scout' })
    await drive(harness, 'agent_end', {}, sessionCtx('A'))

    // Pi re-runs the factory in-process without shutting the previous registration down, so the bus
    // the first one armed is now the second one’s — as is everything its channels report.
    harness.reload()
    await drive(harness, 'session_start', { reason: 'startup' }, sessionCtx('B'))
    await emit(harness, EW_STARTED, { runId: 'run-b', agentType: 'scout' })
    expect(harness.posted.at(-1)).toMatchObject({ session_id: 'B' })
    // Why: a child filed by the run that INSTALLED the listeners lands in A, the session the pane
    // is no longer showing, and A’s next resume hands it back as its own.
    expect(harness.posted.at(-1)?.subagent_runs).toEqual([expect.objectContaining({ id: 'run-b' })])

    await harness.replacePiSession('resume', '/sessions/A.jsonl')
    await drive(harness, 'session_start', { reason: 'resume' }, sessionCtx('A'))
    expect(harness.posted.at(-1)?.subagent_runs).toEqual([expect.objectContaining({ id: 'run-a' })])
  })

  it('closes the channels a registration armed when its own shutdown closes it', async () => {
    const harness = createHarness()
    await drive(harness, 'before_agent_start', { prompt: 'delegate' })
    await drive(harness, 'agent_start')
    // The second registration took the first one’s bus over, so that binding is its own to close.
    harness.reload()
    await drive(harness, 'session_shutdown', { reason: 'new' })

    // Why: a callback the superseded registration installed would keep posting for a session that is
    // gone, and nothing would ever close it.
    expect(harness.piEventListenerCount(EW_STARTED)).toBe(0)
    const before = harness.posted.length
    await emit(harness, EW_STARTED, { runId: 'run-b', agentType: 'scout' })
    expect(harness.posted).toHaveLength(before)
  })

  it('binds each lifecycle channel once across an in-process extension reload', () => {
    const harness = createHarness()
    for (const channel of [...START_CHANNELS, ...END_CHANNELS]) {
      expect(harness.piEventListenerCount(channel)).toBe(1)
    }
    harness.reload()
    // Why: pi replaces pi.on handlers on reload but not bus listeners; a second
    // registration would post every child lifecycle event twice.
    for (const channel of [...START_CHANNELS, ...END_CHANNELS]) {
      expect(harness.piEventListenerCount(channel)).toBe(1)
    }
    expect(harness.piEventListenerCount(RUNNER_EXIT)).toBe(2)
  })

  it('does not register the pi subagent bus for omp or prime-agent', () => {
    for (const kind of ['omp', 'prime-agent'] as const) {
      const harness = createHarness(kind)
      for (const channel of [...START_CHANNELS, ...END_CHANNELS]) {
        expect(harness.piEventListenerCount(channel)).toBe(0)
      }
      // Upstream's roster binds the runner-exit channel for every kind; only the fork's bus is pi-only.
      expect(harness.piEventListenerCount(RUNNER_EXIT)).toBe(1)
    }
  })
})
