import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  AGENT_STATUS_EXTENSION_SELF_PID,
  createAgentStatusExtensionHarness,
  type AgentStatusExtensionHarness
} from './agent-status-extension-test-harness'

// Event shapes and orderings mirror traces recorded from pi-subagents 0.71.0.
const WORKFLOW = 'workflow-1'
const idle = { isIdle: () => true }

function postedHookNames(harness: AgentStatusExtensionHarness): string[] {
  return harness.fetchMock.mock.calls.map((call) => {
    const body: { payload?: { hook_event_name?: unknown } } = JSON.parse(String(call[1]?.body))
    return String(body.payload?.hook_event_name)
  })
}

function agentEndCount(harness: AgentStatusExtensionHarness): number {
  return postedHookNames(harness).filter((name) => name === 'agent_end').length
}

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

function startWorkflow(harness: AgentStatusExtensionHarness): void {
  harness.emitPiEvent('subagent:async-started', {
    id: WORKFLOW,
    mode: 'workflow',
    pid: AGENT_STATUS_EXTENSION_SELF_PID
  })
}

function startChild(harness: AgentStatusExtensionHarness, id: string, parent = WORKFLOW): void {
  harness.emitPiEvent('subagent:async-started', {
    id,
    mode: 'single',
    pid: 4000,
    parentWorkflowRunId: parent
  })
}

function exitRunner(harness: AgentStatusExtensionHarness, runId: string): void {
  harness.emitPiEvent('subagent:process-terminal', { runId, state: 'observed' })
}

function complete(harness: AgentStatusExtensionHarness, id: string): void {
  harness.emitPiEvent('subagent:async-complete', { id, runId: id, state: 'complete' })
}

async function endTurn(harness: AgentStatusExtensionHarness): Promise<void> {
  await harness.callHook('agent_end', {}, idle)
  await harness.callHook('agent_settled', undefined, idle)
  await vi.advanceTimersByTimeAsync(0)
}

describe('Pi async subagent roster', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
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
    harness.reload()
    // Why: upstream's roster binds this channel for its own runner-exit grace, and the fork's bus
    // adds exactly one more subscription for its live set — a reload must not add a third.
    expect(harness.piEventListenerCount('subagent:process-terminal')).toBe(2)

    exitRunner(harness, 'child-a')
    await endTurn(harness)
    expect(agentEndCount(harness)).toBe(1)
  })
})
