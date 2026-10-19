import { beforeEach, describe, expect, it } from 'vitest'
import {
  createHookListenerState,
  seedLegacyAgentStatusForTests,
  type HookListenerState
} from './listener-state'
import { isNestedPiSessionEvent } from './nested-pi-session-guard'
import { normalizeAndAccept, PANE_KEY } from '../agent-hook-listener-test-harness'
import { AGENT_DESCENDANT_QUIET_REAP_MS } from '../agent-descendant-roster'

const PARENT_SESSION = {
  session_id: 'pi-parent-session',
  session_file: '/tmp/pi-parent-session.jsonl'
}
/** The pi session pi-subagents builds in-process to drive a claude CLI child. */
const RUNNER_SESSION = {
  session_id: 'pi-runner-session',
  session_file: '/tmp/pi-runner-session.jsonl'
}

describe('isNestedPiSessionEvent', () => {
  const owner = {
    providerSession: { key: 'session_id' as const, id: 'pi-parent-session' }
  }

  it('refuses an event from a second pi session in the same process', () => {
    expect(
      isNestedPiSessionEvent({
        previousStatus: owner,
        source: 'pi',
        providerSession: { key: 'session_id', id: 'pi-runner-session' },
        eventName: 'tool_execution_end'
      })
    ).toBe(true)
  })

  it('lets the pane’s own session through', () => {
    expect(
      isNestedPiSessionEvent({
        previousStatus: owner,
        source: 'pi',
        providerSession: { key: 'session_id', id: 'pi-parent-session' },
        eventName: 'tool_execution_end'
      })
    ).toBe(false)
  })

  it('lets a session boundary hand the pane over', () => {
    // /new, a resume or a fork legitimately moves the pane onto another session.
    expect(
      isNestedPiSessionEvent({
        previousStatus: owner,
        source: 'pi',
        providerSession: { key: 'session_id', id: 'pi-runner-session' },
        eventName: 'session_start'
      })
    ).toBe(false)
  })

  it('says nothing about a pane with no owner yet, or a provider this is not written for', () => {
    expect(
      isNestedPiSessionEvent({
        previousStatus: undefined,
        source: 'pi',
        providerSession: { key: 'session_id', id: 'pi-runner-session' },
        eventName: 'tool_execution_end'
      })
    ).toBe(false)
    expect(
      isNestedPiSessionEvent({
        previousStatus: owner,
        source: 'claude',
        providerSession: { key: 'session_id', id: 'some-child' },
        eventName: 'PreToolUse'
      })
    ).toBe(false)
  })
})

describe('a second pi session cannot speak for a pane that holds a live child', () => {
  let state: HookListenerState

  beforeEach(() => {
    state = createHookListenerState()
  })

  const startParentTurn = (): void => {
    expect(
      normalizeAndAccept(state, 'pi', {
        hook_event_name: 'before_agent_start',
        prompt: 'delegate to claude',
        ...PARENT_SESSION
      })?.payload.state
    ).toBe('working')
  }

  const publishRun = (): void => {
    normalizeAndAccept(state, 'pi', {
      hook_event_name: 'tool_execution_end',
      ...PARENT_SESSION,
      subagent_runs: [{ id: 'run-1', agent_type: 'general-purpose', description: 'review' }]
    })
  }

  it('keeps the parent’s child row when the child runner session posts its own (empty) set', () => {
    startParentTurn()
    publishRun()
    expect(state.descendantRosterByPaneKey.get(PANE_KEY)?.has('run-1')).toBe(true)

    // Why this is what the fence exists for: the runner session has no children of its own, and a
    // pi post carries the FULL live child set of the session that posted it — taking it literally
    // replaced the pane's roster with nothing while the child was still working.
    const refused = normalizeAndAccept(state, 'pi', {
      hook_event_name: 'tool_execution_start',
      ...RUNNER_SESSION,
      subagent_runs: []
    })

    expect(refused).toBeNull()
    expect(state.descendantRosterByPaneKey.get(PANE_KEY)?.has('run-1')).toBe(true)
  })

  it('adopts the new session once nothing of the pane’s is left running', () => {
    // Why the liveness gate: pi's latest-only queue can drop the `session_start` that hands the
    // pane over, and a refusal keyed on the session id alone would then last forever. A runner
    // session only exists while a child of this pane runs, so an empty roster means there is none.
    startParentTurn()
    const adopted = normalizeAndAccept(state, 'pi', {
      hook_event_name: 'tool_execution_start',
      ...RUNNER_SESSION,
      subagent_runs: []
    })
    expect(adopted?.providerSession?.id).toBe('pi-runner-session')
    expect(state.lastStatusByPaneKey.get(PANE_KEY)?.providerSession?.id).toBe('pi-runner-session')
  })

  it('never lets a nested session become the pane’s resume identity', () => {
    startParentTurn()
    publishRun()
    normalizeAndAccept(state, 'pi', { hook_event_name: 'agent_start', ...RUNNER_SESSION })
    expect(state.lastStatusByPaneKey.get(PANE_KEY)?.providerSession?.id).toBe('pi-parent-session')
  })

  it('adopts the new session once the close-out drained the pane’s roster', () => {
    // Why: a `/new` ends the old session, and the post that rides its end reports the live set it
    // is leaving — an empty one. The host fence is gated on that roster, so this is the post that
    // releases the pane even when the new session's own `session_start` was coalesced away.
    startParentTurn()
    publishRun()
    normalizeAndAccept(state, 'pi', {
      hook_event_name: 'agent_end',
      ...PARENT_SESSION,
      subagent_runs: []
    })
    const adopted = normalizeAndAccept(state, 'pi', {
      hook_event_name: 'tool_execution_start',
      ...RUNNER_SESSION
    })
    expect(adopted?.providerSession?.id).toBe('pi-runner-session')
  })

  it('adopts the new session once the only run left is past the quiet window', () => {
    startParentTurn()
    publishRun()
    const tracked = state.descendantRosterByPaneKey.get(PANE_KEY)?.get('run-1')
    expect(tracked).toBeDefined()
    // A run whose end never arrived must not hold the fence past the reaper's window.
    tracked!.lastEventAt = Date.now() - AGENT_DESCENDANT_QUIET_REAP_MS - 1

    expect(
      normalizeAndAccept(state, 'pi', {
        hook_event_name: 'tool_execution_start',
        ...RUNNER_SESSION
      })?.providerSession?.id
    ).toBe('pi-runner-session')
  })

  it('lets a session_start move the pane onto a new session', () => {
    startParentTurn()
    expect(
      normalizeAndAccept(state, 'pi', {
        hook_event_name: 'session_start',
        ...RUNNER_SESSION
      })
    ).not.toBeNull()
  })

  it('keeps the fence from a row that already carries the owner session', () => {
    // A restart hydrates the row rather than replaying its posts, so the fence has to work off the
    // stored provider session — which is why a nested event must leave it alone. The roster is not
    // restored, so a run has to be live for the fence to apply at all; that is the documented gap.
    seedLegacyAgentStatusForTests(state, {
      paneKey: PANE_KEY,
      source: 'pi',
      connectionId: null,
      providerSession: {
        key: 'session_id',
        id: 'pi-parent-session',
        transcriptPath: '/tmp/pi-parent-session.jsonl'
      },
      payload: { state: 'working', prompt: 'delegate to claude', agentType: 'pi' }
    })
    publishRun()
    expect(
      normalizeAndAccept(state, 'pi', {
        hook_event_name: 'tool_execution_end',
        ...RUNNER_SESSION,
        subagent_runs: []
      })
    ).toBeNull()
    expect(state.lastStatusByPaneKey.get(PANE_KEY)?.providerSession?.id).toBe('pi-parent-session')
  })

  it('lets a session pi hands the pane to take over immediately', () => {
    startParentTurn()
    normalizeAndAccept(state, 'pi', { hook_event_name: 'agent_start', ...RUNNER_SESSION })
    expect(
      normalizeAndAccept(state, 'pi', { hook_event_name: 'session_start', ...RUNNER_SESSION })
        ?.providerSession?.id
    ).toBe('pi-runner-session')
  })
})
