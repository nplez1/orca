import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  createAgentStatusExtensionHarness,
  type AgentStatusExtensionHarness
} from './agent-status-extension-test-harness'
import {
  agentEndCount,
  childIds,
  complete,
  endTurn,
  exitRunner,
  postedHookNames,
  posts,
  startChild,
  startWorkflow,
  WORKFLOW
} from './agent-status-subagent-event-fixtures'

/** The descendant roster each post carried, in order. LOCAL(nplez1): the fork reports child runs
 *  as a roster snapshot, so this is what a tracked child has to show up in. */
function postedSubagentRunIds(harness: AgentStatusExtensionHarness): string[][] {
  return harness.fetchMock.mock.calls.map((call) => {
    const body: { payload?: { subagent_runs?: { id: string }[] } } = JSON.parse(
      String(call[1]?.body)
    )
    return (body.payload?.subagent_runs ?? []).map((run) => run.id)
  })
}

describe('Pi async subagent roster', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it("does not spend a run's done on a child that starts before it is posted", async () => {
    const harness = createAgentStatusExtensionHarness({ kind: 'pi' })
    let idle = false
    const context = { isIdle: () => idle }
    await harness.callHook('agent_start')
    await harness.callHook('agent_end', {}, context)
    startChild(harness, 'quick-child', 'tool-call-1')
    complete(harness, 'quick-child')
    await harness.callHook('tool_execution_start', { toolName: 'bash' }, context)
    idle = true
    await vi.advanceTimersByTimeAsync(1_000)

    expect(postedHookNames(harness).at(-1)).toBe('agent_end')
  })

  it('settles after an async workflow whose awaited children never report completion', async () => {
    const harness = createAgentStatusExtensionHarness({ kind: 'pi' })
    await harness.callHook('agent_start')
    startWorkflow(harness)
    startChild(harness, 'child-a')
    startChild(harness, 'child-b')
    await endTurn(harness)
    exitRunner(harness, 'child-a')
    exitRunner(harness, 'child-b')
    await vi.advanceTimersByTimeAsync(5_000)
    // LOCAL(nplez1): these aliases feed the fork's descendant roster, and the pane is held working
    // receiver-side from that roster — the lead's `agent_end` is not withheld at source. A runner
    // exit retires the named child from that roster, so both children are gone before the workflow
    // itself reports its completion.
    expect(agentEndCount(harness)).toBe(1)
    expect(postedHookNames(harness).at(-1)).toBe('subagent_async_state')
    expect(postedSubagentRunIds(harness).at(-1)).toEqual([WORKFLOW])

    // pi-subagents wakes the lead just before announcing only the workflow's completion.
    await harness.callHook('agent_start')
    complete(harness, WORKFLOW)
    await endTurn(harness)

    expect(postedHookNames(harness).at(-1)).toBe('agent_end')
    // The workflow retires itself, and its awaited children already left on their runner exits.
    expect(postedSubagentRunIds(harness).at(-1)).toEqual([])
  })

  it('settles as soon as the workflow completes when its children already exited', async () => {
    const harness = createAgentStatusExtensionHarness({ kind: 'pi' })
    await harness.callHook('agent_start')
    startWorkflow(harness)
    startChild(harness, 'child-a')
    await endTurn(harness)
    exitRunner(harness, 'child-a')
    complete(harness, WORKFLOW)
    await vi.advanceTimersByTimeAsync(0)

    expect(agentEndCount(harness)).toBe(1)
  })

  it('settles after a foreground workflow whose awaited children never report completion', async () => {
    const harness = createAgentStatusExtensionHarness({ kind: 'pi' })
    await harness.callHook('agent_start')
    startChild(harness, 'child-a', 'tool-call-1')
    startChild(harness, 'child-b', 'tool-call-1')
    exitRunner(harness, 'child-a')
    exitRunner(harness, 'child-b')
    await endTurn(harness)

    expect(agentEndCount(harness)).toBe(1)
  })

  it('retires a child on its runner exit after its workflow already completed', async () => {
    const harness = createAgentStatusExtensionHarness({ kind: 'pi' })
    await harness.callHook('agent_start')
    startWorkflow(harness)
    startChild(harness, 'child-a')
    await endTurn(harness)
    complete(harness, WORKFLOW)
    exitRunner(harness, 'child-a')
    await vi.advanceTimersByTimeAsync(500)
    // LOCAL(nplez1): the runner exit names child-a, so the fork's roster drops it and posts the
    // shrunken set. The pane's hold is recomputed from that set — nothing here withholds the
    // lead's `agent_end` or settles the pane on the exit itself.
    expect(agentEndCount(harness)).toBe(1)
    expect(postedSubagentRunIds(harness)).toEqual([[], [WORKFLOW, 'child-a'], ['child-a'], []])

    await vi.advanceTimersByTimeAsync(5_000)
    expect(agentEndCount(harness)).toBe(1)
  })

  it('keeps working while an explicit async child outlives its workflow', async () => {
    const harness = createAgentStatusExtensionHarness({ kind: 'pi' })
    await harness.callHook('agent_start')
    startWorkflow(harness)
    startChild(harness, 'child-a')
    complete(harness, WORKFLOW)
    await endTurn(harness)
    await vi.advanceTimersByTimeAsync(60_000)
    // LOCAL(nplez1): the workflow's completion retires only itself, so its explicit child is still
    // on the fork's descendant roster and holds the pane working receiver-side — the lead's own
    // `agent_end` is not withheld at source.
    expect(agentEndCount(harness)).toBe(1)
    expect(postedSubagentRunIds(harness).at(-1)).toEqual(['child-a'])

    // The child's runner exit retires it from the set, and the wake turn's completion finds
    // nothing left to retire.
    exitRunner(harness, 'child-a')
    await vi.advanceTimersByTimeAsync(150)
    await harness.callHook('agent_start')
    complete(harness, 'child-a')
    await vi.advanceTimersByTimeAsync(5_000)
    // The runner exit drains the roster; the pane settles on the lead's next `agent_end`.
    expect(agentEndCount(harness)).toBe(1)
    expect(postedSubagentRunIds(harness).at(-1)).toEqual([])

    await endTurn(harness)
    // Both turns posted their own `agent_end`: the first with the child still on the roster, this
    // one with it drained.
    expect(agentEndCount(harness)).toBe(2)
    expect(postedHookNames(harness).at(-1)).toBe('agent_end')
    expect(postedSubagentRunIds(harness).at(-1)).toEqual([])
  })

  it('ignores runner exits for runs it is not tracking', async () => {
    const harness = createAgentStatusExtensionHarness({ kind: 'pi' })
    await harness.callHook('agent_start')
    harness.emitPiEvent('subagent:async-started', { id: 'run-1', mode: 'single', pid: 4000 })
    await endTurn(harness)
    exitRunner(harness, 'other-run')
    harness.emitPiEvent('subagent:process-terminal', {})
    await vi.advanceTimersByTimeAsync(5_000)

    // LOCAL(nplez1): neither exit names a child the fork's descendant roster tracks, so both are
    // inert — the roster is unchanged, no post follows, and the lead's `agent_end` was not withheld;
    // the live run holds the pane working receiver-side from that roster.
    expect(postedHookNames(harness)).toEqual(['agent_start', 'agent_end'])
    expect(postedSubagentRunIds(harness)).toEqual([[], ['run-1']])
  })

  it('accepts completion events that identify the run only by runId', async () => {
    const harness = createAgentStatusExtensionHarness({ kind: 'pi' })
    await harness.callHook('agent_start')
    harness.emitPiEvent('subagent:async-started', { id: 'run-1', mode: 'single', pid: 4000 })
    await endTurn(harness)
    harness.emitPiEvent('subagent:async-complete', { runId: 'run-1' })
    await vi.advanceTimersByTimeAsync(0)

    expect(agentEndCount(harness)).toBe(1)
  })

  it('keeps the runner-exit subscriptions and the roster across reloads', async () => {
    const harness = createAgentStatusExtensionHarness({ kind: 'pi' })
    await harness.callHook('agent_start')
    startChild(harness, 'child-a', 'tool-call-1')
    await harness.reloadPi()
    // Why: Pi drops a replaced registration's own subscriptions, so a /reload re-arms every channel
    // exactly once — upstream's roster for its runner-exit grace, the fork's bus for its live set.
    // (`harness.reload()` re-runs the factory on the raw emitter, where the roster's per-bus re-arm
    // flag is gone, so it is not the model for this guarantee.)
    expect(harness.piEventListenerCount('task:subagent:lifecycle')).toBe(1)
    expect(harness.piEventListenerCount('subagent:async-started')).toBe(1)
    expect(harness.piEventListenerCount('subagent:process-terminal')).toBe(2)
    exitRunner(harness, 'child-a')
    await endTurn(harness)
    expect(agentEndCount(harness)).toBe(1)
  })
})

// Roster shapes also mirror OMP 18.3.2's task:subagent:lifecycle.
describe('Pi child rows', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('posts an OMP task child with its description', async () => {
    const harness = createAgentStatusExtensionHarness({ kind: 'omp' })
    await harness.callHook('session_start')
    harness.emitPiEvent('task:subagent:lifecycle', {
      id: '0-explore',
      agent: 'explore',
      description: 'Map the auth module',
      detached: true,
      status: 'started',
      index: 0
    })
    await vi.advanceTimersByTimeAsync(0)

    expect(posts(harness).at(-1)?.subagents).toEqual([
      {
        id: '0-explore',
        state: 'working',
        startedAt: expect.any(Number),
        agentType: 'explore',
        description: 'Map the auth module'
      }
    ])
  })

  it('posts nothing for the end of a run it is not tracking', async () => {
    const harness = createAgentStatusExtensionHarness({ kind: 'pi' })
    await harness.callHook('agent_start')
    complete(harness, 'unknown-run')
    await vi.advanceTimersByTimeAsync(0)

    expect(postedHookNames(harness)).toEqual(['agent_start'])
  })

  it('labels a reused child id from its latest start, and keeps a running child’s first label', async () => {
    const harness = createAgentStatusExtensionHarness({ kind: 'omp' })
    const start = (agent: string) =>
      harness.emitPiEvent('task:subagent:lifecycle', { id: '0-task', agent, status: 'started' })
    const labels = () =>
      posts(harness)
        .at(-1)
        ?.subagents?.map((child) => child.agentType)
    await harness.callHook('agent_start')
    start('explore')
    start('review')
    await vi.advanceTimersByTimeAsync(0)
    expect(labels()).toEqual(['explore'])

    harness.emitPiEvent('task:subagent:lifecycle', { id: '0-task', status: 'completed' })
    start('review')
    await vi.advanceTimersByTimeAsync(0)
    expect(labels()).toEqual(['review'])

    await harness.callHook('session_switch', { reason: 'new' }, {})
    start('plan')
    await vi.advanceTimersByTimeAsync(0)
    expect(labels()).toEqual(['plan'])
  })

  it('posts no subagents field for a pane without children', async () => {
    const harness = createAgentStatusExtensionHarness({ kind: 'pi' })
    await harness.callHook('before_agent_start', { prompt: 'plain turn' })
    await harness.callHook('tool_execution_start', { toolName: 'bash', args: {} })
    await endTurn(harness)

    expect(posts(harness).some((post) => 'subagents' in post)).toBe(false)
  })

  it('leaves a scheduled OMP retry to carry a roster change', async () => {
    let attempts = 0
    const harness = createAgentStatusExtensionHarness({
      kind: 'omp',
      fetchImpl: async () => {
        attempts += 1
        if (attempts === 2) {
          throw new Error('Orca restarting')
        }
        return { ok: true }
      }
    })
    await harness.callHook('agent_start')
    await vi.advanceTimersByTimeAsync(0)
    harness.emitPiEvent('task:subagent:lifecycle', { id: 'c1', agent: 'task', status: 'started' })
    await vi.advanceTimersByTimeAsync(0)
    harness.emitPiEvent('task:subagent:lifecycle', { id: 'c1', status: 'completed' })
    await vi.advanceTimersByTimeAsync(250)

    expect(posts(harness).map((post) => post.hook_event_name)).toEqual([
      'agent_start',
      'agent_start',
      'agent_start'
    ])
    expect(childIds(posts(harness)[1])).toEqual(['c1'])
    expect(posts(harness)[2]?.subagents).toBeUndefined()
  })
})
