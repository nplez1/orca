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
import { foldMainAgentWithRowChildWork } from './agent-hook-row-child-work-fold'

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

    it('carries the hold across a session switch, and settles when the resumed child ends', () => {
      // A: a turn ends while a child still runs, so the pane is held by that child alone.
      startTurn()
      publish('pi', { hook_event_name: 'subagent_async_state', subagent_runs: [{ id: 'run-1' }] })
      expect(publishedState('pi', { hook_event_name: 'agent_end' })).toBe('working')

      // /new discards A's scope; B has no children of its own, so the pane is idle there — and
      // with no state to publish the session_start stays the identity-only resume record it was.
      const newSession = publish('pi', {
        hook_event_name: 'session_start',
        reason: 'new',
        session_id: 'B',
        session_file: '/sessions/B.jsonl'
      })
      expect(newSession?.payload.state).toBe('done')
      expect(newSession?.providerSessionOnly).toBe(true)

      // Why: the resume is where A's hold comes back — the same post carries A's live child set,
      // and re-publishing the hold is what keeps the pane from showing an idle session instead.
      const resumed = publish('pi', {
        hook_event_name: 'session_start',
        reason: 'resume',
        session_id: 'A',
        session_file: '/sessions/A.jsonl',
        subagent_runs: [{ id: 'run-1', agent_type: 'researcher' }]
      })
      expect(resumed?.payload.state).toBe('working')
      expect(resumed?.payload.subagents).toEqual([
        expect.objectContaining({ id: 'run-1', agentType: 'researcher' })
      ])
      // Why: a hold is state, and an identity-only record would have the receiver discard it — the
      // resume names the same session again, so the record is still published for resuming.
      expect(resumed?.providerSessionOnly).toBeUndefined()
      expect(resumed?.providerSession).toMatchObject({ id: 'A' })
      // Why no boundary: the flag reads "a session start, not a turn end", but this row IS the live
      // hold, and a client without the session-boundary capability drops a flagged tab's status.
      expect(resumed?.payload.sessionBoundary).toBeUndefined()

      // No new turn follows: A's last child ending is the only event left, and it settles the pane
      // because the resume restored the verdict it is gated against.
      expect(
        publishedState('pi', { hook_event_name: 'subagent_async_state', subagent_runs: [] })
      ).toBe('done')
    })

    it('does not invent a working row for an empty live set nobody described', () => {
      // Why: an empty set is not a claim that the pane is working. Defaulting to `working` from it
      // is what strands a pane whose last child leaves — the pane keeps its own verdict instead.
      expect(
        publish('pi', { hook_event_name: 'subagent_async_state', subagent_runs: [] })
      ).toBeNull()
      expect(state.descendantRosterByPaneKey.has(PANE_KEY)).toBe(false)
      expect(state.descendantLeadStateByPaneKey.has(PANE_KEY)).toBe(false)

      // A set that does name a live child still proves the pane is working, and still gates it.
      publish('pi', { hook_event_name: 'subagent_async_state', subagent_runs: [{ id: 'run-1' }] })
      expect(publishedState('pi', { hook_event_name: 'agent_end' })).toBe('working')
      expect(
        publishedState('pi', { hook_event_name: 'subagent_async_state', subagent_runs: [] })
      ).toBe('done')
    })

    it('retracts a hold it published when the child-only set empties with no lead verdict', () => {
      // Why: no event here describes the pane's own turn, so the only reason this pane has a row
      // at all is the hold the live child justified. Publishing nothing for the empty set leaves
      // that hold, and the child it names, in the cache with nothing left that could clear it.
      const started = publish('pi', {
        hook_event_name: 'subagent_async_state',
        subagent_runs: [{ id: 'run-1', agent_type: 'researcher' }]
      })
      expect(started?.payload.state).toBe('working')
      expect(state.lastStatusByPaneKey.has(PANE_KEY)).toBe(true)

      expect(
        publish('pi', { hook_event_name: 'subagent_async_state', subagent_runs: [] })
      ).toBeNull()
      expect(state.descendantRosterByPaneKey.has(PANE_KEY)).toBe(false)
      // Why: the roster was only half of it — the cached row held the child and the state too.
      expect(state.lastStatusByPaneKey.has(PANE_KEY)).toBe(false)
      expect(paneHasStateClaims(state, PANE_KEY)).toBe(false)
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

  // Why: #283. The row's state and the child list it publishes are two surfaces of one session —
  // the sidebar card and the fleet list — and they disagreed because only the `subagent_runs` roster
  // gated the state while the display read the payload's own roster. One roster now decides both.
  describe('one roster decides the row and its children (#283)', () => {
    const CHILD = { id: 'child-1', state: 'working', startedAt: 5, agentType: 'researcher' }
    const RUN = { id: 'run-1', agent_type: 'researcher' }

    const startTurn = (): void => {
      publish('pi', { hook_event_name: 'before_agent_start', prompt: 'delegate' })
      publish('pi', { hook_event_name: 'agent_start' })
    }

    /** The cross-surface contract, in the direction that matters: a row must never read `done`
     *  while the child list it publishes holds live work, and re-folding that list into the row's own
     *  state must reproduce it — so no surface can read the row and its children differently. */
    const expectRowAgreesWithChildren = (row: ReturnType<typeof publish>): void => {
      expect(row).not.toBeNull()
      // Why only `idle`: a snapshot has no `done` — every other state is a live claim.
      const live = (row!.payload.subagents ?? []).filter((child) => child.state !== 'idle')
      if (live.length > 0) {
        expect(row!.payload.state).not.toBe('done')
      }
      expect(
        foldMainAgentWithRowChildWork(row!.payload.state, { payload: row!.payload }).stateName
      ).toBe(row!.payload.state)
    }

    it('holds the pane for a child only the payload roster names', () => {
      startTurn()
      const ended = publish('pi', { hook_event_name: 'agent_end', subagents: [CHILD] })
      expect(ended?.payload.state).toBe('working')
      expect(ended?.payload.subagents).toEqual([expect.objectContaining({ id: 'child-1' })])
      expectRowAgreesWithChildren(ended)
    })

    it('holds the pane for a child a restated row names', () => {
      startTurn()
      expect(publishedState('pi', { hook_event_name: 'agent_end' })).toBe('done')
      for (const hook_event_name of ['model_select', 'subagents_update']) {
        const restated = publish('pi', {
          hook_event_name,
          ...(hook_event_name === 'model_select' ? { model: 'x/y' } : {}),
          subagents: [CHILD]
        })
        expect(restated?.payload.state).toBe('working')
        expectRowAgreesWithChildren(restated)
        expect(publishedState('pi', { hook_event_name: 'agent_end' })).toBe('done')
      }
    })

    it('settles a restated row once its children are gone, keeping the lead verdict', () => {
      startTurn()
      publish('pi', { hook_event_name: 'agent_end' })
      publish('pi', { hook_event_name: 'subagents_update', subagents: [CHILD] })

      // Why: the restate carries the gated `working`, not the lead's own verdict. Recording it as
      // the verdict would pin the pane working with nothing left to correct it.
      expect(publishedState('pi', { hook_event_name: 'subagents_update' })).toBe('done')
      expect(state.descendantLeadStateByPaneKey.get(PANE_KEY)).toBe('done')
    })

    it('settles after an async hold and a restate drain it', () => {
      startTurn()
      publish('pi', { hook_event_name: 'subagent_async_state', subagent_runs: [RUN] })
      expect(publishedState('pi', { hook_event_name: 'agent_end' })).toBe('working')
      publish('pi', { hook_event_name: 'model_select', model: 'x/y' })
      const drained = publish('pi', { hook_event_name: 'subagent_async_state', subagent_runs: [] })
      expect(drained?.payload.state).toBe('done')
    })

    it('publishes both rosters, and keeps the reported one when the async set drains', () => {
      startTurn()
      publish('pi', { hook_event_name: 'subagent_async_state', subagent_runs: [RUN] })
      const both = publish('pi', { hook_event_name: 'subagents_update', subagents: [CHILD] })
      expect(both?.payload.state).toBe('working')
      expect(both?.payload.subagents?.map((child) => child.id)).toEqual(['child-1', 'run-1'])

      // Why: an async child finishing is not evidence the pane's own child finished. The display
      // must not lose a running child because the other roster drained. The extension merges its own
      // roster into every post, so this drain carries one — exactly the shape the wire produces.
      const drained = publish('pi', {
        hook_event_name: 'subagent_async_state',
        subagent_runs: [],
        subagents: [CHILD]
      })
      expect(drained?.payload.state).toBe('working')
      expect(drained?.payload.subagents?.map((child) => child.id)).toEqual(['child-1'])
      expect(publishedState('pi', { hook_event_name: 'agent_end', subagents: [CHILD] })).toBe(
        'working'
      )
    })

    it('settles once the pane’s own lane reports no children left', () => {
      startTurn()
      publish('pi', { hook_event_name: 'subagents_update', subagents: [CHILD] })
      expect(publishedState('pi', { hook_event_name: 'agent_end', subagents: [CHILD] })).toBe(
        'working'
      )
      // Why: on a pi post an absent roster is the pane's own lane saying it has none — not an
      // opinion to carry forward, which would pin the pane on a child that has finished.
      expect(publishedState('pi', { hook_event_name: 'agent_end' })).toBe('done')
    })

    it('lists a child both rosters name once, with the roster entry', () => {
      startTurn()
      publish('pi', {
        hook_event_name: 'subagent_async_state',
        subagent_runs: [{ id: 'child-1', agent_type: 'researcher' }]
      })
      const row = publish('pi', {
        hook_event_name: 'subagents_update',
        subagents: [{ id: 'child-1', state: 'working', startedAt: 5 }]
      })
      expect(row?.payload.subagents).toEqual([expect.objectContaining({ id: 'child-1' })])
      expect(row?.payload.state).toBe('working')
    })

    it('settles a pane whose published children have all finished', () => {
      startTurn()
      const ended = publish('pi', {
        hook_event_name: 'agent_end',
        subagents: [{ id: 'child-1', state: 'idle', startedAt: 5 }]
      })
      expect(ended?.payload.state).toBe('done')
      expect(ended?.payload.subagents?.map((child) => child.state)).toEqual(['idle'])
    })

    it('leaves a pane with no children exactly as its provider described it', () => {
      startTurn()
      const ended = publish('pi', { hook_event_name: 'agent_end' })
      expect(ended?.payload.state).toBe('done')
      expect(ended?.payload.subagents).toBeUndefined()
    })

    it('never flags a session boundary or a monitor badge on a row it held open', () => {
      startTurn()
      const ended = publish('pi', {
        hook_event_name: 'agent_end',
        session_boundary: true,
        subagents: [CHILD]
      })
      expect(ended?.payload.state).toBe('working')
      expect(ended?.payload.sessionBoundary).toBeUndefined()
      expect(ended?.payload.workingMode).toBeUndefined()
    })

    it('drops the reported roster when the async lane carries none', () => {
      startTurn()
      const both = publish('pi', {
        hook_event_name: 'subagent_async_state',
        subagent_runs: [RUN],
        subagents: [CHILD]
      })
      expect(both?.payload.subagents?.map((child) => child.id)).toEqual(['child-1', 'run-1'])

      // Why: on a pi post the field's absence is the pane's own lane saying it has none. Reading it
      // as "no opinion" would carry a dropped child forward and hold the row on a finished child.
      const drained = publish('pi', {
        hook_event_name: 'subagent_async_state',
        subagent_runs: []
      })
      expect(drained?.payload.subagents).toBeUndefined()
    })

    it('fills a shared child id with the label only the reporting lane carries', () => {
      startTurn()
      publish('pi', {
        hook_event_name: 'subagent_async_state',
        subagent_runs: [{ id: 'child-1', agent_type: 'researcher' }]
      })
      const row = publish('pi', {
        hook_event_name: 'subagents_update',
        subagents: [{ id: 'child-1', state: 'working', startedAt: 5, description: 'trace it' }]
      })
      expect(row?.payload.subagents).toEqual([
        expect.objectContaining({ id: 'child-1', agentType: 'researcher', description: 'trace it' })
      ])
    })

    it('holds an omp or prime-agent pane by the same fold', () => {
      publish('omp', { hook_event_name: 'before_agent_start', prompt: 'delegate' })
      expect(publishedState('omp', { hook_event_name: 'agent_end', subagents: [CHILD] })).toBe(
        'working'
      )

      publish('prime-agent', { hook_event_name: 'before_agent_start', prompt: 'delegate' })
      publish('prime-agent', { hook_event_name: 'agent_end' })
      expect(
        publishedState('prime-agent', { hook_event_name: 'subagents_update', subagents: [CHILD] })
      ).toBe('working')
      expect(publishedState('prime-agent', { hook_event_name: 'subagents_update' })).toBe('done')
    })

    it('keeps an omp approval hold blocked when a child appears under it', () => {
      publish('omp', { hook_event_name: 'before_agent_start', prompt: 'delegate' })
      publish('omp', { hook_event_name: 'tool_approval_requested', tool_name: 'Bash' })
      expect(state.lastStatusByPaneKey.get(PANE_KEY)?.payload.state).toBe('blocked')

      // Why: the approval hold reads the cached row, so a fold that turned `blocked` into `working`
      // would release the hold as a side effect of holding the row open for a child.
      const held = publish('omp', { hook_event_name: 'subagents_update', subagents: [CHILD] })
      expect(held?.payload.state).toBe('blocked')
      expect(held?.payload.subagents?.map((child) => child.id)).toEqual(['child-1'])
    })

    it('forgets the reported roster when the pane starts a new agent process', () => {
      startTurn()
      publish('pi', { hook_event_name: 'subagents_update', subagents: [CHILD] })
      expect(state.reportedSubagentsByPaneKey.has(PANE_KEY)).toBe(true)

      publish('pi', { hook_event_name: 'session_start' })
      expect(state.reportedSubagentsByPaneKey.has(PANE_KEY)).toBe(false)
      expect(publishedState('pi', { hook_event_name: 'agent_end' })).toBe('done')
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
