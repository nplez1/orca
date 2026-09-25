import { beforeEach, describe, expect, it } from 'vitest'
import {
  clearPaneCacheState,
  createHookListenerState,
  deleteLegacyAgentStatus,
  movePaneCacheState,
  paneHasStateClaims,
  type HookListenerState
} from './agent-hook-listener/listener-state'
import { normalizeAndAccept, PANE_KEY } from './agent-hook-listener-test-harness'
import type { AgentHookSource } from './agent-hook-relay'
import { AGENT_DESCENDANT_QUIET_REAP_MS } from './agent-descendant-roster'

/** Every case drives `normalizeHookPayload`, the entry both the main process and the relay
 *  call, so a fix that never reaches production wiring cannot pass here. */
describe('descendant lifecycle never settles the pane', () => {
  let state: HookListenerState

  beforeEach(() => {
    state = createHookListenerState()
  })

  const publish = (
    source: AgentHookSource,
    payload: Record<string, unknown>
  ): ReturnType<typeof normalizeAndAccept> => normalizeAndAccept(state, source, payload)

  const publishedState = (
    source: AgentHookSource,
    payload: Record<string, unknown>
  ): string | undefined => publish(source, payload)?.payload.state

  // Why: claude, codex, muse and grok all own their descendant lifecycle — the cases that used
  // to drive the generic lane through grok are upstream's now (providers/grok-events.ts). What
  // is left here is the generic lane's own bookkeeping, driven through its one remaining
  // provider, pi.
  describe('generic descendant roster bookkeeping (pi)', () => {
    const startTurn = (): void => {
      expect(
        publishedState('pi', { hook_event_name: 'before_agent_start', prompt: 'delegate' })
      ).toBe('working')
      expect(publishedState('pi', { hook_event_name: 'agent_start' })).toBe('working')
    }

    it('reaps a child whose finish never arrived instead of pinning the pane forever', () => {
      startTurn()
      publish('pi', {
        hook_event_name: 'subagent_async_state',
        subagent_runs: [{ id: 'run-1', agent_type: 'researcher' }]
      })
      expect(publishedState('pi', { hook_event_name: 'agent_end' })).toBe('working')

      const tracked = state.descendantRosterByPaneKey.get(PANE_KEY)?.get('run-1')
      expect(tracked).toBeDefined()
      // Why: every provider loses a stop hook sometimes (disabled, untrusted, timed out, killed).
      // A claim nothing can retract must not outlive the quiet window.
      tracked!.lastEventAt = Date.now() - AGENT_DESCENDANT_QUIET_REAP_MS - 1

      expect(publishedState('pi', { hook_event_name: 'agent_end' })).toBe('done')
      expect(state.descendantRosterByPaneKey.has(PANE_KEY)).toBe(false)
    })

    it('drops a stale child roster when the pane starts a new agent process', () => {
      startTurn()
      publish('pi', {
        hook_event_name: 'subagent_async_state',
        subagent_runs: [{ id: 'run-1', agent_type: 'researcher' }]
      })
      expect(publishedState('pi', { hook_event_name: 'agent_end' })).toBe('working')

      // Why: a child whose stop hook was lost must not pin the pane forever; a replaced agent
      // process cannot still have the old process's children.
      publish('pi', { hook_event_name: 'session_start' })
      expect(state.descendantRosterByPaneKey.has(PANE_KEY)).toBe(false)
      expect(publishedState('pi', { hook_event_name: 'agent_start' })).toBe('working')
      expect(publishedState('pi', { hook_event_name: 'agent_end' })).toBe('done')
    })
  })

  describe('pi async subagent runs (STA-6378)', () => {
    const startTurn = (): void => {
      expect(
        publishedState('pi', { hook_event_name: 'before_agent_start', prompt: 'delegate' })
      ).toBe('working')
      expect(publishedState('pi', { hook_event_name: 'agent_start' })).toBe('working')
    }

    it('settles the pane when the parent ends with no async children', () => {
      startTurn()
      expect(publishedState('pi', { hook_event_name: 'agent_end' })).toBe('done')
    })

    it('stays working when the parent settles while an async child run continues', () => {
      startTurn()
      const started = publish('pi', {
        hook_event_name: 'subagent_async_state',
        subagent_runs: [{ id: 'run-1', agent_type: 'researcher' }]
      })
      expect(started?.payload.state).toBe('working')
      expect(started?.payload.subagents).toEqual([
        expect.objectContaining({ id: 'run-1', state: 'working', agentType: 'researcher' })
      ])

      expect(publishedState('pi', { hook_event_name: 'agent_end' })).toBe('working')

      const finished = publish('pi', {
        hook_event_name: 'subagent_async_state',
        subagent_runs: []
      })
      expect(finished?.payload.state).toBe('done')
      expect(finished?.payload.subagents).toBeUndefined()
    })

    it('completes once when the final child wakes the parent for another turn', () => {
      startTurn()
      publish('pi', {
        hook_event_name: 'subagent_async_state',
        subagent_runs: [{ id: 'run-1' }, { id: 'run-2' }]
      })

      const states = [
        publishedState('pi', { hook_event_name: 'agent_end' }),
        publishedState('pi', {
          hook_event_name: 'subagent_async_state',
          subagent_runs: [{ id: 'run-2' }]
        }),
        // The last child wakes the parent, which runs another turn before the pane is idle.
        publishedState('pi', { hook_event_name: 'subagent_async_state', subagent_runs: [] }),
        publishedState('pi', { hook_event_name: 'agent_start' }),
        publishedState('pi', { hook_event_name: 'agent_end' })
      ]
      expect(states).toEqual(['working', 'working', 'done', 'working', 'done'])
    })

    it('repairs a dropped intermediate set from the next one', () => {
      startTurn()
      publish('pi', {
        hook_event_name: 'subagent_async_state',
        subagent_runs: [{ id: 'run-1' }, { id: 'run-2' }, { id: 'run-3' }]
      })
      expect(publishedState('pi', { hook_event_name: 'agent_end' })).toBe('working')

      // Why: the extension transport coalesces, so the sets naming run-2 and run-3 as still
      // live can be dropped entirely. The surviving newest message alone must settle the pane.
      expect(
        publishedState('pi', { hook_event_name: 'subagent_async_state', subagent_runs: [] })
      ).toBe('done')
      expect(state.descendantRosterByPaneKey.has(PANE_KEY)).toBe(false)
    })

    it('keeps the parent prompt while an async child reports', () => {
      startTurn()
      const started = publish('pi', {
        hook_event_name: 'subagent_async_state',
        subagent_runs: [{ id: 'run-1' }],
        prompt: 'child task text'
      })
      expect(started?.payload.prompt).toBe('delegate')
      expect(started?.hasExplicitPrompt).toBeUndefined()
    })
  })

  describe('a grok child blocked on a human answer (the one child event grok does not own)', () => {
    // Why: grok auto-allows ask_user_question, so a child's wait arrives as a PreToolUse carrying
    // `subagentType` — the payload shape `providers/grok-events.ts` drops. Without this reader the
    // row would settle `done` over a question nobody has answered.
    const startTurn = (): void => {
      expect(
        publishedState('grok', { hookEventName: 'UserPromptSubmit', prompt: 'delegate' })
      ).toBe('working')
    }

    it('surfaces the wait, and keeps it while the lead turn ends underneath', () => {
      startTurn()
      const asked = publish('grok', {
        hookEventName: 'PreToolUse',
        subagentType: 'x',
        subagentId: 'sub-1',
        toolName: 'ask_user_question',
        toolInput: { question: 'which one?' }
      })
      expect(asked?.payload.state).toBe('waiting')

      expect(publishedState('grok', { hookEventName: 'Stop', reason: 'end_turn' })).toBe('waiting')
    })

    it('leaves every other grok child event to the lane that owns it', () => {
      startTurn()
      // A child's own tool call that asks nothing is not this lane's to publish.
      expect(
        publish('grok', {
          hookEventName: 'PreToolUse',
          subagentType: 'x',
          subagentId: 'sub-1',
          toolName: 'Read'
        })?.payload.state
      ).toBeUndefined()
      // And a child's finish is not a wait: the owning lane decides what it means.
      expect(
        publish('grok', { hookEventName: 'SubagentStop', subagentType: 'x', subagentId: 'sub-1' })
          ?.payload.state
      ).toBeUndefined()
    })
  })

  describe('pane-scoped state bookkeeping', () => {
    it('reports a descendant-only pane as holding a state claim', () => {
      publish('pi', {
        hook_event_name: 'subagent_async_state',
        subagent_runs: [{ id: 'run-1' }]
      })
      expect(paneHasStateClaims(state, PANE_KEY)).toBe(true)

      clearPaneCacheState(state, PANE_KEY)
      expect(state.descendantRosterByPaneKey.has(PANE_KEY)).toBe(false)
      expect(state.descendantLeadStateByPaneKey.has(PANE_KEY)).toBe(false)
    })

    it('does not claim a state for a pane that only cached a lead verdict', () => {
      publish('pi', { hook_event_name: 'agent_start' })
      publish('pi', { hook_event_name: 'agent_end' })
      expect(state.descendantLeadStateByPaneKey.has(PANE_KEY)).toBe(true)
      expect(state.descendantRosterByPaneKey.has(PANE_KEY)).toBe(false)

      // Why: the lead cache only refines a republish an incoming child event already
      // triggered; it never creates a row. With the pane's stored row gone it is the
      // only descendant state left, and it must not read as a live claim on its own.
      deleteLegacyAgentStatus(state, PANE_KEY)
      expect(paneHasStateClaims(state, PANE_KEY)).toBe(false)
    })

    it('moves descendant state with the pane when its key is remapped', () => {
      publish('pi', {
        hook_event_name: 'subagent_async_state',
        subagent_runs: [{ id: 'run-1' }]
      })

      movePaneCacheState(state, PANE_KEY, 'tab-2:22222222-2222-4222-8222-222222222222')
      expect(state.descendantRosterByPaneKey.has(PANE_KEY)).toBe(false)
      expect(
        state.descendantRosterByPaneKey.get('tab-2:22222222-2222-4222-8222-222222222222')?.size
      ).toBe(1)
    })
  })

  describe('the pi live child set riding every post (STA-6378)', () => {
    const CHILD = { id: 'run-1', agent_type: 'researcher', description: 'trace the writer' }

    it('holds the pane for a child only a later event carried', () => {
      // Why: the add a background spawn emits is coalesced away by the tool burst that ends that
      // same spawn — the set riding the next ordinary event is what repairs the swallowed one.
      publish('pi', { hook_event_name: 'tool_execution_end', subagent_runs: [CHILD] })
      expect(publishedState('pi', { hook_event_name: 'agent_end' })).toBe('working')
    })

    it('settles once a later event carries the set back empty', () => {
      publish('pi', { hook_event_name: 'tool_execution_end', subagent_runs: [CHILD] })
      publish('pi', { hook_event_name: 'tool_execution_end', subagent_runs: [] })
      expect(publishedState('pi', { hook_event_name: 'agent_end' })).toBe('done')
    })

    it('ignores an absent set, so a pane without the plugin keeps its own verdict', () => {
      publish('pi', { hook_event_name: 'tool_execution_end' })
      expect(publishedState('pi', { hook_event_name: 'agent_end' })).toBe('done')
    })
  })
})
