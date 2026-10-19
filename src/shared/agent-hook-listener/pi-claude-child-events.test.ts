import { beforeEach, describe, expect, it } from 'vitest'
import { createHookListenerState, type HookListenerState } from './listener-state'
import { findPiClaudeChild } from './pi-claude-child-events'
import { normalizeAndAccept, PANE_KEY } from '../agent-hook-listener-test-harness'

const PARENT_SESSION = {
  session_id: 'pi-parent-session',
  session_file: '/tmp/pi-parent-session.jsonl'
}
const CHILD_CONVERSATION = 'claude-child-conversation'
const CHILD_TRANSCRIPT = '/tmp/claude-projects/project/claude-child-conversation.jsonl'

/** A pi pane that has spawned a claude-backed subagent: the run is live and names the child's own
 *  Claude conversation, exactly as the plugin publishes it on `subagents:session`. */
function publishParentWithClaudeChild(state: HookListenerState, providerSession?: string): void {
  normalizeAndAccept(state, 'pi', {
    hook_event_name: 'before_agent_start',
    prompt: 'delegate to claude',
    ...PARENT_SESSION
  })
  normalizeAndAccept(state, 'pi', {
    hook_event_name: 'tool_execution_start',
    ...PARENT_SESSION,
    subagent_runs: [
      {
        id: 'run-1',
        agent_type: 'general-purpose',
        description: 'review the diff',
        ...(providerSession !== undefined ? { provider_session: providerSession } : {})
      }
    ]
  })
}

function claudeChildEvent(
  hookEventName: string,
  extra: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    hook_event_name: hookEventName,
    session_id: CHILD_CONVERSATION,
    transcript_path: CHILD_TRANSCRIPT,
    cwd: '/tmp/project',
    ...extra
  }
}

describe('a claude CLI child of a pi subagent run', () => {
  let state: HookListenerState

  beforeEach(() => {
    state = createHookListenerState()
    publishParentWithClaudeChild(state, CHILD_CONVERSATION)
  })

  it('is found by its own conversation, and only for this pane', () => {
    expect(findPiClaudeChild(state, PANE_KEY, CHILD_CONVERSATION)).toEqual({
      id: 'run-1',
      providerSession: CHILD_CONVERSATION
    })
    expect(findPiClaudeChild(state, PANE_KEY, 'some-other-conversation')).toBeNull()
    expect(findPiClaudeChild(state, 'tab-1:someone-else', CHILD_CONVERSATION)).toBeNull()
  })

  it('updates its own row with the tool it is running, and never relabels the pane', () => {
    const event = normalizeAndAccept(
      state,
      'claude',
      claudeChildEvent('PreToolUse', {
        tool_name: 'Bash',
        tool_input: { command: 'pnpm test src/main/ai-vault' }
      })
    )

    expect(event?.piClaudeChildParent).toEqual({
      runId: 'run-1',
      providerSession: CHILD_CONVERSATION,
      transcriptPath: CHILD_TRANSCRIPT
    })
    // The row still says pi, and its tool line is still the parent's own.
    expect(event?.payload.agentType).toBe('pi')
    // Why: the server reads a turn edge out of (source, hookEventName), so neither may describe
    // the child — `toolAgentId` is the child marker that path already honours.
    expect(event?.source).toBe('pi')
    expect(event?.hookEventName).toBeUndefined()
    expect(event?.toolAgentId).toBe('run-1')
    expect(event?.payload.state).toBe('working')
    expect(event?.payload.subagents).toEqual([
      expect.objectContaining({
        id: 'run-1',
        agentType: 'general-purpose',
        toolName: 'Bash',
        toolInput: 'pnpm test src/main/ai-vault'
      })
    ])
    // The pane's own resume identity is not the child's conversation.
    expect(event?.providerSession?.id).toBe('pi-parent-session')
    expect(event?.agentPresence).toBeUndefined()
  })

  it('keeps the pane’s owner session on the stored row, so the fence still has an owner', () => {
    const event = normalizeAndAccept(state, 'claude', claudeChildEvent('Stop'))
    const stored = state.lastStatusByPaneKey.get(PANE_KEY)
    expect(stored?.providerSession?.id).toBe('pi-parent-session')
    expect(stored?.payload.agentType).toBe('pi')
    expect(event).not.toBeNull()
  })

  it('keeps the child row while its runner is still wrapping up', () => {
    // Why the row survives its process: the RUN is what pi owns, and the runner session that
    // started it is still posting. Emptying the roster here is what would let those last posts be
    // adopted as the pane's own — and flip its resume identity. The tool line goes; the row stays.
    normalizeAndAccept(
      state,
      'claude',
      claudeChildEvent('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'sleep 1' } })
    )
    const event = normalizeAndAccept(
      state,
      'claude',
      claudeChildEvent('SessionEnd', { reason: 'exit' })
    )
    expect(event?.payload.state).toBe('working')
    expect(event?.payload.subagents).toEqual([expect.objectContaining({ id: 'run-1' })])
    expect(event?.payload.subagents?.[0]?.toolName).toBeUndefined()
  })

  it('keeps the pane’s identity through the runner’s last posts', () => {
    // Why: the child's process exits while the runner session that started it is still wrapping up.
    // If that emptied the roster, the runner's `agent_end` would be adopted as the pane's own —
    // ending its turn and moving its resume identity to a session the user never resumable.
    normalizeAndAccept(state, 'claude', claudeChildEvent('SessionEnd', { reason: 'exit' }))
    expect(
      normalizeAndAccept(state, 'pi', {
        hook_event_name: 'agent_end',
        session_id: 'pi-runner-session',
        session_file: '/tmp/pi-runner-session.jsonl'
      })
    ).toBeNull()
    expect(state.lastStatusByPaneKey.get(PANE_KEY)?.providerSession?.id).toBe('pi-parent-session')
    expect(state.lastStatusByPaneKey.get(PANE_KEY)?.payload.state).toBe('working')
  })

  it('clears the tool line when the child’s call finishes', () => {
    normalizeAndAccept(
      state,
      'claude',
      claudeChildEvent('PreToolUse', {
        tool_name: 'Bash',
        tool_input: { command: 'sleep 1' }
      })
    )
    normalizeAndAccept(state, 'claude', claudeChildEvent('PostToolUse', { tool_name: 'Bash' }))
    const tracked = state.descendantRosterByPaneKey.get(PANE_KEY)?.get('run-1')
    expect(tracked?.toolName).toBeUndefined()
  })

  it('does not read an idle notification as a wait', () => {
    // Why: claude emits `idle_prompt` routinely, and the live set now preserves a waiting state,
    // so a false wait would park the row until the child's next event.
    const event = normalizeAndAccept(
      state,
      'claude',
      claudeChildEvent('Notification', {
        notification_type: 'idle_prompt',
        message: 'Claude is waiting for your input'
      })
    )
    expect(event?.payload.state).toBe('working')
  })

  it('surfaces a blocked prompt as the pane’s actionable state', () => {
    const event = normalizeAndAccept(
      state,
      'claude',
      claudeChildEvent('Notification', {
        notification_type: 'permission_prompt',
        message: 'Claude needs your permission to use Bash'
      })
    )
    expect(event?.payload.state).toBe('waiting')
  })
})

describe('a claude session the pane cannot attribute', () => {
  let state: HookListenerState

  beforeEach(() => {
    state = createHookListenerState()
  })

  it('is not adopted from a run that names no conversation', () => {
    publishParentWithClaudeChild(state)
    expect(findPiClaudeChild(state, PANE_KEY, CHILD_CONVERSATION)).toBeNull()
  })

  it('leaves no parent link to record, so the session list keeps today’s behaviour', () => {
    publishParentWithClaudeChild(state)
    const event = normalizeAndAccept(state, 'claude', claudeChildEvent('PreToolUse'))
    // Whether the row is admitted is the inherited-owner guard's business (it needs a receipt time
    // this harness does not stamp). What matters here is that nothing claims the conversation, so
    // no marker is written and no child row is invented.
    expect(event?.piClaudeChildParent).toBeUndefined()
    expect(state.descendantRosterByPaneKey.get(PANE_KEY)?.has('run-1')).toBe(true)
  })

  it('refuses a child’s own stream once its row has gone, instead of adopting it', () => {
    // Why: hooks can be spooled and the child's process can outlive its row. Without this, the
    // orphaned stream is read as the pane's own agent — and a `SessionEnd` there would end the
    // parent's presence, while a `Stop` would relabel its row.
    publishParentWithClaudeChild(state, CHILD_CONVERSATION)
    // The pi lane retires the run; the pane's roster empties and the child's row goes with it.
    normalizeAndAccept(state, 'pi', {
      hook_event_name: 'tool_execution_end',
      ...PARENT_SESSION,
      subagent_runs: []
    })
    expect(findPiClaudeChild(state, PANE_KEY, CHILD_CONVERSATION)).toBeNull()

    expect(normalizeAndAccept(state, 'claude', claudeChildEvent('SessionEnd'))).toBeNull()
    expect(state.lastStatusByPaneKey.get(PANE_KEY)?.payload.agentType).toBe('pi')
  })
})
